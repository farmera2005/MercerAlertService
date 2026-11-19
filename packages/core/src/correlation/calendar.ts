import { zonedParts } from '../time';
import type { BusinessHours, MaintenanceWindow, SeasonPeriod, SiteInfo } from './types';

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Is `now` inside the weekly hours (in `timeZone`)? Handles spans that cross midnight. */
export function isWithinHours(now: Date, hours: BusinessHours, timeZone: string): boolean {
  const p = zonedParts(now, timeZone);
  const minute = p.hour * 60 + p.minute;
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  if (start <= end) return hours.days.includes(p.isoWeekday) && minute >= start && minute < end;
  // Overnight, e.g. 22:00–06:00: the evening belongs to today, the early morning to yesterday.
  const yesterday = p.isoWeekday === 1 ? 7 : p.isoWeekday - 1;
  return (
    (hours.days.includes(p.isoWeekday) && minute >= start) ||
    (hours.days.includes(yesterday) && minute < end)
  );
}

function mmdd(now: Date, timeZone: string): { md: string; year: number } {
  const p = zonedParts(now, timeZone);
  return {
    md: `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    year: p.year,
  };
}

export function isSeasonActive(season: SeasonPeriod, now: Date, timeZone: string): boolean {
  if (!season.enabled) return false;
  const { md, year } = mmdd(now, timeZone);
  if (season.year !== null && season.year !== year) return false;
  return season.startMd <= season.endMd
    ? md >= season.startMd && md <= season.endMd
    : md >= season.startMd || md <= season.endMd;
}

export function activeSeasons(
  seasons: readonly SeasonPeriod[],
  now: Date,
  timeZone: string,
): SeasonPeriod[] {
  return seasons.filter((s) => isSeasonActive(s, now, timeZone));
}

export function isHarvest(seasons: readonly SeasonPeriod[], now: Date, timeZone: string): boolean {
  return activeSeasons(seasons, now, timeZone).some((s) => s.kind === 'harvest');
}

/** Business hours for a site at `now` (harvest hours apply to harvest-critical sites in harvest). */
export function siteHours(
  site: Pick<SiteInfo, 'harvestCritical' | 'harvestHours' | 'businessHours'>,
  harvest: boolean,
): BusinessHours {
  return harvest && site.harvestCritical && site.harvestHours
    ? site.harvestHours
    : site.businessHours;
}

export function isMaintenanceActive(w: MaintenanceWindow, now: Date, timeZone: string): boolean {
  const t = now.getTime();
  if (t < w.startsAt.getTime()) return false;
  if (w.endsAt && t >= w.endsAt.getTime()) return false;
  if (!w.recurrence) return true;
  const { weekdays, start, durationMin } = w.recurrence;
  const p = zonedParts(now, timeZone);
  const minute = p.hour * 60 + p.minute;
  const s = minutesOf(start);
  // Today's occurrence, or yesterday's spilling past midnight.
  if (weekdays.includes(p.isoWeekday) && minute >= s && minute < s + durationMin) return true;
  const yesterday = p.isoWeekday === 1 ? 7 : p.isoWeekday - 1;
  return weekdays.includes(yesterday) && minute + 1440 < s + durationMin && minute + 1440 >= s;
}

/** The active window (if any) covering a node / site; "incidents" beats "notifications". */
export function maintenanceFor(
  windows: readonly MaintenanceWindow[],
  target: { nodeId: number | null; siteId: number | null },
  now: Date,
  timeZone: string,
): MaintenanceWindow | null {
  let best: MaintenanceWindow | null = null;
  for (const w of windows) {
    const applies =
      w.scope === 'global' ||
      (w.scope === 'site' && w.siteId !== null && w.siteId === target.siteId) ||
      (w.scope === 'node' && w.nodeId !== null && w.nodeId === target.nodeId);
    if (!applies || !isMaintenanceActive(w, now, timeZone)) continue;
    if (!best || (best.suppress === 'notifications' && w.suppress === 'incidents')) best = w;
  }
  return best;
}
