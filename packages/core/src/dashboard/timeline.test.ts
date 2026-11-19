import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';

const t = (s: string) => new Date(`2026-10-14T14:${s}:00Z`);

describe('buildTimeline', () => {
  it('merges MAS decisions with Orion facts in time order, cause first', () => {
    const out = buildTimeline({
      incidentEvents: [
        { at: t('01'), type: 'opened', actor: 'system', message: 'P1 · Site down — Rockford' },
        { at: t('05'), type: 'acked', actor: 'user:Adam F', message: 'Acknowledged by Adam F' },
        { at: t('20'), type: 'resolved', actor: 'system', message: 'All alerts cleared' },
      ],
      transitions: [
        {
          observedAt: t('01'),
          sourceAt: null,
          kind: 'node',
          change: 'status',
          fromState: 'up',
          toState: 'down',
          label: 'ROCK-FW01',
        },
        {
          observedAt: t('02'),
          sourceAt: t('00'),
          kind: 'alert',
          change: 'raised',
          fromState: null,
          toState: 'active',
          label: 'ROCK-SW01',
          alertName: 'Node is down',
        },
        {
          observedAt: t('15'),
          sourceAt: null,
          kind: 'alert',
          change: 'cleared',
          fromState: 'active',
          toState: 'cleared',
          label: 'ROCK-SW01',
          alertName: 'Node is down',
        },
      ],
      orionEvents: [
        { eventTime: t('03'), eventTypeName: 'Node Down', message: 'ROCK-AP01 is down' },
      ],
      alertHistory: [
        { at: t('04'), eventType: 0, message: null, accountId: null, label: 'ROCK-SW01' },
        { at: t('06'), eventType: 2, message: 'looking', accountId: 'jsmith', label: 'ROCK-SW01' },
      ],
    });
    expect(out.map((e) => [e.source, e.tone, e.text])).toEqual([
      ['alert', 'bad', 'Node is down raised — ROCK-SW01'],
      ['status', 'bad', 'ROCK-FW01: up → down'],
      ['mas', 'bad', 'P1 · Site down — Rockford'],
      ['orion', 'bad', 'Node Down: ROCK-AP01 is down'],
      ['mas', 'user', 'Acknowledged by Adam F'],
      ['orion', 'user', 'Acknowledged in Orion — ROCK-SW01: looking'],
      ['alert', 'ok', 'Node is down cleared — ROCK-SW01'],
      ['mas', 'ok', 'All alerts cleared'],
    ]);
    expect(out[4]!.actor).toBe('Adam F');
  });

  it("skips the acks and notes MAS itself wrote to Orion, but keeps people's", () => {
    const out = buildTimeline({
      incidentEvents: [],
      transitions: [],
      orionEvents: [],
      alertHistory: [
        {
          at: new Date(Date.UTC(2026, 9, 14, 14, 1)),
          eventType: 2,
          message: 'Acknowledged in MercerAlertService by Adam F (INC-7)',
          accountId: 'svc-mas-rw',
          label: 'ROCK-SW01',
        },
        {
          at: new Date(Date.UTC(2026, 9, 14, 14, 2)),
          eventType: 3,
          message: 'Fiber cut, Spectrum ticket 123\n— Adam F in MercerAlertService (INC-7)',
          accountId: 'svc-mas-rw',
          label: 'ROCK-SW01',
        },
        {
          at: new Date(Date.UTC(2026, 9, 14, 14, 3)),
          eventType: 3,
          message: 'Called the elevator manager',
          accountId: 'jsmith',
          label: 'ROCK-SW01',
        },
      ],
    });
    expect(out.map((e) => e.text)).toEqual([
      'Note in Orion — ROCK-SW01: Called the elevator manager',
    ]);
  });

  it('keeps the most recent entries when over the limit', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 14, 14, i)),
      type: 'member_added',
      actor: 'system',
      message: `e${i}`,
    }));
    const out = buildTimeline(
      { incidentEvents: events, transitions: [], orionEvents: [], alertHistory: [] },
      3,
    );
    expect(out.map((e) => e.text)).toEqual(['e7', 'e8', 'e9']);
  });
});
