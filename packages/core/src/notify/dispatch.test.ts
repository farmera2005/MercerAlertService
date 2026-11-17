import { describe, expect, it } from 'vitest';
import { planDispatch, planEscalation, type DispatchContext } from './dispatch';
import { DEFAULT_ROUTING_RULES } from './routing';
import type { NotifyIncident, Person } from './types';

const T0 = new Date('2026-10-14T14:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const pat: Person = {
  id: 1,
  name: 'Pat',
  phoneE164: '+14195550101',
  pushoverUserKey: null,
  pageVia: 'sms',
  isItLead: false,
  active: true,
  rotationPosition: 1,
};
const sam: Person = {
  ...pat,
  id: 2,
  name: 'Sam',
  phoneE164: null,
  pushoverUserKey: 'u2',
  pageVia: 'pushover',
  rotationPosition: 2,
};
const lee: Person = {
  ...pat,
  id: 3,
  name: 'Lee',
  pageVia: 'both',
  pushoverUserKey: 'u3',
  isItLead: true,
  rotationPosition: null,
};

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    now: T0,
    rules: DEFAULT_ROUTING_RULES.map((r, i) => ({ ...r, id: i + 1 })),
    channels: new Map(
      ['net-critical', 'net-alerts', 'mas-shadow'].map((key) => [
        key,
        { key, name: key, enabled: true, configured: true },
      ]),
    ),
    people: new Map([pat, sam, lee].map((p) => [p.id, p])),
    chain: {
      weekStart: '2026-10-12',
      primary: pat,
      secondary: sam,
      leads: [lee],
      source: 'rotation',
    },
    withinBusinessHours: true,
    quietActive: false,
    quietMinPriority: 'P2',
    shadow: { enabled: false, channelKey: 'mas-shadow', allowPaging: false },
    defaultEscalateAfterMin: 15,
    recentPages: new Map(),
    pageRateLimit: 5,
    providers: { sms: true, pushover: true },
    links: {
      view: 'https://mas/i/1',
      ack: 'https://mas/i/1?do=ack',
      snooze: 'https://mas/i/1?do=snooze',
      short: 'https://mas/i/abc123',
    },
    formatTime: (d) => d.toISOString().slice(11, 16),
    postAiSummary: true,
    ...over,
  };
}

function incident(over: Partial<NotifyIncident> = {}): NotifyIncident {
  return {
    id: 42,
    status: 'open',
    priority: 'P1',
    kind: 'site_outage',
    title: 'Site down — Rockford Elevator',
    summary: 'The WAN edge firewall ROCK-FW01 at Rockford Elevator (Grain) is down.',
    siteId: 4,
    siteName: 'Rockford Elevator',
    affectedSiteIds: [4],
    divisionCode: 'grain',
    divisionName: 'Grain',
    alertCount: 31,
    openedAt: T0,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    snoozedUntil: null,
    snoozedBy: null,
    materialRev: 1,
    inMaintenance: false,
    seeded: false,
    recoveryTargetMin: 240,
    ai: null,
    ...over,
  };
}

const summary = (p: ReturnType<typeof planDispatch>) =>
  p.messages.map((m) => [m.purpose, m.kind, m.recipient, m.suppressReason]);

