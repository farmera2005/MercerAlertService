/**
 * What a person may do to an incident from the dashboard, and what each action changes. Pure, so
 * the server action and the tests agree. The correlation engine still owns everything else
 * (membership, priority, auto-resolve, reopen, close).
 */
import type { IncidentStatus } from '../correlation/types';

export const INCIDENT_ACTIONS = ['ack', 'unack', 'snooze', 'unsnooze', 'resolve', 'note'] as const;
export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];

/** Snooze choices offered in the UI (minutes). */
export const SNOOZE_OPTIONS_MIN = [30, 60, 120, 240, 480, 1440] as const;
export const NOTE_MAX_CHARS = 4000;

export interface ActionTarget {
  status: IncidentStatus;
  snoozedUntil: Date | null;
  /** Member alerts still active in Orion (resolving anyway is allowed, with a note). */
  activeAlerts: number;
}

export interface ActionRequest {
  action: IncidentAction;
  /** snooze */
  minutes?: number;
  /** note, or the optional comment on ack / resolve */
  text?: string;
}

export interface IncidentPatch {
  status?: IncidentStatus;
  acknowledgedAt?: Date | null;
  acknowledgedBy?: string | null;
  snoozedUntil?: Date | null;
  snoozedBy?: string | null;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
  resolvePendingSince?: Date | null;
}

export type ActionPlan =
  | {
      ok: true;
      patch: IncidentPatch;
      event: { type: string; message: string; details?: Record<string, unknown> };
      /** A material change (here: resolved) re-triggers the AI summary and notification update. */
      material: boolean;
    }
  | { ok: false; error: string };

const OPEN: ReadonlySet<IncidentStatus> = new Set(['open', 'acknowledged']);

function duration(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}

/** Decide whether `req` is allowed on `target` and what it changes. `actor` is the display label. */
export function planIncidentAction(
  target: ActionTarget,
  req: ActionRequest,
  actor: string,
  now: Date,
): ActionPlan {
  const comment = req.text?.trim() ?? '';
  if (comment.length > NOTE_MAX_CHARS)
    return { ok: false, error: `Keep it under ${NOTE_MAX_CHARS} characters.` };
  const suffix = comment ? `: ${comment}` : '';
  const details = comment ? { comment } : undefined;

  switch (req.action) {
    case 'ack':
      if (target.status === 'acknowledged') return { ok: false, error: 'Already acknowledged.' };
      if (target.status !== 'open')
        return { ok: false, error: `The incident is ${target.status}.` };
      return {
        ok: true,
        patch: { status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: actor },
        event: { type: 'acked', message: `Acknowledged by ${actor}${suffix}`, details },
        material: false,
      };
    case 'unack':
      if (target.status !== 'acknowledged')
        return { ok: false, error: 'The incident is not acknowledged.' };
      return {
        ok: true,
        patch: { status: 'open', acknowledgedAt: null, acknowledgedBy: null },
        event: {
          type: 'unacked',
          message: `Acknowledgement removed by ${actor}${suffix}`,
          details,
        },
        material: false,
      };
    case 'snooze': {
      if (!OPEN.has(target.status))
        return { ok: false, error: `The incident is ${target.status}.` };
      const min = req.minutes ?? 0;
      if (!(SNOOZE_OPTIONS_MIN as readonly number[]).includes(min))
        return { ok: false, error: 'Choose a snooze duration.' };
      const until = new Date(now.getTime() + min * 60_000);
      return {
        ok: true,
        patch: { snoozedUntil: until, snoozedBy: actor },
        event: {
          type: 'snoozed',
          message: `Snoozed for ${duration(min)} by ${actor}${suffix}`,
          details: { until: until.toISOString(), minutes: min, ...details },
        },
        material: false,
      };
    }
    case 'unsnooze':
      if (!target.snoozedUntil || target.snoozedUntil.getTime() <= now.getTime())
        return { ok: false, error: 'The incident is not snoozed.' };
      return {
        ok: true,
        patch: { snoozedUntil: null, snoozedBy: null },
        event: { type: 'unsnoozed', message: `Snooze cancelled by ${actor}`, details },
        material: false,
      };
    case 'resolve': {
      if (!OPEN.has(target.status))
        return { ok: false, error: `The incident is already ${target.status}.` };
      const still =
        target.activeAlerts > 0
          ? ` (${target.activeAlerts} alert${target.activeAlerts === 1 ? ' was' : 's were'} still active in Orion)`
          : '';
      return {
        ok: true,
        patch: {
          status: 'resolved',
          resolvedAt: now,
          resolvedBy: `user:${actor}`,
          resolvePendingSince: null,
          snoozedUntil: null,
          snoozedBy: null,
        },
        event: {
          type: 'resolved',
          message: `Resolved by ${actor}${still}${suffix}`,
          details: { manual: true, activeAlerts: target.activeAlerts, ...details },
        },
        material: true,
      };
    }
    case 'note':
      if (!comment) return { ok: false, error: 'Write a note first.' };
      return {
        ok: true,
        patch: {},
        event: { type: 'note', message: comment },
        material: false,
      };
  }
}
