/**
 * The AI jobs. They only ever enrich: an incident and its templated notifications exist before
 * any of this runs, and every failure leaves the template in place.
 *
 * - ai.incident.summary: per incident, debounced (stately queue, one queued job per incident,
 *   started AI_SUMMARY_DEBOUNCE_SEC after the first trigger), on open and on material change.
 * - ai.digest.daily / ai.digest.weekly: cron in APP_TIMEZONE, posted to the digest channel.
 */
import {
  AiRunner,
  summarizeIncident,
  suggestPriority,
  testAi,
  writeDigest,
  type AiCallRecord,
} from '@mercer/ai';
import {
  addZonedDays,
  decideAiPriority,
  digestCard,
  digestMarkdown,
  digestTitle,
  errorMessage,
  shiftZonedDays,
  stablePrefix,
  startOfZonedDay,
  teamsNotice,
  templateDigest,
  type AiTestResult,
  type AppConfig,
  type BudgetState,
  type DigestContent,
  type DigestRunResult,
  type Logger,
  type SecretBox,
  type StoredAiSummary,
} from '@mercer/core';
import {
  aiSpendSince,
  applyAiEnrichment,
  dailyDigestFacts,
  dueAiIncidents,
  findDigest,
  linkDigestNotification,
  listNotifierHealth,
  loadAiIncidentSnapshot,
  loadChannelSecrets,
  loadSiteProfiles,
  markNotifierAlerted,
  recordAiCall,
  recordAiDeferral,
  recordNotifierResult,
  recordStandalone,
  saveDigest,
  weeklyDigestFacts,
  type Db,
} from '@mercer/db';

export const AI_SUMMARY_QUEUE = 'ai.incident.summary';
/** How often the worker looks for incidents whose summary is missing or stale. */
export const AI_SWEEP_SEC = 30;

export interface AiDeps {
  cfg: AppConfig;
  db: Db;
  box: SecretBox;
  log: Logger;
  now: () => Date;
  /** Injected by tests; otherwise built from cfg.ai for each job. */
  runner?: AiRunner;
}

export function aiRunner(d: AiDeps): AiRunner {
  return (
    d.runner ??
    new AiRunner({
      cfg: d.cfg.ai,
      timeZone: d.cfg.timezone,
      log: d.log,
      now: d.now,
      store: {
        spendSince: (since) => aiSpendSince(d.db, since),
        record: (row: AiCallRecord) => recordAiCall(d.db, row),
      },
    })
  );
}

/** Incidents that need the AI now (the worker sends one debounced job for each). */
export async function dueSummaries(d: AiDeps): Promise<number[]> {
  if (!d.cfg.ai.enabled) return [];
  return dueAiIncidents(d.db, d.now());
}

export interface IncidentAiResult {
  incidentId: number;
  outcome: 'written' | 'deferred' | 'gave_up' | 'skipped';
  summary?: string;
  priority?: { suggested: number; applied: number | null; changed: string | null };
}

