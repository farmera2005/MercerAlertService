import { describe, expect, it } from 'vitest';
import { isMaintenanceActive, isSeasonActive, isWithinHours, maintenanceFor } from './calendar';
import type { MaintenanceWindow, SeasonPeriod } from './types';

const TZ = 'America/New_York';
const at = (iso: string) => new Date(iso);

describe('calendar', () => {
  it('evaluates business hours in the site time zone, including overnight spans', () => {
    const office = { days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' };
    expect(isWithinHours(at('2026-10-14T14:00:00Z'), office, TZ)).toBe(true); // Wed 10:00 EDT
    expect(isWithinHours(at('2026-10-14T22:00:00Z'), office, TZ)).toBe(false); // Wed 18:00
    expect(isWithinHours(at('2026-10-17T14:00:00Z'), office, TZ)).toBe(false); // Saturday
    const night = { days: [5], start: '22:00', end: '06:00' };
    expect(isWithinHours(at('2026-10-17T07:00:00Z'), night, TZ)).toBe(true); // Sat 03:00 (from Fri)
    expect(isWithinHours(at('2026-10-17T12:00:00Z'), night, TZ)).toBe(false);
  });
  it('handles seasons, year-wrapping periods and pinned years', () => {
    const harvest: SeasonPeriod = {
      id: 1,
      name: 'H',
      kind: 'harvest',
      startMd: '09-01',
      endMd: '12-15',
      year: null,
      multiplier: 1.5,
      divisions: null,
      harvestCriticalOnly: false,
      enabled: true,
    };
    expect(isSeasonActive(harvest, at('2026-10-14T14:00:00Z'), TZ)).toBe(true);
    expect(isSeasonActive(harvest, at('2026-12-16T14:00:00Z'), TZ)).toBe(false);
    expect(isSeasonActive({ ...harvest, enabled: false }, at('2026-10-14T14:00:00Z'), TZ)).toBe(
      false,
    );
    const winter = { ...harvest, startMd: '12-20', endMd: '01-05' };
    expect(isSeasonActive(winter, at('2027-01-02T14:00:00Z'), TZ)).toBe(true);
    expect(isSeasonActive({ ...harvest, year: 2025 }, at('2026-10-14T14:00:00Z'), TZ)).toBe(false);
  });
  it('evaluates one-off and weekly maintenance windows', () => {
    const oneOff: MaintenanceWindow = {
      id: 1,
      scope: 'site',
      siteId: 2,
      nodeId: null,
      startsAt: at('2026-10-14T13:00:00Z'),
      endsAt: at('2026-10-14T15:00:00Z'),
      recurrence: null,
      suppress: 'incidents',
      reason: null,
    };
    expect(isMaintenanceActive(oneOff, at('2026-10-14T14:00:00Z'), TZ)).toBe(true);
    expect(isMaintenanceActive(oneOff, at('2026-10-14T15:00:00Z'), TZ)).toBe(false);
    const sunday: MaintenanceWindow = {
      ...oneOff,
      startsAt: at('2026-01-01T00:00:00Z'),
      endsAt: null,
      recurrence: { weekdays: [7], start: '23:00', durationMin: 120 },
    };
    expect(isMaintenanceActive(sunday, at('2026-10-19T03:30:00Z'), TZ)).toBe(true); // Sun 23:30 EDT
    expect(isMaintenanceActive(sunday, at('2026-10-19T04:30:00Z'), TZ)).toBe(true); // Mon 00:30 (spill-over)
    expect(isMaintenanceActive(sunday, at('2026-10-19T05:30:00Z'), TZ)).toBe(false);
    const notif = {
      ...oneOff,
      id: 2,
      suppress: 'notifications' as const,
      scope: 'global' as const,
      siteId: null,
    };
    expect(
      maintenanceFor([notif, oneOff], { nodeId: 5, siteId: 2 }, at('2026-10-14T14:00:00Z'), TZ)?.id,
    ).toBe(1);
    expect(
      maintenanceFor([notif, oneOff], { nodeId: 5, siteId: 3 }, at('2026-10-14T14:00:00Z'), TZ)?.id,
    ).toBe(2);
  });
});
