/**
 * Delivery decisions, as a pure function of (incident now, what was already announced, context).
 * The worker records the plan in the notifications outbox and sends it; running the planner again
 * with nothing new changed produces nothing, so a missed trigger is caught by the next sweep.
 *
 * AI never decides delivery: this module only sees deterministic incident fields.
 */
import { PRIORITIES, type Priority } from '../correlation/types';
import {
  pushoverPayload,
  smsText,
  teamsCard,
  type CardOptions,
  type MessageLinks,
  type PushoverPayload,
  type SmsPayload,
  type TeamsPayload,
} from './messages';
import { escalationLevels, type OnCallChain } from './oncall';
import { routeIncident, type RouteResult } from './routing';
import type {
  ChannelInfo,
  ChannelKind,
  NotificationPurpose,
  NotifyIncident,
  NotifyState,
  Person,
  RoutingRule,
  SuppressReason,
} from './types';

export interface DispatchContext {
  now: Date;
  rules: readonly RoutingRule[];
  channels: ReadonlyMap<string, ChannelInfo>;
  people: ReadonlyMap<number, Person>;
  chain: OnCallChain;
  withinBusinessHours: boolean;
  /** Quiet hours are in effect now; only priorities at or above `quietMinPriority` notify. */
  quietActive: boolean;
  quietMinPriority: Priority;
  shadow: { enabled: boolean; channelKey: string; allowPaging: boolean };
  defaultEscalateAfterMin: number;
  /** Pages already sent to each person in the rate-limit window. */
  recentPages: ReadonlyMap<number, number>;
  pageRateLimit: number;
  providers: { sms: boolean; pushover: boolean };
  links: MessageLinks;
  /** Formats a time for message text in APP_TIMEZONE. */
  formatTime: (d: Date) => string;
  /** Post one follow-up card when the first AI summary arrives (AI_POST_SUMMARY_UPDATE). */
  postAiSummary: boolean;
}

export type MessagePayload = TeamsPayload | SmsPayload | PushoverPayload;

export interface PlannedMessage {
  purpose: NotificationPurpose;
  kind: ChannelKind;
  channelKey: string | null;
  personId: number | null;
  /** Display label: "#net-critical", "Pat Doe (SMS +1•••4567)". */
  recipient: string;
  payload: MessagePayload;
  suppressReason: SuppressReason | null;
  shadow: boolean;
}

export interface DispatchPlan {
  messages: PlannedMessage[];
  state: NotifyState;
  /** Cancel pending escalations, with this reason. */
  cancelEscalations: string | null;
  scheduleEscalations: Array<{ level: number; dueAt: Date }>;
}

const OPEN = new Set(['open', 'acknowledged']);
const rank = (p: Priority) => PRIORITIES.indexOf(p);

export function maskPhone(e164: string): string {
  return e164.length > 6 ? `${e164.slice(0, 2)}•••${e164.slice(-4)}` : '•••';
}

function routeFor(inc: NotifyIncident, ctx: DispatchContext): RouteResult {
  return routeIncident(ctx.rules, {
    priority: inc.priority,
    kind: inc.kind,
    divisionCodes: inc.divisionCodes,
    siteId: inc.siteId,
    affectedSiteIds: inc.affectedSiteIds,
    withinBusinessHours: ctx.withinBusinessHours,
  });
}

/** A reason that silences every message for this incident right now, if any. */
function globalSuppression(inc: NotifyIncident, ctx: DispatchContext): SuppressReason | null {
  if (inc.inMaintenance) return 'maintenance';
  if (ctx.quietActive && rank(inc.priority) > rank(ctx.quietMinPriority)) return 'quiet_hours';
  return null;
}

interface Pages {
  messages: PlannedMessage[];
  /** For the shadow card: "Pat Doe (SMS)". */
  names: string[];
  personIds: number[];
}

