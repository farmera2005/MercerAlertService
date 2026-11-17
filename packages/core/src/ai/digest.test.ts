import { describe, expect, it } from 'vitest';
import {
  digestCard,
  digestMarkdown,
  templateDigest,
  unknownCitations,
  type DailyFacts,
  type WeeklyFacts,
} from './digest';
import { digestOutput } from './schemas';

const noise = { rawAlerts: 120, incidents: 6, ratio: 20, teamsPosts: 9, pages: 2, suppressed: 1 };
const daily: DailyFacts = {
  kind: 'daily',
  timeZone: 'America/New_York',
  periodStart: '2026-10-13 07:00',
  periodEnd: '2026-10-14 07:00',
  inHarvest: true,
  overnight: [
    {
      id: 41,
      title: 'Access point down — Celina Agronomy',
      priority: 'P4',
      status: 'resolved',
      site: 'Celina Agronomy',
      openedAt: '2026-10-13 22:10',
      durationMin: 12,
      alertCount: 1,
      acknowledgedBy: null,
    },
    {
      id: 42,
      title: 'Site down — Rockford Elevator',
      priority: 'P1',
      status: 'open',
      site: 'Rockford Elevator',
      openedAt: '2026-10-14 02:05',
      durationMin: null,
      alertCount: 31,
      acknowledgedBy: null,
    },
  ],
  stillOpen: [],
  flapping: [{ node: 'MERC-SW03', site: 'Mercer HQ', changes: 9 }],
  busiestLinks: [],
  recurring: [{ subject: 'ROCK-FW01', site: 'Rockford Elevator', incidents: 3, lastId: 42 }],
  noise,
};
daily.stillOpen = [daily.overnight[1]!];

describe('templateDigest (daily)', () => {
  it('leads with an open P1 and orders incidents by urgency', () => {
    const d = templateDigest(daily);
    expect(digestOutput.safeParse(d).success).toBe(true);
    expect(d.headline).toBe('1 P1 incident still open: INC-42 Site down — Rockford Elevator');
    expect(d.sections.map((s) => s.title)).toEqual([
      'Overnight',
      'Still open',
      'Flapping',
      'Recurring',
      'Noise',
    ]);
    expect(d.sections[0]!.bullets[0]).toBe(
      'INC-42 P1 Site down — Rockford Elevator: opened 2026-10-14 02:05, not acknowledged',
    );
    expect(d.sections.at(-1)!.bullets[0]).toContain('noise ratio 20:1');
    expect(unknownCitations(d, daily)).toEqual([]);
  });

  it('says so on a quiet night', () => {
    const quiet = { ...daily, overnight: [], stillOpen: [], flapping: [], recurring: [] };
    expect(templateDigest(quiet).headline).toBe('Quiet night: no new incidents.');
  });
});

describe('digest checks and rendering', () => {
  it('flags incident ids that are not in the facts', () => {
    const content = {
      headline: 'INC-42 is open',
      sections: [{ title: 'Overnight', bullets: ['INC-41 resolved', 'INC-99 invented'] }],
    };
    expect(unknownCitations(content, daily)).toEqual([99]);
  });

  it('renders markdown and a Teams card with the deterministic fact table', () => {
    const d = templateDigest(daily);
    const md = digestMarkdown(d, daily, 'template');
    expect(md).toContain('# Network digest · 2026-10-14');
    expect(md).toContain('| Noise ratio | 20:1 (120 alerts → 6) |');
    const card = JSON.stringify(digestCard(d, daily, 'ai', 'https://mas/digests/1'));
    expect(card).toContain('Written by Claude from MAS data.');
    expect(card).toContain('"title":"Pages sent","value":"2"');
  });
});

describe('templateDigest (weekly)', () => {
  const weekly: WeeklyFacts = {
    kind: 'weekly',
    timeZone: 'America/New_York',
    periodStart: '2026-10-05',
    periodEnd: '2026-10-12',
    totals: { incidents: 14, p1: 1, p2: 3, medianAckMin: 6, medianResolveMin: 38 },
    repeatOffenders: [
      {
        subject: 'ROCK-FW01',
        site: 'Rockford Elevator',
        incidents: 4,
        downMinutes: 95,
        incidentIds: [30, 33, 41],
      },
    ],
    worseningSites: [
      {
        site: 'Rockford Elevator',
        incidents: 5,
        previousIncidents: 1,
        downMinutes: 120,
        previousDownMinutes: 10,
      },
    ],
    capacity: [
      {
        node: 'MERC-FW01',
        interface: 'wan1',
        site: 'Mercer HQ',
        p95UtilPct: 86,
        peakUtilPct: 99,
        daysOver80: 4,
      },
    ],
    noisyRules: [
      {
        alertName: 'High CPU',
        raises: 220,
        shortLivedPct: 91,
        medianDurationMin: 2,
        inIncidents: 0,
        reasons: ['91% clear within 5 min', 'never part of an incident above P4'],
      },
    ],
    noise,
    previousNoise: { ...noise, ratio: 15 },
  };

  it('covers repeat offenders, worsening sites, capacity and noisy rules', () => {
    const d = templateDigest(weekly);
    expect(d.headline).toBe(
      'Rockford Elevator is getting worse: 5 incidents this week vs 1 last week.',
    );
    expect(d.sections.map((s) => s.title)).toEqual([
      'Repeat offenders',
      'Getting worse',
      'Capacity',
      'Orion rules to review',
      'Noise',
    ]);
    expect(d.sections[3]!.bullets[0]).toBe(
      '"High CPU": 220 raises; 91% clear within 5 min; never part of an incident above P4',
    );
    expect(unknownCitations(d, weekly)).toEqual([]);
  });
});