describe('planDispatch: first announcement', () => {
  it('posts a P1 to net-critical, pages the primary and schedules escalation', () => {
    const p = planDispatch(incident(), null, ctx());
    expect(summary(p)).toEqual([
      ['incident_open', 'teams', '#net-critical', null],
      ['incident_open', 'sms', 'Pat (SMS +1•••0101)', null],
    ]);
    expect(p.scheduleEscalations).toEqual([
      { level: 1, dueAt: at(15) },
      { level: 2, dueAt: at(30) },
    ]);
    expect(p.state).toMatchObject({ pagedAt: T0, pagedPersonIds: [1], baselined: false });
    const sms = p.messages[1]!.payload as { body: string };
    expect(sms.body).toContain(
      'P1 Site down — Rockford Elevator. 31 alerts. Ack: https://mas/i/abc123',
    );
    expect(sms.body.length).toBeLessThanOrEqual(300);
  });

  it('does not page a P2 in business hours, but does after hours', () => {
    expect(summary(planDispatch(incident({ priority: 'P2' }), null, ctx()))).toEqual([
      ['incident_open', 'teams', '#net-critical', null],
    ]);
    const night = planDispatch(
      incident({ priority: 'P2' }),
      null,
      ctx({ withinBusinessHours: false }),
    );
    expect(night.messages.map((m) => m.kind)).toEqual(['teams', 'sms']);
  });

  it('never announces pre-existing incidents, until real alerts join them', () => {
    const seeded = planDispatch(incident({ seeded: true }), null, ctx());
    expect(seeded.messages).toEqual([]);
    expect(seeded.state.baselined).toBe(true);
    const joined = planDispatch(incident({ seeded: false }), seeded.state, ctx());
    expect(joined.messages[0]!.purpose).toBe('incident_open');
  });

  it('records but does not send during maintenance, quiet hours, or for unconfigured channels', () => {
    expect(
      planDispatch(incident({ inMaintenance: true }), null, ctx()).messages.map(
        (m) => m.suppressReason,
      ),
    ).toEqual(['maintenance', 'maintenance']);
    const quiet = ctx({ quietActive: true });
    expect(
      planDispatch(incident({ priority: 'P3' }), null, quiet).messages[0]!.suppressReason,
    ).toBe('quiet_hours');
    expect(planDispatch(incident(), null, quiet).messages[0]!.suppressReason).toBeNull();
    const noWebhook = ctx({
      channels: new Map([
        ['net-critical', { key: 'net-critical', name: 'x', enabled: true, configured: false }],
      ]),
    });
    expect(planDispatch(incident(), null, noWebhook).messages[0]!.suppressReason).toBe(
      'channel_not_configured',
    );
  });

  it('rate-limits pages and reports missing contact details', () => {
    expect(
      planDispatch(incident(), null, ctx({ recentPages: new Map([[1, 5]]) })).messages[1]!
        .suppressReason,
    ).toBe('rate_limited');
    const noPhone = ctx({ chain: { ...ctx().chain, primary: { ...pat, phoneE164: null } } });
    expect(planDispatch(incident(), null, noPhone).messages[1]!.suppressReason).toBe('no_contact');
  });

  it('in shadow mode posts once to the shadow channel and pages nobody', () => {
    const p = planDispatch(
      incident(),
      null,
      ctx({ shadow: { enabled: true, channelKey: 'mas-shadow', allowPaging: false } }),
    );
    expect(summary(p)).toEqual([
      ['incident_open', 'teams', '#mas-shadow (shadow)', null],
      ['incident_open', 'sms', 'Pat (SMS +1•••0101)', 'shadow_mode'],
    ]);
    expect(JSON.stringify(p.messages[0]!.payload)).toContain(
      '**[SHADOW]** for #net-critical · would page Pat (SMS)',
    );
  });
});

describe('planDispatch: changes', () => {
  const opened = planDispatch(incident(), null, ctx());

  it('does nothing when nothing changed', () => {
    const again = planDispatch(incident(), opened.state, ctx({ now: at(1) }));
    expect(again.messages).toEqual([]);
    expect(again.cancelEscalations).toBeNull();
  });

  it('acknowledgement: card update and escalation cancelled', () => {
    const p = planDispatch(
      incident({ status: 'acknowledged', acknowledgedBy: 'Pat' }),
      opened.state,
      ctx({ now: at(3) }),
    );
    expect(summary(p)).toEqual([['incident_update', 'teams', '#net-critical', null]]);
    expect(JSON.stringify(p.messages[0]!.payload)).toContain(
      'INC-42 · Update 1: Acknowledged by Pat',
    );
    expect(p.cancelEscalations).toBe('acknowledged');
  });

  it('resolution: resolved card, and the people who were paged hear it is over', () => {
    const p = planDispatch(
      incident({ status: 'resolved', resolvedAt: at(42), materialRev: 2 }),
      opened.state,
      ctx({ now: at(42) }),
    );
    expect(summary(p)).toEqual([
      ['incident_resolved', 'teams', '#net-critical', null],
      ['incident_resolved', 'sms', 'Pat (SMS +1•••0101)', null],
    ]);
    expect((p.messages[1]!.payload as { body: string }).body).toBe(
      'RESOLVED P1 Site down — Rockford Elevator after 42 min. INC-42 [MAS]',
    );
    expect(p.cancelEscalations).toBe('resolved');
  });

  it('pages when an incident is upgraded to P1', () => {
    const p3 = planDispatch(incident({ priority: 'P3', kind: 'interface' }), null, ctx());
    expect(p3.messages.map((m) => m.recipient)).toEqual(['#net-alerts']);
    const up = planDispatch(incident({ materialRev: 2 }), p3.state, ctx({ now: at(5) }));
    expect(summary(up)).toEqual([
      ['incident_update', 'teams', '#net-critical', null],
      ['incident_update', 'sms', 'Pat (SMS +1•••0101)', null],
    ]);
    expect(JSON.stringify(up.messages[0]!.payload)).toContain('Priority P3 → P1');
    expect(up.scheduleEscalations).toHaveLength(2);
  });

  it('snooze cancels escalation; when it ends unacknowledged the primary is paged again', () => {
    const snoozed = planDispatch(
      incident({ snoozedUntil: at(60), snoozedBy: 'Pat' }),
      opened.state,
      ctx({ now: at(5) }),
    );
    expect(snoozed.cancelEscalations).toBe('snoozed');
    expect(JSON.stringify(snoozed.messages[0]!.payload)).toContain('Snoozed until 15:00 by Pat');
    const ended = planDispatch(
      incident({ snoozedUntil: null }),
      snoozed.state,
      ctx({ now: at(61) }),
    );
    expect(summary(ended).map((m) => m[1])).toEqual(['teams', 'sms']);
    expect(JSON.stringify(ended.messages[0]!.payload)).toContain(
      'Snooze ended, still not acknowledged',
    );
  });

  it('reopening announces it and pages again', () => {
    const resolved = planDispatch(
      incident({ status: 'resolved', resolvedAt: at(20), materialRev: 2 }),
      opened.state,
      ctx({ now: at(20) }),
    );
    const back = planDispatch(incident({ materialRev: 3 }), resolved.state, ctx({ now: at(25) }));
    expect(JSON.stringify(back.messages[0]!.payload)).toContain('Reopened');
    expect(back.messages.map((m) => m.kind)).toEqual(['teams', 'sms']);
  });
});

