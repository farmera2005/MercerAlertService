import { isWithinHours } from '../correlation/calendar';

const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/;

/** "22:00-06:00" → { start, end }; empty → null (no quiet hours). Throws on a malformed value. */
export function parseQuietHours(value: string): { start: string; end: string } | null {
  const v = value.trim();
  if (!v) return null;
  const m = WINDOW.exec(v);
  if (!m) throw new Error('use HH:MM-HH:MM, e.g. 22:00-06:00');
  return { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` };
}

export function quietHoursActive(
  now: Date,
  window: { start: string; end: string } | null,
  timeZone: string,
): boolean {
  if (!window || window.start === window.end) return false;
  return isWithinHours(now, { days: [1, 2, 3, 4, 5, 6, 7], ...window }, timeZone);
}
