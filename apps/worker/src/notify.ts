/**
 * The notification cycle: decide (planDispatch / planEscalation, pure, in @mercer/core), record
 * in the notifications outbox, then send. Each pass is idempotent: the dispatcher compares every
 * incident with what was already announced, so a missed trigger is caught by the next tick.
 */
import {
  errorMessage,
  isHarvest,
  isWithinHours,
  onCallAt,
  planDispatch,
  planEscalation,
  quietHoursActive,
  rotationWeekStart,
  siteHours,
  teamsNotice,
  type AppConfig,
  type BusinessHours,
  type ChannelInfo,
  type DispatchContext,
  type Logger,
  type Person,
  type PlannedMessage,
  type PushoverPayload,
  type RoutingRule,
  type SeasonPeriod,
  type SecretBox,
  type SmsPayload,
  type TeamsPayload,
} from '@mercer/core';
import {
  claimNotification,
  claimOutbox,
  countPendingTransitions,
  dueEscalations,
  ensureShortLink,
  finishEscalation,
  getNotification,
  listNotifierHealth,
  listPollerStates,
  listOncallWeeks,
  listPeople,
  listRoutingRules,
  listSeasons,
  loadChannelSecrets,
  loadDispatchCandidates,
  loadIncidentForNotify,
  loadNotifyState,
  lockNotify,
  markNotificationFailed,
  markNotificationSent,
  markNotifierAlerted,
  outboxStats,
  overridesBetween,
  persistDispatch,
  recentPageCounts,
  recordMessages,
  recordNotifierResult,
  recordStandalone,
  saveNotifyState,
  suppressNotification,
  toNotifyIncident,
  toNotifyState,
  type Db,
  type NotificationRow,
} from '@mercer/db';
import {
  NotifyError,
  PushoverNotifier,
  TeamsWorkflowsNotifier,
  TwilioNotifier,
} from '@mercer/notify';

export const NOTIFY_QUEUE = 'notify.run';
export const NOTIFY_TICK_SEC = 15;
export const SELFCHECK_QUEUE = 'maint.selfcheck';