describe('planDispatch: AI summary follow-up', () => {
  const ai = {
    whatIsAffected: 'The scale house at Rockford Elevator is offline.',
    likelyCause: 'WAN circuit down.',
    confidence: 'medium' as const,
    firstSteps: ['Check the ISP circuit'],
  };
  const opened = planDispatch(incident(), null, ctx());

  it('posts one follow-up card when the first summary arrives, and pages nobody', () => {
    const p = planDispatch(incident({ ai }), opened.state, ctx({ now: at(1) }));
    expect(summary(p)).toEqual([['incident_update', 'teams', '#net-critical', null]]);
    expect(JSON.stringify(p.messages[0]!.payload)).toContain('Update 1: Summary and first steps');
    expect(p.state.aiSummaryPosted).toBe(true);
    expect(planDispatch(incident({ ai }), p.state, ctx({ now: at(2) })).messages).toEqual([]);
  });

  it('does not post a follow-up when switched off, or when the open card already had it', () => {
    const off = planDispatch(incident({ ai }), opened.state, ctx({ postAiSummary: false }));
    expect(off.messages).toEqual([]);
    expect(off.state.aiSummaryPosted).toBe(true); // so the dispatcher stops looking at it
    const withAi = planDispatch(incident({ ai }), null, ctx());
    expect(withAi.state.aiSummaryPosted).toBe(true);
    expect(planDispatch(incident({ ai }), withAi.state, ctx({ now: at(1) })).messages).toEqual([]);
  });

  it('is suppressed like everything else during maintenance', () => {
    const p = planDispatch(incident({ ai, inMaintenance: true }), opened.state, ctx());
    expect(p.messages.map((m) => m.suppressReason)).toEqual(['maintenance']);
  });
});

describe('planEscalation', () => {
  const opened = planDispatch(incident(), null, ctx());

  it('pages the secondary, then the IT lead', () => {
    const l1 = planEscalation(incident(), opened.state, 1, ctx({ now: at(15) }), 15);
    expect(l1.cancelReason).toBeNull();
    expect(l1.messages.map((m) => [m.purpose, m.kind, m.recipient])).toEqual([
      ['escalation', 'teams', '#net-critical'],
      ['escalation', 'pushover', 'Sam (Pushover)'],
    ]);
    expect(JSON.stringify(l1.messages[1]!.payload)).toContain('Not acknowledged by Pat');
    const l2 = planEscalation(incident(), l1.state, 2, ctx({ now: at(30) }), 15);
    expect(l2.messages.slice(1).map((m) => m.recipient)).toEqual([
      'Lee (SMS +1•••0101)',
      'Lee (Pushover)',
    ]);
    expect(l2.state.pagedPersonIds).toEqual([1, 2, 3]);
  });

  it('does not fire once acknowledged, resolved or snoozed', () => {
    expect(
      planEscalation(incident({ status: 'acknowledged' }), opened.state, 1, ctx(), 15).cancelReason,
    ).toBe('acknowledged');
    expect(
      planEscalation(incident({ status: 'resolved' }), opened.state, 1, ctx(), 15).cancelReason,
    ).toBe('resolved');
    expect(
      planEscalation(incident({ snoozedUntil: at(60) }), opened.state, 1, ctx(), 15).cancelReason,
    ).toBe('snoozed');
  });
});
