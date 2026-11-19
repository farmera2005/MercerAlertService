import { describe, expect, it } from 'vitest';
import { parseQuietHours, quietHoursActive } from './quiet';
import { SMS_MAX, pushoverPayload, smsText, teamsCard } from './messages';
import type { NotifyIncident } from './types';

const now = new Date('2026-10-14T14:30:00Z');
const inc: NotifyIncident = {
  id: 7,
  status: 'open',
  priority: 'P1',
  kind: 'site_outage',
  title: 'Site down — Rockford Elevator',
  summary: 'The WAN edge firewall is down.',
  siteId: 4,
  siteName: 'Rockford Elevator',
  affectedSiteIds: [4],
  divisionCodes: ['grain'],
  divisionNames: ['Grain'],
  alertCount: 31,
  openedAt: new Date('2026-10-14T14:00:00Z'),
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
};
const links = { view: 'v', ack: 'a', snooze: 's', short: 'https://mas.example/i/K7Q2M9' };

describe('teamsCard', () => {
  it('adds the AI summary (except on the resolved card)', () => {
    const ai = {
      whatIsAffected: 'Scale house and office at Rockford Elevator are offline.',
      likelyCause: 'The ISP circuit: the firewall went down first.',
      confidence: 'medium' as const,
      firstSteps: ['Check the circuit with the ISP', 'Call the site about power'],
    };
    const open = JSON.stringify(teamsCard({ ...inc, ai }, { kind: 'open', links, now }));
    expect(open).toContain('Likely cause** (medium confidence)');
    expect(open).toContain('1. Check the circuit with the ISP');
    const done = JSON.stringify(
      teamsCard({ ...inc, ai, status: 'resolved' }, { kind: 'resolved', links, now }),
    );
    expect(done).not.toContain('Likely cause');
  });

  it('is a Workflows message with an Adaptive Card, facts and dashboard buttons', () => {
    const card = teamsCard(inc, { kind: 'open', links, now });
    expect(card.type).toBe('message');
    const c = card.attachments[0]!.content;
    expect(c).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
    expect(JSON.stringify(c.body)).toContain('"title":"Open for","value":"30 min"');
    expect(
      (c.actions as Array<{ title: string; type: string }>).map((a) => [a.type, a.title]),
    ).toEqual([
      ['Action.OpenUrl', 'View'],
      ['Action.OpenUrl', 'Acknowledge'],
      ['Action.OpenUrl', 'Snooze'],
    ]);
  });

  it('drops the Acknowledge button once acknowledged and all actions but View once resolved', () => {
    const acked = teamsCard(
      { ...inc, status: 'acknowledged', acknowledgedBy: 'Pat' },
      { kind: 'update', links, now },
    );
    expect(acked.attachments[0]!.content.actions).toHaveLength(2);
    const done = teamsCard(
      { ...inc, status: 'resolved', resolvedAt: now },
      { kind: 'resolved', links, now },
    );
    expect(done.attachments[0]!.content.actions).toHaveLength(1);
    expect(JSON.stringify(done)).toContain('RESOLVED · P1');
  });
});

describe('SMS and Pushover', () => {
  it('keeps SMS under 300 characters even with a very long title', () => {
    const long = { ...inc, title: 'X'.repeat(400) };
    const t = smsText(long, { kind: 'page', link: links.short, now });
    expect(t.length).toBe(SMS_MAX);
    expect(t.endsWith(`Ack: ${links.short} [MAS]`)).toBe(true);
  });

  it('marks escalations and uses high Pushover priority for pages only', () => {
    expect(
      smsText(inc, { kind: 'escalation', link: links.short, now, escalatedFrom: 'Pat' }),
    ).toMatch(/^ESCALATED \(no ack from Pat\) P1 Site down/);
    expect(pushoverPayload(inc, { kind: 'page', link: links.short, now }).priority).toBe(1);
    expect(pushoverPayload(inc, { kind: 'resolved', link: links.short, now }).priority).toBe(0);
  });
});

describe('quiet hours', () => {
  it('parses windows and handles overnight ranges', () => {
    const w = parseQuietHours('22:00-06:00');
    expect(w).toEqual({ start: '22:00', end: '06:00' });
    expect(parseQuietHours('')).toBeNull();
    expect(() => parseQuietHours('10pm-6am')).toThrow();
    // 23:30 and 05:00 Eastern are quiet; 12:00 is not.
    expect(quietHoursActive(new Date('2026-10-15T03:30:00Z'), w, 'America/New_York')).toBe(true);
    expect(quietHoursActive(new Date('2026-10-15T09:00:00Z'), w, 'America/New_York')).toBe(true);
    expect(quietHoursActive(new Date('2026-10-15T16:00:00Z'), w, 'America/New_York')).toBe(false);
  });
});
