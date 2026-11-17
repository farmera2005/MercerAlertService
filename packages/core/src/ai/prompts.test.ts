import { describe, expect, it } from 'vitest';
import { describeHours, incidentSummaryPrompt, stableJson, stablePrefix } from './prompts';

const sites = [
  {
    code: 'ROCK',
    name: 'Rockford Elevator',
    division: 'Grain',
    city: 'Rockford',
    tier: 'critical' as const,
    harvestCritical: true,
    hours: 'Mon–Fri 07:00–17:00',
    harvestHours: 'Every day 06:00–22:00',
    ownerGroup: null,
  },
  {
    code: 'CEL',
    name: 'Celina Agronomy',
    division: 'Agronomy',
    city: 'Celina',
    tier: 'standard' as const,
    harvestCritical: false,
    hours: 'Mon–Fri 07:00–17:00',
    harvestHours: null,
    ownerGroup: null,
  },
];

describe('prompt builders', () => {
  it('serializes with sorted keys so equal data is byte-identical', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it('builds the same cached prefix whatever order the sites come in', () => {
    const a = stablePrefix('Spectrum cable at elevators.', sites);
    const b = stablePrefix('Spectrum cable at elevators.', [...sites].reverse());
    expect(a).toBe(b);
    expect(a).toContain('## Notes from the network team\nSpectrum cable at elevators.');
    expect(a.indexOf('"code":"CEL"')).toBeLessThan(a.indexOf('"code":"ROCK"'));
    expect(stablePrefix('', sites)).not.toContain('Notes from the network team');
  });

  it('keeps volatile data out of the prefix', () => {
    const prefix = stablePrefix('', sites);
    const p = incidentSummaryPrompt(prefix, { id: 42 } as never, null);
    expect(p.stable).toBe(prefix);
    expect(p.user).toBe('<incident>\n{"id":42}\n</incident>');
    expect(p.task).toContain('"First summary."');
  });

  it('describes business hours compactly', () => {
    expect(describeHours({ days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' })).toBe(
      'Mon–Fri 07:00–17:00',
    );
    expect(describeHours({ days: [1, 3], start: '08:00', end: '12:00' })).toBe(
      'Mon, Wed 08:00–12:00',
    );
    expect(describeHours({ days: [1, 2, 3, 4, 5, 6, 7], start: '06:00', end: '22:00' })).toBe(
      'Every day 06:00–22:00',
    );
  });
});
