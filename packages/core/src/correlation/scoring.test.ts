import { describe, expect, it } from 'vitest';
import { applyAiAdjustment, scoreIncident, type ScoreInput } from './scoring';
import type { SeasonPeriod, SiteInfo } from './types';

const HARVEST: SeasonPeriod = {
  id: 1,
  name: 'Harvest',
  kind: 'harvest',
  startMd: '09-01',
  endMd: '12-15',
  year: null,
  multiplier: 1.5,
  divisions: null,
  harvestCriticalOnly: false,
  enabled: true,
};
const cfg = {
  p1Min: 70,
  p2Min: 50,
  p3Min: 30,
  tierCritical: 1.4,
  tierHigh: 1.2,
  harvestGrainMult: 1.2,
  afterHoursMult: 0.8,
  recoveryHarvestMin: 240,
  recoveryDefaultMin: 480,
};
const OFFICE = { days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' };
const rockford: SiteInfo = {
  id: 2,
  name: 'Rockford Elevator',
  divisionCodes: ['grain'],
  divisionNames: ['Grain'],
  tier: 'high',
  harvestCritical: true,
  businessHours: OFFICE,
  harvestHours: { days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '22:00' },
};
const hq: SiteInfo = {
  id: 1,
  name: 'Celina HQ',
  divisionCodes: ['corporate'],
  divisionNames: ['Corporate'],
  tier: 'critical',
  harvestCritical: false,
  businessHours: OFFICE,
  harvestHours: null,
};
const standard: SiteInfo = {
  ...rockford,
  id: 3,
  name: 'Ohio City',
  divisionCodes: ['agronomy'],
  divisionNames: ['Agronomy'],
  tier: 'standard',
  harvestCritical: false,
};

// Wed 14 Oct 2026 10:00 EDT, Tue 10 Mar 2026 22:00 EDT
const OCT_DAY = new Date('2026-10-14T14:00:00Z');
const MAR_NIGHT = new Date('2026-03-11T02:00:00Z');

const base = (o: Partial<ScoreInput>): ScoreInput => ({
  kind: 'device_down',
  downRoles: [],
  affectedNodes: 0,
  interfaceOnCoreRole: false,
  firewallDown: false,
  severity: 'critical',
  site: rockford,
  seasons: [HARVEST],
  now: OCT_DAY,
  timeZone: 'America/New_York',
  cfg,
  ...o,
});

describe('scoreIncident', () => {
  it('makes a harvest-critical site outage in October P1 with a 4 h target', () => {
    const r = scoreIncident(
      base({ kind: 'site_outage', downRoles: ['firewall'], firewallDown: true, affectedNodes: 7 }),
    );
    expect(r.priority).toBe('P1');
    expect(r.score).toBe(126);
    expect(r.recoveryTargetMin).toBe(240);
    expect(r.factors.explanation.join(' ')).toMatch(/Harvest ×1.5/);
  });
  it('scores the same outage in March after hours as P2 with an 8 h target', () => {
    const r = scoreIncident(
      base({ kind: 'site_outage', downRoles: ['firewall'], firewallDown: true, now: MAR_NIGHT }),
    );
    expect(r.score).toBe(67.2);
    expect(r.priority).toBe('P2');
    expect(r.recoveryTargetMin).toBe(480);
  });
  it('does not discount harvest-critical outages after hours during harvest', () => {
    const lateOct = new Date('2026-10-15T03:00:00Z'); // 23:00 EDT, after harvest hours
    const r = scoreIncident(
      base({ kind: 'site_outage', downRoles: ['firewall'], firewallDown: true, now: lateOct }),
    );
    expect(r.factors.timeMult).toBe(1);
    expect(r.priority).toBe('P1');
  });
  it('keeps a single access point low, a little higher in harvest', () => {
    expect(
      scoreIncident(
        base({ downRoles: ['access_point'], affectedNodes: 1, site: standard, seasons: [] }),
      ).priority,
    ).toBe('P4');
    expect(scoreIncident(base({ downRoles: ['access_point'], affectedNodes: 1 })).priority).toBe(
      'P3',
    );
  });
  it('makes scale systems at a harvest-critical site urgent in harvest only', () => {
    expect(scoreIncident(base({ downRoles: ['scale_system'], affectedNodes: 1 })).priority).toBe(
      'P1',
    );
    expect(
      scoreIncident(
        base({
          downRoles: ['scale_system'],
          affectedNodes: 1,
          now: new Date('2026-03-10T15:00:00Z'),
        }),
      ).priority,
    ).toBe('P2');
  });
  it('scores a UPS on battery at a grain site in harvest as P2', () => {
    expect(scoreIncident(base({ kind: 'ups_power', severity: 'serious' })).priority).toBe('P2');
  });
  it('scores HQ WAN saturation (warning on a firewall interface) as P3', () => {
    const r = scoreIncident(
      base({ kind: 'interface', interfaceOnCoreRole: true, severity: 'warning', site: hq }),
    );
    expect(r.score).toBe(33.6);
    expect(r.priority).toBe('P3');
  });
  it('fixes monitoring-source-down at P1', () => {
    expect(scoreIncident(base({ kind: 'monitoring_source_down', site: null })).priority).toBe('P1');
  });
  it('applies the grain multiplier to grain sites that are not harvest-critical', () => {
    const grainStd = { ...standard, divisionCodes: ['grain'] };
    expect(
      scoreIncident(base({ downRoles: ['switch'], affectedNodes: 1, site: grainStd })).factors
        .seasonMult,
    ).toBe(1.2);
    const shared = { ...standard, divisionCodes: ['agronomy', 'grain'] };
    expect(
      scoreIncident(base({ downRoles: ['switch'], affectedNodes: 1, site: shared })).factors
        .seasonMult,
    ).toBe(1.2);
  });
  it('applies a season for one division to a site that has it among others', () => {
    const spring: SeasonPeriod = {
      ...HARVEST,
      id: 2,
      name: 'Spring application',
      kind: 'high_risk',
      startMd: '03-01',
      endMd: '05-31',
      multiplier: 1.3,
      divisions: ['agronomy'],
    };
    const at = (codes: string[]) =>
      scoreIncident(
        base({
          downRoles: ['switch'],
          affectedNodes: 1,
          site: { ...standard, divisionCodes: codes },
          seasons: [spring],
          now: new Date('2026-04-15T14:00:00Z'),
        }),
      ).factors.seasonMult;
    expect(at(['grain', 'agronomy'])).toBe(1.3);
    expect(at(['grain'])).toBe(1);
  });
});

describe('applyAiAdjustment guardrail', () => {
  const plain = {
    kind: 'device_down' as const,
    firewallDown: false,
    harvestCriticalInHarvest: false,
  };
  it('clamps to one level', () => {
    expect(applyAiAdjustment('P3', 3, plain)).toMatchObject({ priority: 'P2', adjust: 1 });
    expect(applyAiAdjustment('P3', -2, plain)).toMatchObject({ priority: 'P4', adjust: -1 });
    expect(applyAiAdjustment('P1', 1, plain).priority).toBe('P1');
  });
  it('never lowers protected incidents below P2', () => {
    expect(applyAiAdjustment('P2', -1, { ...plain, kind: 'site_outage' })).toMatchObject({
      priority: 'P2',
      adjust: 0,
    });
    expect(applyAiAdjustment('P1', -1, { ...plain, firewallDown: true })).toMatchObject({
      priority: 'P2',
      adjust: -1,
    });
    const hc = applyAiAdjustment('P3', -1, { ...plain, harvestCriticalInHarvest: true });
    expect(hc).toMatchObject({ priority: 'P3', adjust: 0 });
    expect(hc.guardrail).toMatch(/below P2/);
    expect(applyAiAdjustment('P3', 1, { ...plain, harvestCriticalInHarvest: true }).priority).toBe(
      'P2',
    );
  });
  it('never touches monitoring-source-down', () => {
    expect(applyAiAdjustment('P1', -1, { ...plain, kind: 'monitoring_source_down' }).priority).toBe(
      'P1',
    );
  });
});