/** Summarize one incident and get the priority second opinion. Never throws for AI problems. */
export async function runIncidentAi(d: AiDeps, incidentId: number): Promise<IncidentAiResult> {
  const now = d.now();
  const cfg = d.cfg.ai;
  if (!cfg.enabled) return { incidentId, outcome: 'skipped' };
  const snap = await loadAiIncidentSnapshot(d.db, incidentId, now, d.cfg.timezone);
  if (!snap || snap.seeded) return { incidentId, outcome: 'skipped' };
  if (snap.handledRev !== null && snap.handledRev >= snap.materialRev)
    return { incidentId, outcome: 'skipped' };

  const runner = aiRunner(d);
  const prefix = stablePrefix(cfg.environmentNotes, await loadSiteProfiles(d.db));
  const input = { incidentId, context: snap.context, previous: snap.previous, prefix };
  const open = snap.status === 'open' || snap.status === 'acknowledged';

  const sev = cfg.priorityMode !== 'off' && open ? await suggestPriority(runner, cfg, input) : null;
  const sum = await summarizeIncident(runner, cfg, input);
  await budgetAlerts(d, sum.budget);

  if (!sum.ok && sum.transient) {
    // API down, timeout, rate limit or budget spent: keep the template and try again later.
    const retryAt =
      sum.status === 'budget_blocked'
        ? addZonedDays(startOfZonedDay(now, d.cfg.timezone), 1, d.cfg.timezone)
        : undefined;
    const r = await recordAiDeferral(
      d.db,
      incidentId,
      snap.materialRev,
      sum.status === 'budget_blocked' ? 'budget_blocked' : 'error',
      now,
      retryAt,
    );
    return { incidentId, outcome: r.gaveUp ? 'gave_up' : 'deferred', summary: sum.status };
  }

  const summary: StoredAiSummary | null = sum.ok
    ? {
        ...sum.data,
        model: sum.model,
        generatedAt: now.toISOString(),
        forMaterialRev: snap.materialRev,
        redacted: cfg.redact,
      }
    : null;
  const decision =
    sev?.ok && cfg.priorityMode !== 'off'
      ? {
          decision: decideAiPriority(cfg.priorityMode, sev.data.adjust, {
            kind: snap.kind,
            basePriority: snap.basePriority,
            firewallDown: snap.firewallDown,
            harvestCriticalInHarvest: snap.harvestCriticalInHarvest,
          }),
          reason: sev.data.reason,
          mode: cfg.priorityMode,
        }
      : null;
  const w = await applyAiEnrichment(
    d.db,
    incidentId,
    {
      materialRev: snap.materialRev,
      kind: snap.kind,
      basePriority: snap.basePriority,
      summary,
      priority: decision,
      status: sum.ok
        ? 'ok'
        : sum.status === 'refused'
          ? 'refused'
          : sum.status === 'error'
            ? 'error'
            : 'fallback',
    },
    d.now(),
  );
  const changed = w.priorityChanged ? `${w.priorityChanged.from}→${w.priorityChanged.to}` : null;
  d.log.info(
    { incidentId, summary: sum.status, priority: decision?.decision.priority, changed },
    'incident AI done',
  );
  return {
    incidentId,
    outcome: 'written',
    summary: sum.status,
    priority: decision
      ? {
          suggested: decision.decision.suggested,
          applied: decision.decision.applied,
          changed,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Budget alerts: once per day at 80 % and once at 100 %, to the self-alert channel
// ---------------------------------------------------------------------------------------------

async function postNotice(d: AiDeps, title: string, detail: string, key: string): Promise<void> {
  const now = d.now();
  const health = await listNotifierHealth(d.db);
  const last = health.find((h) => h.key === key)?.lastAlertedAt;
  if (last && last >= startOfZonedDay(now, d.cfg.timezone)) return;
  const channel = d.cfg.notify.shadow.enabled
    ? d.cfg.notify.shadow.channelKey
    : d.cfg.notify.selfAlertChannel;
  const secrets = await loadChannelSecrets(d.db, d.box);
  const c = secrets.get(channel);
  await recordStandalone(
    d.db,
    {
      purpose: 'self_alert',
      kind: 'teams',
      channelKey: channel,
      personId: null,
      recipient: `#${channel}`,
      payload: teamsNotice(title, detail, `${d.cfg.baseUrl}/settings/ai`),
      suppressReason: !c?.url ? 'channel_not_configured' : !c.enabled ? 'channel_disabled' : null,
      shadow: d.cfg.notify.shadow.enabled,
    },
    now,
  );
  await recordNotifierResult(d.db, key, now, null);
  await markNotifierAlerted(d.db, key, now);
  d.log.warn({ key, channel }, title);
}

export async function budgetAlerts(d: AiDeps, b: BudgetState): Promise<void> {
  if (b.level === 'ok') return;
  try {
    const pct = Math.round(b.fraction * 100);
    if (b.level === 'exhausted')
      await postNotice(
        d,
        'MAS: daily AI budget reached',
        `US$${b.spentUsd.toFixed(2)} of US$${b.budgetUsd.toFixed(2)} spent today. Summaries and digests use templates until midnight. Notifications are not affected.`,
        'ai-budget-exhausted',
      );
    else
      await postNotice(
        d,
        `MAS: AI budget at ${pct}%`,
        `US$${b.spentUsd.toFixed(2)} of US$${b.budgetUsd.toFixed(2)} spent today. At 100% MAS switches to templates until midnight.`,
        'ai-budget-warn',
      );
  } catch (err) {
    d.log.error({ err: errorMessage(err) }, 'could not post the AI budget alert');
  }
}

// ---------------------------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------------------------

export function digestPeriod(
  kind: 'daily' | 'weekly',
  now: Date,
  timeZone: string,
  manual: boolean,
): { start: Date; end: Date } {
  if (kind === 'daily') {
    // The 24 hours up to the run. Scheduled runs end on the minute, so a double fire is one
    // digest; "Send now" includes everything up to this moment.
    const end = manual ? now : new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    return { start: shiftZonedDays(end, -1, timeZone), end };
  }
  // Scheduled: the last full week Monday 00:00 → Monday 00:00. Manual: the 7 days up to now.
  const end = manual ? now : startOfZonedDay(now, timeZone);
  return {
    start: manual ? shiftZonedDays(end, -7, timeZone) : addZonedDays(end, -7, timeZone),
    end,
  };
}

export async function runDigest(
  d: AiDeps,
  kind: 'daily' | 'weekly',
  opts: { manual?: boolean } = {},
): Promise<DigestRunResult> {
  const now = d.now();
  const tz = d.cfg.timezone;
  const manual = !!opts.manual;
  const { start, end } = digestPeriod(kind, now, tz, manual);
  if (await findDigest(d.db, kind, start))
    return { ok: true, message: 'This period already has a digest.' };
  const facts =
    kind === 'daily'
      ? await dailyDigestFacts(d.db, start, end, tz)
      : await weeklyDigestFacts(d.db, start, end, tz);

  let content: DigestContent = templateDigest(facts);
  let source: 'ai' | 'template' = 'template';
  let aiCallId: number | null = null;
  let note = 'from the template';
  if (d.cfg.ai.enabled) {
    const runner = aiRunner(d);
    const prefix = stablePrefix(d.cfg.ai.environmentNotes, await loadSiteProfiles(d.db));
    const out = await writeDigest(runner, d.cfg.ai, prefix, facts);
    aiCallId = out.callId;
    await budgetAlerts(d, out.budget);
    if (out.ok) {
      content = out.data;
      source = 'ai';
      note = 'by Claude';
    } else note = `from the template (AI: ${out.status})`;
  }
  const markdown = digestMarkdown(content, facts, source);
  const id = await saveDigest(d.db, {
    kind,
    periodStart: start,
    periodEnd: end,
    source,
    content,
    facts,
    markdown,
    aiCallId,
  });
  if (id === null) return { ok: true, message: 'This period already has a digest.' };

  const shadow = d.cfg.notify.shadow.enabled;
  const channel = shadow ? d.cfg.notify.shadow.channelKey : d.cfg.digest.channelKey;
  const secrets = await loadChannelSecrets(d.db, d.box);
  const c = secrets.get(channel);
  const notificationId = await recordStandalone(
    d.db,
    {
      purpose: 'digest',
      kind: 'teams',
      channelKey: channel,
      personId: null,
      recipient: shadow ? `#${channel} (shadow)` : `#${channel}`,
      payload: digestCard(content, facts, source, `${d.cfg.baseUrl}/digests/${id}`),
      suppressReason: !c?.url ? 'channel_not_configured' : !c.enabled ? 'channel_disabled' : null,
      shadow,
    },
    now,
  );
  await linkDigestNotification(d.db, id, notificationId);
  d.log.info({ kind, digestId: id, source, channel }, 'digest written');
  return {
    ok: true,
    digestId: id,
    message: `${digestTitle(facts)} written ${note}${!c?.url ? `; #${channel} has no webhook, so it was not posted` : ` and queued for #${channel}`}.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Settings → AI → Test
// ---------------------------------------------------------------------------------------------

export async function runAiTest(d: AiDeps, model?: string): Promise<AiTestResult> {
  if (!d.cfg.ai.apiKey) return { ok: false, message: 'No Anthropic API key is set.' };
  const m = model ?? d.cfg.ai.models.summary;
  const started = d.now().getTime();
  const out = await testAi(aiRunner(d), d.cfg.ai, m);
  const sec = ((d.now().getTime() - started) / 1000).toFixed(1);
  if (out.ok)
    return {
      ok: true,
      message: `Claude answered in ${sec} s using ${out.model} (about US$${out.costUsd.toFixed(4)}).${d.cfg.ai.enabled ? '' : ' AI is switched off, so MAS will not use it until you turn it on.'}`,
    };
  return { ok: false, message: `The test call failed (${out.status}): ${out.error}` };
}
