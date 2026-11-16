import { describe, expect, it } from 'vitest';
import { planIncidentAction, type ActionTarget } from './incident-actions';

const now = new Date('2026-10-14T15:00:00Z');
const open: ActionTarget = { status: 'open', snoozedUntil: null, activeAlerts: 3 };

describe('planIncidentAction', () => {
  it('acknowledges an open incident and records who did it', () => {
    const p = planIncidentAction(open, { action: 'ack', text: 'on my way' }, 'Adam F', now);
    expect(p).toMatchObject({
      ok: true,
      material: false,
      patch: { status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: 'Adam F' },
      event: { type: 'acked', message: 'Acknowledged by Adam F: on my way' },
    });
  });

  it('refuses to acknowledge twice or after resolution', () => {
    expect(
      planIncidentAction({ ...open, status: 'acknowledged' }, { action: 'ack' }, 'a', now),
    ).toEqual({
      ok: false,
      error: 'Already acknowledged.',
    });
    expect(
      planIncidentAction({ ...open, status: 'resolved' }, { action: 'ack' }, 'a', now).ok,
    ).toBe(false);
  });

  it('snoozes only for an offered duration', () => {
    const p = planIncidentAction(open, { action: 'snooze', minutes: 60 }, 'a', now);
    expect(p.ok && p.patch.snoozedUntil?.toISOString()).toBe('2026-10-14T16:00:00.000Z');
    expect(p.ok && p.event.message).toBe('Snoozed for 1 h by a');
    expect(planIncidentAction(open, { action: 'snooze', minutes: 7 }, 'a', now).ok).toBe(false);
  });

  it('cancels a snooze only while it is running', () => {
    const snoozed = { ...open, snoozedUntil: new Date(now.getTime() + 60_000) };
    expect(planIncidentAction(snoozed, { action: 'unsnooze' }, 'a', now).ok).toBe(true);
    const expired = { ...open, snoozedUntil: new Date(now.getTime() - 1) };
    expect(planIncidentAction(expired, { action: 'unsnooze' }, 'a', now).ok).toBe(false);
  });

  it('resolves manually, noting alerts that are still active, and clears the snooze', () => {
    const p = planIncidentAction(
      { ...open, snoozedUntil: new Date(now.getTime() + 60_000) },
      { action: 'resolve' },
      'Adam F',
      now,
    );
    expect(p).toMatchObject({
      ok: true,
      patch: { status: 'resolved', resolvedBy: 'user:Adam F', snoozedUntil: null },
      event: { message: 'Resolved by Adam F (3 alerts were still active in Orion)' },
    });
  });

  it('requires note text and limits its length', () => {
    expect(planIncidentAction(open, { action: 'note', text: '  ' }, 'a', now).ok).toBe(false);
    expect(planIncidentAction(open, { action: 'note', text: 'x'.repeat(4001) }, 'a', now).ok).toBe(
      false,
    );
    expect(
      planIncidentAction(
        { ...open, status: 'closed' },
        { action: 'note', text: 'RMA filed' },
        'a',
        now,
      ),
    ).toMatchObject({ ok: true, patch: {}, event: { type: 'note', message: 'RMA filed' } });
  });

  it('removes an acknowledgement', () => {
    expect(
      planIncidentAction({ ...open, status: 'acknowledged' }, { action: 'unack' }, 'a', now),
    ).toMatchObject({ ok: true, patch: { status: 'open', acknowledgedBy: null } });
  });
});