function pageMessages(
  inc: NotifyIncident,
  people: readonly Person[],
  ctx: DispatchContext,
  purpose: NotificationPurpose,
  kind: 'page' | 'escalation' | 'resolved',
  escalatedFrom?: string,
): Pages {
  const out: Pages = { messages: [], names: [], personIds: [] };
  for (const p of people) {
    const via: Array<'sms' | 'pushover'> =
      p.pageVia === 'both'
        ? ['sms', 'pushover']
        : p.pageVia === 'sms' || p.pageVia === 'pushover'
          ? [p.pageVia]
          : [];
    out.personIds.push(p.id);
    if (via.length === 0) {
      out.messages.push(
        msg(purpose, 'sms', null, p.id, `${p.name} (no paging method)`, { body: '' }, 'no_contact'),
      );
      continue;
    }
    const sent = ctx.recentPages.get(p.id) ?? 0;
    for (const k of via) {
      const contact = k === 'sms' ? p.phoneE164 : p.pushoverUserKey;
      const label =
        k === 'sms'
          ? `${p.name} (SMS ${p.phoneE164 ? maskPhone(p.phoneE164) : 'no number'})`
          : `${p.name} (Pushover)`;
      const o = { kind, link: ctx.links.short, now: ctx.now, escalatedFrom };
      const payload =
        k === 'sms' ? { body: smsText(inc, o) } : (pushoverPayload(inc, o) as MessagePayload);
      let reason: SuppressReason | null = null;
      if (!contact) reason = 'no_contact';
      else if (!ctx.providers[k]) reason = 'provider_not_configured';
      else if (ctx.shadow.enabled && !ctx.shadow.allowPaging) reason = 'shadow_mode';
      else if (kind !== 'resolved' && sent >= ctx.pageRateLimit) reason = 'rate_limited';
      out.messages.push(msg(purpose, k, null, p.id, label, payload, reason, ctx.shadow.enabled));
      out.names.push(`${p.name} (${k === 'sms' ? 'SMS' : 'Pushover'})`);
    }
  }
  return out;
}

function msg(
  purpose: NotificationPurpose,
  kind: ChannelKind,
  channelKey: string | null,
  personId: number | null,
  recipient: string,
  payload: MessagePayload,
  suppressReason: SuppressReason | null,
  shadow = false,
): PlannedMessage {
  return { purpose, kind, channelKey, personId, recipient, payload, suppressReason, shadow };
}

function teamsMessages(
  inc: NotifyIncident,
  route: RouteResult,
  ctx: DispatchContext,
  purpose: NotificationPurpose,
  card: Omit<CardOptions, 'links' | 'now' | 'shadow'>,
  wouldPage: string[],
): PlannedMessage[] {
  const channelState = (key: string): SuppressReason | null => {
    const c = ctx.channels.get(key);
    if (!c || !c.configured) return 'channel_not_configured';
    if (!c.enabled) return 'channel_disabled';
    return null;
  };
  if (ctx.shadow.enabled) {
    // One post to the shadow channel saying where it would have gone and who would be paged.
    if (route.channelKeys.length === 0 && wouldPage.length === 0) return [];
    const key = ctx.shadow.channelKey;
    const payload = teamsCard(inc, {
      ...card,
      links: ctx.links,
      now: ctx.now,
      shadow: { intendedChannels: route.channelKeys, wouldPage },
    });
    return [msg(purpose, 'teams', key, null, `#${key} (shadow)`, payload, channelState(key), true)];
  }
  return route.channelKeys.map((key) =>
    msg(
      purpose,
      'teams',
      key,
      null,
      `#${key}`,
      teamsCard(inc, { ...card, links: ctx.links, now: ctx.now }),
      channelState(key),
    ),
  );
}

function escalationSchedule(route: RouteResult, ctx: DispatchContext) {
  const levels = escalationLevels(ctx.chain).length;
  const every = (route.escalateAfterMin ?? ctx.defaultEscalateAfterMin) * 60_000;
  return Array.from({ length: Math.max(0, levels - 1) }, (_, i) => ({
    level: i + 1,
    dueAt: new Date(ctx.now.getTime() + (i + 1) * every),
  }));
}

