/**
 * Who is on call: a weekly rotation (people in rotation order, handing off at a set weekday and
 * time in APP_TIMEZONE), explicit week assignments that replace it, and time-boxed overrides
 * (vacation swaps) that replace the primary.
 */
import { zonedParts } from '../time';
import type { Person } from './types';

export interface Handoff {
  /** ISO weekday, 1 = Monday. */
  isoWeekday: number;
  /** "HH:MM" in APP_TIMEZONE. */
  time: string;
}

export interface RotationWeek {
  /** Local date (YYYY-MM-DD) of the handoff that starts the week. */
  weekStart: string;
  primaryPersonId: number;
  secondaryPersonId: number | null;
}

export interface OncallOverride {
  personId: number;
  startsAt: Date;
  endsAt: Date;
}

export interface OnCallChain {
  weekStart: string;
  primary: Person | null;
  secondary: Person | null;
  leads: Person[];
  source: 'override' | 'schedule' | 'rotation' | 'none';
}

const DAY_MS = 86_400_000;
/** A Monday; rotation week numbers count from here. */
const ROTATION_EPOCH = Date.UTC(2024, 0, 1);

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Local date of the most recent handoff at or before `now`. */
export function rotationWeekStart(now: Date, handoff: Handoff, timeZone: string): string {
  const p = zonedParts(now, timeZone);
  const [hh, mm] = handoff.time.split(':').map(Number) as [number, number];
  let back = (p.isoWeekday - handoff.isoWeekday + 7) % 7;
  if (back === 0 && p.hour * 60 + p.minute < hh * 60 + mm) back = 7;
  return ymd(Date.UTC(p.year, p.month - 1, p.day) - back * DAY_MS);
}

export function addWeeks(weekStart: string, n: number): string {
  return ymd(Date.parse(`${weekStart}T00:00:00Z`) + n * 7 * DAY_MS);
}

function rotationIndex(weekStart: string, n: number): number {
  const weeks = Math.floor((Date.parse(`${weekStart}T00:00:00Z`) - ROTATION_EPOCH) / (7 * DAY_MS));
  return ((weeks % n) + n) % n;
}

export function onCallAt(
  now: Date,
  ctx: {
    people: readonly Person[];
    weeks: readonly RotationWeek[];
    overrides: readonly OncallOverride[];
    handoff: Handoff;
    timezone: string;
  },
): OnCallChain {
  const active = ctx.people.filter((p) => p.active);
  const byId = new Map(active.map((p) => [p.id, p]));
  const weekStart = rotationWeekStart(now, ctx.handoff, ctx.timezone);
  const leads = active.filter((p) => p.isItLead);

  let primary: Person | null = null;
  let secondary: Person | null = null;
  let source: OnCallChain['source'] = 'none';

  const week = ctx.weeks.find((w) => w.weekStart === weekStart);
  if (week && byId.has(week.primaryPersonId)) {
    primary = byId.get(week.primaryPersonId)!;
    secondary = week.secondaryPersonId !== null ? (byId.get(week.secondaryPersonId) ?? null) : null;
    source = 'schedule';
  } else {
    const rota = active
      .filter((p) => p.rotationPosition !== null)
      .sort((a, b) => a.rotationPosition! - b.rotationPosition! || a.id - b.id);
    if (rota.length) {
      const i = rotationIndex(weekStart, rota.length);
      primary = rota[i]!;
      secondary = rota.length > 1 ? rota[(i + 1) % rota.length]! : null;
      source = 'rotation';
    }
  }

  const t = now.getTime();
  const override = ctx.overrides.find(
    (o) => o.startsAt.getTime() <= t && t < o.endsAt.getTime() && byId.has(o.personId),
  );
  if (override) {
    const who = byId.get(override.personId)!;
    if (secondary?.id === who.id) secondary = primary;
    primary = who;
    source = 'override';
  }
  if (secondary?.id === primary?.id) secondary = null;
  return { weekStart, primary, secondary, leads, source };
}

/**
 * Escalation levels: 0 = primary, 1 = secondary, 2 = IT lead(s). Nobody is paged twice, and an
 * empty level is skipped (no secondary → level 1 goes straight to the IT lead).
 */
export function escalationLevels(chain: OnCallChain): Person[][] {
  const seen = new Set<number>();
  const levels: Person[][] = [];
  for (const group of [[chain.primary], [chain.secondary], chain.leads]) {
    const people = group.filter((p): p is Person => !!p && !seen.has(p.id));
    for (const p of people) seen.add(p.id);
    if (people.length) levels.push(people);
  }
  return levels;
}
