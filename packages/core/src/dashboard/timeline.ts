/**
 * The incident timeline merges what MAS decided (incident events) with what Orion reported (alert
 * and status transitions, the Orion event log, and people's acks/notes in Orion) into one list.
 */
import { isDownLike, type StatusNorm } from '../orion';

export type TimelineSource = 'mas' | 'alert' | 'status' | 'orion';
export type TimelineTone = 'bad' | 'ok' | 'info' | 'user';

export interface TimelineEntry {
  at: Date;
  source: TimelineSource;
  tone: TimelineTone;
  text: string;
  actor?: string;
}

export interface TimelineInput {
  incidentEvents: ReadonlyArray<{ at: Date; type: string; actor: string; message: string }>;
  transitions: ReadonlyArray<{
    observedAt: Date;
    sourceAt: Date | null;
    kind: 'alert' | 'node' | 'interface' | 'source';
    change: string;
    fromState: string | null;
    toState: string;
    label: string;
    alertName?: string | null;
  }>;
  orionEvents: ReadonlyArray<{
    eventTime: Date | null;
    eventTypeName: string | null;
    message: string | null;
  }>;
  /** Orion.AlertHistory: 0 triggered, 1 reset, 2 acknowledged, 3 note. */
  alertHistory: ReadonlyArray<{
    at: Date | null;
    eventType: number;
    message: string | null;
    accountId: string | null;
    label: string;
  }>;
}

const USER_EVENTS = new Set(['acked', 'unacked', 'snoozed', 'unsnoozed', 'note']);
const BAD_EVENTS = new Set(['opened', 'reopened']);
const OK_EVENTS = new Set(['resolved', 'closed', 'snooze_expired']);

function eventTone(type: string, actor: string): TimelineTone {
  if (USER_EVENTS.has(type) || actor.startsWith('user:'))
    return type === 'resolved' ? 'ok' : 'user';
  if (BAD_EVENTS.has(type)) return 'bad';
  if (OK_EVENTS.has(type)) return 'ok';
  return 'info';
}

function statusTone(to: string): TimelineTone {
  if (to === 'up') return 'ok';
  return isDownLike(to as StatusNorm) ? 'bad' : 'info';
}

export function buildTimeline(input: TimelineInput, limit = 400): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const e of input.incidentEvents) {
    out.push({
      at: e.at,
      source: 'mas',
      tone: eventTone(e.type, e.actor),
      text: e.message,
      actor: e.actor.startsWith('user:') ? e.actor.slice(5) : undefined,
    });
  }
  for (const t of input.transitions) {
    const at = t.sourceAt ?? t.observedAt;
    if (t.kind === 'alert') {
      const name = t.alertName ?? 'Alert';
      const verb =
        t.change === 'raised'
          ? 'raised'
          : t.change === 'retriggered'
            ? 'triggered again'
            : t.change === 'cleared'
              ? 'cleared'
              : t.change === 'acked'
                ? 'acknowledged in Orion'
                : t.change;
      out.push({
        at,
        source: 'alert',
        tone: t.change === 'cleared' ? 'ok' : t.change === 'acked' ? 'user' : 'bad',
        text: `${name} ${verb} — ${t.label}`,
      });
    } else if (t.kind === 'source') {
      out.push({
        at,
        source: 'status',
        tone: t.toState === 'up' ? 'ok' : 'bad',
        text: t.toState === 'up' ? 'SolarWinds reachable again' : 'SolarWinds unreachable',
      });
    } else {
      out.push({
        at,
        source: 'status',
        tone: statusTone(t.toState),
        text: `${t.label}: ${t.fromState ?? 'unknown'} → ${t.toState}`,
      });
    }
  }
  for (const e of input.orionEvents) {
    if (!e.eventTime || !e.message) continue;
    out.push({
      at: e.eventTime,
      source: 'orion',
      tone: /\bdown\b|fail|critical/i.test(e.message)
        ? 'bad'
        : /\bup\b|recover|online/i.test(e.message)
          ? 'ok'
          : 'info',
      text: e.eventTypeName ? `${e.eventTypeName}: ${e.message}` : e.message,
    });
  }
  // Triggers and resets are already covered by alert transitions; keep people's actions. Acks and
  // notes that MAS itself wrote to Orion are skipped: the MAS entry and its "… in Orion" summary
  // already show them, and they would repeat once per alert.
  for (const h of input.alertHistory) {
    if (!h.at || (h.eventType !== 2 && h.eventType !== 3)) continue;
    if (h.message && WRITTEN_BY_MAS.test(h.message)) continue;
    out.push({
      at: h.at,
      source: 'orion',
      tone: 'user',
      text:
        h.eventType === 2
          ? `Acknowledged in Orion — ${h.label}${h.message ? `: ${h.message}` : ''}`
          : `Note in Orion — ${h.label}${h.message ? `: ${h.message}` : ''}`,
      actor: h.accountId ?? undefined,
    });
  }
  out.sort((a, b) => a.at.getTime() - b.at.getTime() || order(a) - order(b));
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** The signature MAS puts on acks and notes it writes to Orion (see apps/worker/src/writeback.ts). */
const WRITTEN_BY_MAS = /MercerAlertService[^\n]*\(INC-\d+\)\s*$/;

// At the same instant, show the cause (Orion) before MAS's reaction.
const order = (e: TimelineEntry) => ({ status: 0, alert: 1, orion: 2, mas: 3 })[e.source];