function finish(plan: DispatchPlan, inc: NotifyIncident, ctx: DispatchContext): DispatchPlan {
  // Maintenance and quiet hours win over any other reason: they explain the silence best.
  const silence = globalSuppression(inc, ctx);
  if (silence) for (const m of plan.messages) m.suppressReason = silence;
  return plan;
}

/** Decide what to send now for one incident. `prev` is what was announced before (or null). */
export function planDispatch(
  inc: NotifyIncident,
  prev: NotifyState | null,
  ctx: DispatchContext,
): DispatchPlan {
  const now = ctx.now;
  const open = OPEN.has(inc.status);
  const snoozed = !!inc.snoozedUntil && inc.snoozedUntil.getTime() > now.getTime();
  const route = routeFor(inc, ctx);
  const pageWorthy = route.page && inc.status === 'open' && !snoozed;
  const levels = escalationLevels(ctx.chain);

  const plan: DispatchPlan = {
    messages: [],
    state: {
      lastStatus: inc.status,
      lastPriority: inc.priority,
      lastKind: inc.kind,
      lastMaterialRev: inc.materialRev,
      updateCount: prev?.updateCount ?? 0,
      pagedAt: prev?.pagedAt ?? null,
      pagedPersonIds: prev?.pagedPersonIds ?? [],
      lastSnoozedUntil: snoozed ? inc.snoozedUntil : null,
      baselined: prev?.baselined ?? false,
      aiSummaryPosted: prev?.aiSummaryPosted ?? false,
    },
    cancelEscalations: null,
    scheduleEscalations: [],
  };

  const page = (purpose: NotificationPurpose) => {
    const pages = pageMessages(inc, levels[0] ?? [], ctx, purpose, 'page');
    plan.state.pagedAt = now;
    plan.state.pagedPersonIds = [...new Set([...plan.state.pagedPersonIds, ...pages.personIds])];
    plan.scheduleEscalations = escalationSchedule(route, ctx);
    return pages;
  };
  const update = (change: string, extraPages?: Pages) => {
    plan.state.updateCount += 1;
    if (inc.ai) plan.state.aiSummaryPosted = true;
    plan.messages.push(
      ...teamsMessages(
        inc,
        route,
        ctx,
        'incident_update',
        { kind: 'update', change, updateNo: plan.state.updateCount },
        extraPages?.names ?? [],
      ),
      ...(extraPages?.messages ?? []),
    );
  };

  // First announcement (also for an incident that was only pre-existing until real alerts joined).
  if (prev === null || prev.baselined) {
    if (inc.seeded || !open) {
      plan.state.baselined = true;
      return plan;
    }
    plan.state.baselined = false;
    plan.state.updateCount = 0;
    plan.state.aiSummaryPosted = !!inc.ai;
    const pages = pageWorthy ? page('incident_open') : null;
    plan.messages.push(
      ...teamsMessages(inc, route, ctx, 'incident_open', { kind: 'open' }, pages?.names ?? []),
      ...(pages?.messages ?? []),
    );
    return finish(plan, inc, ctx);
  }

  if (prev.lastStatus !== inc.status) {
    const wasOpen = OPEN.has(prev.lastStatus);
    if (inc.status === 'acknowledged' && prev.lastStatus === 'open') {
      update(`Acknowledged by ${inc.acknowledgedBy ?? 'someone'}`);
      plan.cancelEscalations = 'acknowledged';
    } else if (inc.status === 'open' && prev.lastStatus === 'acknowledged') {
      update('Acknowledgement removed');
    } else if (!open && wasOpen) {
      plan.messages.push(
        ...teamsMessages(inc, route, ctx, 'incident_resolved', { kind: 'resolved' }, []),
      );
      const paged = prev.pagedPersonIds
        .map((id) => ctx.people.get(id))
        .filter((p): p is Person => !!p);
      plan.messages.push(
        ...pageMessages(inc, paged, ctx, 'incident_resolved', 'resolved').messages,
      );
      plan.cancelEscalations = 'resolved';
    } else if (open && !wasOpen) {
      plan.state.pagedPersonIds = [];
      update('Reopened: the problem came back', pageWorthy ? page('incident_update') : undefined);
    }
    return finish(plan, inc, ctx);
  }

  if (!open) return plan;

  const changes: string[] = [];
  if (prev.lastPriority !== inc.priority)
    changes.push(`Priority ${prev.lastPriority} → ${inc.priority}`);
  if (prev.lastKind !== inc.kind) changes.push(`Now: ${inc.title}`);
  if (changes.length === 0 && prev.lastMaterialRev !== inc.materialRev) changes.push('Updated');
  const newlySnoozed = snoozed && prev.lastSnoozedUntil?.getTime() !== inc.snoozedUntil!.getTime();
  const snoozeEnded = !snoozed && prev.lastSnoozedUntil !== null;
  if (newlySnoozed) {
    changes.push(
      `Snoozed until ${ctx.formatTime(inc.snoozedUntil!)} by ${inc.snoozedBy ?? 'someone'}`,
    );
    plan.cancelEscalations = 'snoozed';
  }
  // Page when the incident becomes page-worthy (e.g. P3 → P1), or again when a snooze ends
  // and nobody has acknowledged it.
  const needsPage = pageWorthy && (!prev.pagedAt || snoozeEnded);
  if (snoozeEnded && needsPage) changes.push('Snooze ended, still not acknowledged');
  // The first AI summary is worth one follow-up post (it explains the likely cause and first
  // steps). It never pages, and goes only where routing already sends this incident.
  if (inc.ai && !prev.aiSummaryPosted) {
    if (!ctx.postAiSummary)
      plan.state.aiSummaryPosted = true; // decided: no follow-up card
    else if (changes.length === 0) changes.push('Summary and first steps');
  }
  if (changes.length) update(changes.join(' · '), needsPage ? page('incident_update') : undefined);
  return finish(plan, inc, ctx);
}

