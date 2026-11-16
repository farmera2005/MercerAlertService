/** Time helpers. Everything is stored in UTC; business logic converts with an IANA zone. */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday … 7 = Sunday (ISO) */
  isoWeekday: number;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of dtf(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    isoWeekday: WEEKDAY[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/** Offset of `timeZone` from UTC at `date`, in ms (e.g. -4h for EDT). */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Interpret a wall-clock time in `timeZone` and return the UTC instant. */
export function zonedTimeToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return new Date(guess);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  // Second pass settles DST boundaries.
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/;
const MS_JSON_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/**
 * Parse a SWIS datetime value. Accepts ISO strings with 0–7 fractional digits, with or without
 * an offset (naive values are interpreted in `naiveTimeZone`), and legacy `/Date(ms)/`.
 * Orion uses 1899/1900-era sentinel dates for "never"; anything before 1971 returns null.
 */
export function parseSwisDate(value: unknown, naiveTimeZone = 'UTC'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let result: Date;
  const ms = MS_JSON_RE.exec(v);
  if (ms) {
    result = new Date(Number(ms[1]));
  } else {
    const m = ISO_RE.exec(v);
    if (!m) return null;
    const [, y, mo, d, h, mi, s = '0', frac = '0', zone] = m;
    const millis = Number(frac.padEnd(3, '0').slice(0, 3));
    if (zone) {
      const base = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s, millis);
      if (zone === 'Z') result = new Date(base);
      else {
        const sign = zone.startsWith('-') ? -1 : 1;
        const digits = zone.replace(/[+:-]/g, '');
        const offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
        result = new Date(base - offMin * 60_000);
      }
    } else {
      result = zonedTimeToUtc(+y!, +mo!, +d!, +h!, +mi!, +s, millis, naiveTimeZone);
    }
  }
  if (Number.isNaN(result.getTime()) || result.getUTCFullYear() < 1971) return null;
  return result;
}

/** Start of the `minutes`-wide UTC bucket containing `date`. */
export function bucketStart(date: Date, minutes: number): Date {
  const width = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / width) * width);
}
