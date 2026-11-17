import { describe, expect, it } from 'vitest';
import { escalationLevels, onCallAt, rotationWeekStart, type Handoff } from './oncall';
import type { Person } from './types';

const TZ = 'America/New_York';
const MON_8 = { isoWeekday: 1, time: '08:00' } satisfies Handoff;
const person = (id: number, p: Partial<Person> = {}): Person => ({
  id,
  name: `Person ${id}`,
  phoneE164: `+1419555000${id}`,
  pushoverUserKey: null,
  pageVia: 'sms',
  isItLead: false,
  active: true,
  rotationPosition: id,
  ...p,
});
const people = [
  person(1),
  person(2),
  person(3),
  person(9, { isItLead: true, rotationPosition: null }),
];

describe('rotationWeekStart', () => {
  it('hands off on Monday 08:00 local time', () => {
    // Mon 17 Nov 2025 07:59 EST is still the previous week; 08:00 is the new one.
    expect(rotationWeekStart(new Date('2025-11-17T12:59:00Z'), MON_8, TZ)).toBe('2025-11-10');
    expect(rotationWeekStart(new Date('2025-11-17T13:00:00Z'), MON_8, TZ)).toBe('2025-11-17');
    expect(rotationWeekStart(new Date('2025-11-23T23:00:00Z'), MON_8, TZ)).toBe('2025-11-17');
  });
});

describe('onCallAt', () => {
  const base = { people, weeks: [], overrides: [], handoff: MON_8, timezone: TZ };

  it('cycles through the rotation weekly, the next person being secondary', () => {
    const w1 = onCallAt(new Date('2025-11-18T15:00:00Z'), base);
    const w2 = onCallAt(new Date('2025-11-25T15:00:00Z'), base);
    expect(w1.source).toBe('rotation');
    expect(w2.primary!.id).toBe(w1.secondary!.id);
    expect(w1.leads.map((p) => p.id)).toEqual([9]);
  });

  it('uses an explicit week assignment over the rotation', () => {
    const c = onCallAt(new Date('2025-11-18T15:00:00Z'), {
      ...base,
      weeks: [{ weekStart: '2025-11-17', primaryPersonId: 3, secondaryPersonId: 1 }],
    });
    expect(c).toMatchObject({ source: 'schedule', primary: { id: 3 }, secondary: { id: 1 } });
  });

  it('lets an override take over as primary for its time range', () => {
    const at = new Date('2025-11-18T15:00:00Z');
    const plain = onCallAt(at, base);
    const c = onCallAt(at, {
      ...base,
      overrides: [
        {
          personId: plain.secondary!.id,
          startsAt: new Date('2025-11-18T00:00:00Z'),
          endsAt: new Date('2025-11-19T00:00:00Z'),
        },
      ],
    });
    expect(c.source).toBe('override');
    expect(c.primary!.id).toBe(plain.secondary!.id);
    expect(c.secondary!.id).toBe(plain.primary!.id);
  });

  it('ignores inactive people and works with nobody configured', () => {
    expect(onCallAt(new Date(), { ...base, people: [] })).toMatchObject({
      primary: null,
      source: 'none',
    });
    const c = onCallAt(new Date('2025-11-18T15:00:00Z'), {
      ...base,
      people: people.map((p) => (p.id === 9 ? p : { ...p, active: p.id === 1 })),
    });
    expect(c.primary!.id).toBe(1);
    expect(c.secondary).toBeNull();
  });
});

describe('escalationLevels', () => {
  it('goes primary → secondary → IT lead and skips missing levels', () => {
    const lead = person(9, { isItLead: true });
    expect(
      escalationLevels({
        weekStart: '',
        primary: person(1),
        secondary: person(2),
        leads: [lead],
        source: 'rotation',
      }).map((l) => l.map((p) => p.id)),
    ).toEqual([[1], [2], [9]]);
    expect(
      escalationLevels({
        weekStart: '',
        primary: person(1),
        secondary: null,
        leads: [lead, person(1, { isItLead: true })],
        source: 'rotation',
      }).map((l) => l.map((p) => p.id)),
    ).toEqual([[1], [9]]);
  });
});