export interface EscalationPlan {
  messages: PlannedMessage[];
  state: NotifyState;
  /** Set when the escalation should not fire (acknowledged, resolved, snoozed, …). */
  cancelReason: string | null;
}

/** An escalation came due: page the next level if the incident is still unacknowledged. */
export function planEscalation(
  inc: NotifyIncident,
  prev: NotifyState,
  level: number,
  ctx: DispatchContext,
  afterMin: number,
): EscalationPlan {
  const out: EscalationPlan = { messages: [], state: { ...prev }, cancelReason: null };
  if (inc.status === 'acknowledged') return { ...out, cancelReason: 'acknowledged' };
  if (inc.status !== 'open') return { ...out, cancelReason: 'resolved' };
  if (inc.snoozedUntil && inc.snoozedUntil.getTime() > ctx.now.getTime())
    return { ...out, cancelReason: 'snoozed' };
  if (inc.inMaintenance) return { ...out, cancelReason: 'maintenance' };
  const levels = escalationLevels(ctx.chain);
  const people = levels[level];
  if (!people?.length) return { ...out, cancelReason: 'nobody_left' };
  const from = (levels[level - 1] ?? []).map((p) => p.name).join(', ');
  const pages = pageMessages(inc, people, ctx, 'escalation', 'escalation', from || undefined);
  const route = routeFor(inc, ctx);
  out.state.pagedPersonIds = [...new Set([...prev.pagedPersonIds, ...pages.personIds])];
  out.state.updateCount = prev.updateCount + 1;
  if (inc.ai) out.state.aiSummaryPosted = true;
  out.messages.push(
    ...teamsMessages(
      inc,
      route,
      ctx,
      'escalation',
      {
        kind: 'escalation',
        change: `Not acknowledged after ${afterMin * level} min: escalated to ${people.map((p) => p.name).join(', ')}`,
      },
      pages.names,
    ),
    ...pages.messages,
  );
  const silence = globalSuppression(inc, ctx);
  if (silence) for (const m of out.messages) m.suppressReason = silence;
  return out;
}