const DEFAULT_HOURS: BusinessHours = { days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' };
const RATE_WINDOW_MS = 15 * 60_000;
const SELF_ALERT_EVERY_MS = 3600_000;

export interface NotifyDeps {
  cfg: AppConfig;
  db: Db;
  box: SecretBox;
  log: Logger;
  now: () => Date;
}

export interface NotifySummary {
  dispatched: number;
  planned: number;
  escalations: number;
  sent: number;
  failed: number;
  retrying: number;
}

type Shared = Omit<DispatchContext, 'withinBusinessHours' | 'links'> & {
  hoursFor: (site: Parameters<typeof siteHours>[0] | null) => boolean;
};

async function sharedContext(d: NotifyDeps, now: Date): Promise<Shared> {
  const { cfg, db, box } = d;
  const tz = cfg.timezone;
  const [ruleRows, channelSecrets, peopleRows, seasons] = await Promise.all([
    listRoutingRules(db),
    loadChannelSecrets(db, box),
    listPeople(db),
    listSeasons(db),
  ]);
  const weekStart = rotationWeekStart(now, cfg.notify.handoff, tz);
  const [weeks, overrides, recentPages] = await Promise.all([
    listOncallWeeks(db, weekStart),
    overridesBetween(db, now, now),
    recentPageCounts(db, new Date(now.getTime() - RATE_WINDOW_MS)),
  ]);
  const people: Person[] = peopleRows.map((p) => ({
    id: p.id,
    name: p.name,
    phoneE164: p.phoneE164,
    pushoverUserKey: p.pushoverUserKey,
    pageVia: p.pageVia,
    isItLead: p.isItLead,
    active: p.active,
    rotationPosition: p.rotationPosition,
  }));
  const chain = onCallAt(now, {
    people,
    weeks: weeks.map((w) => ({
      weekStart: w.weekStart,
      primaryPersonId: w.primaryPersonId,
      secondaryPersonId: w.secondaryPersonId,
    })),
    overrides,
    handoff: cfg.notify.handoff,
    timezone: tz,
  });
  const harvest = isHarvest(seasons as unknown as SeasonPeriod[], now, tz);
  const channels = new Map<string, ChannelInfo>(
    [...channelSecrets].map(([key, c]) => [
      key,
      { key, name: c.name, enabled: c.enabled, configured: !!c.url },
    ]),
  );
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
  return {
    now,
    rules: ruleRows.map((r): RoutingRule => ({
      id: r.id,
      name: r.name,
      position: r.position,
      enabled: r.enabled,
      match: r.match,
      channelKey: r.channelKey,
      pageOncall: r.pageOncall,
      escalateAfterMin: r.escalateAfterMin,
      stop: r.stop,
    })),
    channels,
    people: new Map(people.map((p) => [p.id, p])),
    chain,
    quietActive: quietHoursActive(now, cfg.notify.quiet.window, tz),
    quietMinPriority: cfg.notify.quiet.minPriority,
    shadow: cfg.notify.shadow,
    defaultEscalateAfterMin: cfg.notify.escalateAfterMin,
    recentPages,
    pageRateLimit: cfg.notify.pageRateLimit,
    providers: { sms: !!cfg.notify.twilio, pushover: !!cfg.notify.pushover },
    formatTime: (t) => timeFmt.format(t),
    postAiSummary: cfg.ai.postSummaryUpdate,
    hoursFor: (site) => isWithinHours(now, site ? siteHours(site, harvest) : DEFAULT_HOURS, tz),
  };
}

function links(cfg: AppConfig, incidentId: number, code: string) {
  const base = `${cfg.baseUrl}/incidents/${incidentId}`;
  return {
    view: base,
    ack: `${base}?do=ack`,
    snooze: `${base}?do=snooze`,
    short: `${cfg.baseUrl}/i/${code}`,
  };
}

/** Count pages planned in this pass, so the rate limit holds across incidents. */
function countPages(recent: Map<number, number>, msgs: PlannedMessage[]) {
  for (const m of msgs)
    if (m.personId !== null && m.kind !== 'teams' && m.suppressReason === null)
      recent.set(m.personId, (recent.get(m.personId) ?? 0) + 1);
}

async function dispatch(d: NotifyDeps, now: Date): Promise<{ incidents: number; planned: number }> {
  return d.db.transaction(async (tx) => {
    await lockNotify(tx);
    const candidates = await loadDispatchCandidates(tx, now);
    if (!candidates.length) return { incidents: 0, planned: 0 };
    const shared = await sharedContext(d, now);
    const recent = new Map(shared.recentPages);
    let planned = 0;
    for (const c of candidates) {
      const inc = toNotifyIncident(c.incident, c.site?.name ?? null, c.divisionNames);
      const code = inc.seeded ? 'pending' : await ensureShortLink(tx, inc.id, now);
      const ctx: DispatchContext = {
        ...shared,
        recentPages: recent,
        withinBusinessHours: shared.hoursFor(c.site),
        links: links(d.cfg, inc.id, code),
      };
      const plan = planDispatch(inc, c.state ? toNotifyState(c.state) : null, ctx);
      const afterMin = plan.scheduleEscalations[0]
        ? Math.round((plan.scheduleEscalations[0].dueAt.getTime() - now.getTime()) / 60_000)
        : d.cfg.notify.escalateAfterMin;
      await persistDispatch(tx, inc.id, plan, afterMin, now);
      countPages(recent, plan.messages);
      planned += plan.messages.length;
    }
    return { incidents: candidates.length, planned };
  });
}

async function fireEscalations(d: NotifyDeps, now: Date): Promise<number> {
  const due = await dueEscalations(d.db, now);
  if (!due.length) return 0;
  let fired = 0;
  const shared = await sharedContext(d, now);
  for (const e of due) {
    await d.db.transaction(async (tx) => {
      await lockNotify(tx);
      const detail = await loadIncidentForNotify(tx, e.incidentId);
      const prev = await loadNotifyState(tx, e.incidentId);
      if (!detail || !prev) {
        await finishEscalation(tx, e.id, now, 'gone');
        return;
      }
      const inc = toNotifyIncident(
        detail.incident,
        detail.site?.name ?? null,
        detail.divisionNames,
      );
      const code = await ensureShortLink(tx, inc.id, now);
      const plan = planEscalation(
        inc,
        prev,
        e.level,
        {
          ...shared,
          withinBusinessHours: shared.hoursFor(detail.site),
          links: links(d.cfg, inc.id, code),
        },
        e.afterMin,
      );
      if (plan.cancelReason) {
        await finishEscalation(tx, e.id, now, plan.cancelReason);
        return;
      }
      await recordMessages(tx, inc.id, plan.messages, now);
      await saveNotifyState(tx, inc.id, plan.state, now);
      await finishEscalation(tx, e.id, now, null);
      fired++;
    });
  }
  return fired;
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export interface Senders {
  teams: TeamsWorkflowsNotifier;
  twilio: TwilioNotifier | null;
  pushover: PushoverNotifier | null;
}

export function buildSenders(cfg: AppConfig): Senders {
  return {
    teams: new TeamsWorkflowsNotifier({ allowHttp: cfg.notify.allowHttp }),
    twilio: cfg.notify.twilio ? new TwilioNotifier(cfg.notify.twilio) : null,
    pushover: cfg.notify.pushover ? new PushoverNotifier(cfg.notify.pushover) : null,
  };
}

const healthKey = (row: Pick<NotificationRow, 'kind' | 'channelKey'>) =>
  row.kind === 'teams' ? `teams:${row.channelKey}` : row.kind === 'sms' ? 'twilio' : 'pushover';

/** Deliver one claimed outbox row. Contacts are read now, so a corrected number takes effect. */
async function deliver(
  d: NotifyDeps,
  row: NotificationRow,
  senders: Senders,
  secrets: Awaited<ReturnType<typeof loadChannelSecrets>>,
  people: Map<number, { phoneE164: string | null; pushoverUserKey: string | null }>,
  now: Date,
): Promise<'sent' | 'retry' | 'failed' | 'suppressed'> {
  let target: string | null = null;
  let send: (() => Promise<{ providerRef: string | null; threadRef: string | null }>) | null = null;
  if (row.kind === 'teams') {
    const ch = row.channelKey ? secrets.get(row.channelKey) : undefined;
    target = ch?.url ?? null;
    if (target) send = () => senders.teams.send(target!, row.payload as TeamsPayload);
  } else {
    const p = row.personId !== null ? people.get(row.personId) : undefined;
    if (row.kind === 'sms') {
      target = p?.phoneE164 ?? null;
      if (target && senders.twilio)
        send = () => senders.twilio!.send(target!, row.payload as SmsPayload);
    } else {
      target = p?.pushoverUserKey ?? null;
      if (target && senders.pushover)
        send = () => senders.pushover!.send(target!, row.payload as PushoverPayload);
    }
  }
  if (!send) {
    // Configuration changed after the message was planned.
    await suppressNotification(
      d.db,
      row.id,
      target
        ? 'provider_not_configured'
        : row.kind === 'teams'
          ? 'channel_not_configured'
          : 'no_contact',
      now,
    );
    return 'suppressed';
  }
  try {
    const ref = await send();
    await markNotificationSent(d.db, row.id, now, ref);
    await recordNotifierResult(d.db, healthKey(row), now, null);
    return 'sent';
  } catch (err) {
    const retryable = err instanceof NotifyError ? err.retryable : true;
    const msg = errorMessage(err);
    const outcome = await markNotificationFailed(d.db, row, now, msg, retryable);
    await recordNotifierResult(d.db, healthKey(row), now, msg);
    d.log.warn({ notification: row.id, kind: row.kind, err: msg, outcome }, 'notification failed');
    return outcome;
  }
}

async function sendOutbox(d: NotifyDeps, now: Date) {
  const out = { sent: 0, failed: 0, retrying: 0 };
  const senders = buildSenders(d.cfg);
  let secrets: Awaited<ReturnType<typeof loadChannelSecrets>> | null = null;
  let people: Map<number, { phoneE164: string | null; pushoverUserKey: string | null }> | null =
    null;
  for (let batch = 0; batch < 10; batch++) {
    const rows = await claimOutbox(d.db, now);
    if (!rows.length) break;
    secrets ??= await loadChannelSecrets(d.db, d.box);
    people ??= new Map((await listPeople(d.db)).map((p) => [p.id, p]));
    for (const row of rows) {
      const r = await deliver(d, row, senders, secrets, people, now);
      if (r === 'sent') out.sent++;
      else if (r === 'failed') out.failed++;
      else if (r === 'retry') out.retrying++;
    }
  }
  return out;
}

/** One full pass: dispatch, due escalations, then send whatever is due in the outbox. */
export async function runNotifyCycle(d: NotifyDeps): Promise<NotifySummary> {
  const now = d.now();
  const dis = await dispatch(d, now);
  const escalationsFired = await fireEscalations(d, now);
  const sent = await sendOutbox(d, now);
  const summary: NotifySummary = {
    dispatched: dis.incidents,
    planned: dis.planned,
    escalations: escalationsFired,
    ...sent,
  };
  if (dis.planned || escalationsFired || sent.sent || sent.failed)
    d.log.info(summary, 'notification cycle');
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Self-check: MAS alerts on itself
// ---------------------------------------------------------------------------------------------

/**
 * Failing notifiers, an overdue outbox and a correlation backlog are posted to the self-alert
 * channel (or, if that is the one failing, any other working channel), at most hourly each.
 */
export async function runSelfCheck(d: NotifyDeps): Promise<string[]> {
  const now = d.now();
  const raised: string[] = [];
  const health = await listNotifierHealth(d.db);
  const secrets = await loadChannelSecrets(d.db, d.box);
  const problems: Array<{ key: string; title: string; detail: string }> = [];
  for (const h of health)
    if (h.consecutiveFailures >= 3)
      problems.push({
        key: h.key,
        title: `MAS: notifications via ${h.key.replace('teams:', '#')} are failing`,
        detail: `${h.consecutiveFailures} failures in a row. Last error: ${h.lastError ?? 'unknown'}. Check Settings → Notifications.`,
      });
  const outbox = await outboxStats(d.db, now);
  if (outbox.overdue > 0)
    problems.push({
      key: 'outbox',
      title: 'MAS: notifications are overdue',
      detail: `${outbox.overdue} notification(s) have waited more than 5 minutes to be sent.`,
    });
  const backlog = await countPendingTransitions(d.db);
  if (backlog > 5000)
    problems.push({
      key: 'correlation-backlog',
      title: 'MAS: correlation is falling behind',
      detail: `${backlog} Orion state changes are waiting to be correlated.`,
    });
  // One poller failing while the others work (a query Orion rejects, a timeout on a big table).
  // When they all fail, SolarWinds itself is down and that is already a P1 incident.
  const pollers = await listPollerStates(d.db);
  const failing = pollers.filter((p) => p.consecutiveFailures >= 5);
  if (failing.length && failing.length < pollers.length)
    for (const p of failing)
      problems.push({
        key: `poller:${p.poller}`,
        title: `MAS: the ${p.poller} poller keeps failing`,
        detail: `${p.consecutiveFailures} failures in a row. Last error: ${p.lastError?.slice(0, 200) ?? 'unknown'}.`,
      });
  if (!problems.length) return raised;

  const byKey = new Map(health.map((h) => [h.key, h]));
  const usable = (key: string) => {
    const c = secrets.get(key);
    return !!c?.url && c.enabled && (byKey.get(`teams:${key}`)?.consecutiveFailures ?? 0) < 3;
  };
  for (const p of problems) {
    const last = byKey.get(p.key)?.lastAlertedAt;
    if (last && now.getTime() - last.getTime() < SELF_ALERT_EVERY_MS) continue;
    const preferred = d.cfg.notify.shadow.enabled
      ? d.cfg.notify.shadow.channelKey
      : d.cfg.notify.selfAlertChannel;
    const channel = [preferred, ...secrets.keys()].find((k) => `teams:${k}` !== p.key && usable(k));
    if (!channel) {
      d.log.error({ problem: p.key, detail: p.detail }, 'self-alert: no working Teams channel');
      continue;
    }
    await recordStandalone(
      d.db,
      {
        purpose: 'self_alert',
        kind: 'teams',
        channelKey: channel,
        personId: null,
        recipient: `#${channel}`,
        payload: teamsNotice(p.title, p.detail, d.cfg.baseUrl),
        suppressReason: null,
        shadow: d.cfg.notify.shadow.enabled,
      },
      now,
    );
    if (!byKey.has(p.key)) await recordNotifierResult(d.db, p.key, now, p.detail);
    await markNotifierAlerted(d.db, p.key, now);
    raised.push(p.key);
    d.log.warn({ problem: p.key, channel }, 'self-alert raised');
  }
  return raised;
}

// ---------------------------------------------------------------------------------------------
// Test-send (Settings → Notifications), run on behalf of the web app
// ---------------------------------------------------------------------------------------------

export type TestTarget =
  { kind: 'teams'; channelKey: string } | { kind: 'sms' | 'pushover'; personId: number };

/**
 * Send a test message straight away (not redirected by shadow mode: the admin asked for this
 * exact target) and record it like any other notification.
 */
export async function runTestSend(
  d: NotifyDeps,
  target: TestTarget,
  by: string,
): Promise<{ ok: boolean; message: string }> {
  const now = d.now();
  const title = 'MercerAlertService test message';
  const detail = `Sent by ${by} from Settings → Notifications. If you can read this, delivery works.`;
  let m: PlannedMessage;
  if (target.kind === 'teams') {
    m = {
      purpose: 'test',
      kind: 'teams',
      channelKey: target.channelKey,
      personId: null,
      recipient: `#${target.channelKey}`,
      payload: teamsNotice(title, detail, d.cfg.baseUrl),
      suppressReason: null,
      shadow: false,
    };
  } else {
    const person = (await listPeople(d.db)).find((p) => p.id === target.personId);
    if (!person) return { ok: false, message: 'That person no longer exists.' };
    m = {
      purpose: 'test',
      kind: target.kind,
      channelKey: null,
      personId: person.id,
      recipient: `${person.name} (${target.kind === 'sms' ? 'SMS' : 'Pushover'})`,
      payload:
        target.kind === 'sms'
          ? { body: `${title}: paging works. [MAS]` }
          : { title, message: detail, url: d.cfg.baseUrl, url_title: 'Open MAS', priority: 0 },
      suppressReason: null,
      shadow: false,
    };
  }
  const id = await recordStandalone(d.db, m, now);
  const claimed = await claimNotification(d.db, id, now);
  if (!claimed) return { ok: false, message: 'The test message could not be queued.' };
  const secrets = await loadChannelSecrets(d.db, d.box);
  const people = new Map((await listPeople(d.db)).map((p) => [p.id, p]));
  const outcome = await deliver(d, claimed, buildSenders(d.cfg), secrets, people, now);
  if (outcome === 'sent') return { ok: true, message: `Sent to ${m.recipient}.` };
  const row = await getNotification(d.db, id);
  const why = row?.lastError ?? row?.suppressReason ?? outcome;
  return {
    ok: false,
    message:
      why === 'channel_not_configured'
        ? 'This channel has no webhook URL yet.'
        : why === 'no_contact'
          ? 'This person has no number or Pushover key for that method.'
          : why === 'provider_not_configured'
            ? `${target.kind === 'sms' ? 'Twilio' : 'Pushover'} is not set up yet.`
            : `Delivery failed: ${why}`,
  };
}
