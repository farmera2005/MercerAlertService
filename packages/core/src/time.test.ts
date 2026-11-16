import { describe, expect, it } from 'vitest';
import { bucketStart, parseSwisDate, zonedParts, zonedTimeToUtc } from './time';

describe('parseSwisDate', () => {
  it('parses UTC with 7 fractional digits', () => {
    expect(parseSwisDate('2026-10-14T13:05:09.1234567Z')?.toISOString()).toBe(
      '2026-10-14T13:05:09.123Z',
    );
  });
  it('parses explicit offsets', () => {
    expect(parseSwisDate('2026-10-14T09:05:09-04:00')?.toISOString()).toBe(
      '2026-10-14T13:05:09.000Z',
    );
  });
  it('treats naive timestamps as the configured zone', () => {
    expect(parseSwisDate('2026-10-14T09:05:09', 'UTC')?.toISOString()).toBe(
      '2026-10-14T09:05:09.000Z',
    );
    // EDT (UTC-4) in October
    expect(parseSwisDate('2026-10-14T09:05:09', 'America/New_York')?.toISOString()).toBe(
      '2026-10-14T13:05:09.000Z',
    );
    // EST (UTC-5) in January
    expect(parseSwisDate('2026-01-14T09:05:09', 'America/New_York')?.toISOString()).toBe(
      '2026-01-14T14:05:09.000Z',
    );
  });
  it('handles legacy /Date(ms)/ and sentinel dates', () => {
    expect(parseSwisDate('/Date(1760447109000)/')?.toISOString()).toBe('2025-10-14T13:05:09.000Z');
    expect(parseSwisDate('1899-12-30T00:00:00')).toBeNull();
    expect(parseSwisDate(null)).toBeNull();
    expect(parseSwisDate('not a date')).toBeNull();
  });
});

describe('zoned helpers', () => {
  it('round-trips across the DST change', () => {
    const utc = zonedTimeToUtc(2026, 11, 1, 1, 30, 0, 0, 'America/New_York');
    const p = zonedParts(utc, 'America/New_York');
    expect([p.hour, p.minute]).toEqual([1, 30]);
  });
  it('reports ISO weekday', () => {
    // 2026-11-16 is a Monday
    expect(zonedParts(new Date('2026-11-16T15:00:00Z'), 'America/New_York').isoWeekday).toBe(1);
  });
  it('buckets to 5 minutes', () => {
    expect(bucketStart(new Date('2026-11-16T15:07:59Z'), 5).toISOString()).toBe(
      '2026-11-16T15:05:00.000Z',
    );
  });
});
