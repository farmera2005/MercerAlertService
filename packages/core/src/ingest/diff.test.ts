import { describe, expect, it } from 'vitest';
import { diffActiveAlerts, diffStatuses, removedIds } from './diff';

const a = (alertActiveId: number, alertObjectId: number, acknowledged = false) => ({
  alertActiveId,
  alertObjectId,
  acknowledged,
});

describe('diffActiveAlerts', () => {
  it('detects raise, clear and ack changes', () => {
    const changes = diffActiveAlerts([a(1, 10), a(2, 20)], [a(2, 20, true), a(3, 30)]);
    expect(changes).toEqual([
      { change: 'acked', alertActiveId: 2, alertObjectId: 20 },
      { change: 'raised', alertActiveId: 3, alertObjectId: 30 },
      { change: 'cleared', alertActiveId: 1, alertObjectId: 10 },
    ]);
  });
  it('collapses clear+raise of the same alert object into one retrigger', () => {
    expect(diffActiveAlerts([a(1, 10)], [a(5, 10)])).toEqual([
      { change: 'retriggered', alertActiveId: 5, alertObjectId: 10, previousAlertActiveId: 1 },
    ]);
  });
  it('is a no-op for identical snapshots', () => {
    expect(diffActiveAlerts([a(1, 10)], [a(1, 10)])).toEqual([]);
  });
  it('treats everything as raised on an empty previous snapshot', () => {
    expect(diffActiveAlerts([], [a(1, 10), a(2, 20)]).map((c) => c.change)).toEqual([
      'raised',
      'raised',
    ]);
  });
});

describe('diffStatuses', () => {
  const prev = new Map([
    [1, { statusNorm: 'up' as const, status: 1 }],
    [2, { statusNorm: 'down' as const, status: 2 }],
  ]);
  it('reports changes and only unhealthy new entities', () => {
    const out = diffStatuses(prev, [
      { id: 1, statusNorm: 'down', status: 2 },
      { id: 2, statusNorm: 'down', status: 2 },
      { id: 3, statusNorm: 'up', status: 1 },
      { id: 4, statusNorm: 'unreachable', status: 12 },
    ]);
    expect(out).toEqual([
      { id: 1, from: 'up', to: 'down', fromCode: 1, toCode: 2, isNew: false },
      { id: 4, from: null, to: 'unreachable', fromCode: null, toCode: 12, isNew: true },
    ]);
  });
  it('finds removed ids', () => {
    expect(removedIds(prev, [{ id: 2 }])).toEqual([1]);
  });
});
