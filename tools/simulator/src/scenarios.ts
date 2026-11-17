/**
 * Acceptance scenarios for correlation. Each replays a synthetic storm from the mock SWIS through
 * the real pipeline (pollers → Postgres → correlation) on a virtual clock and states what MAS
 * must produce. Dates are chosen to exercise harvest / off-season and business hours.
 */
import type { IncidentKind, IncidentStatus, Priority } from '@mercer/core';

export interface Expectation {
  /** New (non-seeded) incidents opened during the scenario. */
  incidents: number;
  kind: IncidentKind;
  priority: Priority;
  minAlerts?: number;
  finalStatus?: IncidentStatus;
  /** Raw alert raises per incident must be at least this. */
  minNoiseRatio?: number;
  titleIncludes?: string;
  /** Routing with the default rules (shadow mode off, everyone reachable by SMS). */
  notify?: {
    /** Teams channels that received anything. */
    channels: string[];
    /** Somebody was paged (SMS/push other than the "resolved" notice). */
    paged: boolean;
    /** The page escalated to the next person. */
    escalated?: boolean;
  };
}

export interface SimScenario {
  id: string;
  description: string;
  /** Virtual start (UTC). */
  start: string;
  mock: { name: string; params: Record<string, unknown> };
  durationSec: number;
  expect: Expectation;
}

// Wed 14 Oct 2026 10:00 EDT (harvest, business hours); Tue 10 Mar 2026 22:00 EDT (off-season, night)
const HARVEST_DAY = '2026-10-14T14:00:00Z';
const MARCH_NIGHT = '2026-03-11T02:00:00Z';

export const SCENARIOS: SimScenario[] = [
  {
    id: 'wan-down-harvest',
    description: 'Rockford FortiGate down with 30 child alerts, October business hours',
    start: HARVEST_DAY,
    mock: {
      name: 'site-wan-down',
      params: { site: 'ROCK', childAlerts: 30, recoverAfterSec: 600 },
    },
    durationSec: 1500,
    expect: {
      incidents: 1,
      kind: 'site_outage',
      priority: 'P1',
      minAlerts: 31,
      finalStatus: 'resolved',
      minNoiseRatio: 30,
      titleIncludes: 'Site down — Rockford Elevator',
      // Nobody acknowledges in the simulator, so the page escalates at 15 min, before recovery.
      notify: { channels: ['net-critical'], paged: true, escalated: true },
    },
  },
  {
    id: 'wan-down-march-night',
    description:
      'The same outage in March after hours is P2, still paged after hours, and escalates when nobody acknowledges',
    start: MARCH_NIGHT,
    mock: { name: 'site-wan-down', params: { site: 'ROCK', childAlerts: 30 } },
    durationSec: 1200,
    expect: {
      incidents: 1,
      kind: 'site_outage',
      priority: 'P2',
      minAlerts: 31,
      minNoiseRatio: 30,
      notify: { channels: ['net-critical'], paged: true, escalated: true },
    },
  },
  {
    id: 'flapping-ap',
    description: 'ROCK-AP01 bounces six times in six minutes',
    start: HARVEST_DAY,
    mock: { name: 'flapping-ap', params: { node: 'ROCK-AP01', flaps: 6, periodSec: 60 } },
    durationSec: 420,
    expect: {
      incidents: 1,
      kind: 'flapping',
      priority: 'P3',
      titleIncludes: 'ROCK-AP01 flapping',
      notify: { channels: ['net-alerts'], paged: false },
    },
  },
  {
    id: 'ups-on-battery-harvest',
    description: 'UPS on battery at Coldwater (harvest-critical grain site) during harvest',
    start: HARVEST_DAY,
    mock: { name: 'ups-on-battery', params: { site: 'COLD', recoverAfterSec: 900 } },
    durationSec: 1500,
    expect: {
      incidents: 1,
      kind: 'ups_power',
      priority: 'P2',
      finalStatus: 'resolved',
      titleIncludes: 'UPS on battery',
      notify: { channels: ['net-critical'], paged: false },
    },
  },
  {
    id: 'hq-wan-saturation',
    description: 'Slow-burn saturation of the HQ FortiGate WAN link over 30 minutes',
    start: HARVEST_DAY,
    mock: {
      name: 'interface-saturation',
      params: {
        node: 'CEL-FW01',
        iface: 'wan1',
        fromPct: 60,
        toPct: 98,
        durationSec: 1800,
        steps: 10,
      },
    },
    durationSec: 1900,
    expect: {
      incidents: 1,
      kind: 'interface',
      priority: 'P3',
      titleIncludes: 'High interface utilization',
      notify: { channels: ['net-alerts'], paged: false },
    },
  },
  {
    id: 'swis-down',
    description: 'SolarWinds SWIS returns 503 for five minutes',
    start: HARVEST_DAY,
    mock: { name: 'swis-down', params: { mode: '503', durationSec: 300 } },
    durationSec: 900,
    expect: {
      incidents: 1,
      kind: 'monitoring_source_down',
      priority: 'P1',
      finalStatus: 'resolved',
      titleIncludes: 'SolarWinds monitoring unavailable',
      notify: { channels: ['net-critical'], paged: true },
    },
  },
];
