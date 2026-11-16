import { describe, expect, it } from 'vitest';
import { buildTopologyGraph, countStateChanges, rootOf } from './graph';
import type { DeviceRole } from '../mapping';
import type { StatusNorm } from '../orion';

const roles = new Map<number, DeviceRole>([
  [1, 'firewall'],
  [2, 'switch'],
  [3, 'access_point'],
  [4, 'scale_system'],
  [10, 'core_switch'],
]);

describe('topology graph and roots', () => {
  const graph = buildTopologyGraph({
    dependencies: [
      { parentNodeId: 1, childNodeId: null, parentContainerId: null, childContainerId: 100 },
    ],
    groupMembers: new Map([[100, [2, 3, 4]]]),
    connections: [
      { srcNodeId: 3, destNodeId: 2 },
      { srcNodeId: 4, destNodeId: 2 },
      { srcNodeId: 2, destNodeId: 1 },
    ],
    roles,
  });
  const ctx = (status: Record<number, StatusNorm>, fwBySite: number | null = null) => ({
    graph,
    statusOf: (id: number) => status[id],
    isDown: (id: number) => status[id] === 'down',
    roleOf: (id: number) => roles.get(id) ?? 'other',
    siteFirewallDown: () => fwBySite,
  });

  it('expands group dependencies and orients topology links by role', () => {
    expect([...graph.parents.get(3)!].sort()).toEqual([1, 2]);
    expect([...graph.parents.get(2)!]).toEqual([1]);
    expect(graph.parents.get(1)).toBeUndefined();
  });
  it('walks up to the furthest down device', () => {
    expect(rootOf(3, ctx({ 1: 'down', 2: 'unreachable', 3: 'unreachable' }))).toBe(1);
    expect(rootOf(3, ctx({ 1: 'up', 2: 'down', 3: 'unreachable' }))).toBe(2);
    expect(rootOf(2, ctx({ 1: 'up', 2: 'down' }))).toBe(2);
  });
  it('falls back to the site firewall, else null for unexplained unreachables', () => {
    expect(rootOf(10, ctx({ 10: 'down' }, 1))).toBe(1);
    expect(rootOf(10, ctx({ 10: 'unreachable' }))).toBeNull();
  });
});

describe('countStateChanges', () => {
  const t = (min: number, bad: boolean) => ({ at: new Date(Date.UTC(2026, 9, 14, 14, min)), bad });
  it('collapses same-direction changes (status + alert for one event)', () => {
    const now = new Date(Date.UTC(2026, 9, 14, 14, 15));
    expect(
      countStateChanges(
        [t(1, true), t(1, true), t(2, false), t(2, false), t(3, true), t(4, false)],
        now,
        20,
      ),
    ).toBe(4);
    expect(countStateChanges([t(1, true), t(2, false)], now, 20)).toBe(2);
    const later = new Date(Date.UTC(2026, 9, 14, 14, 30));
    expect(countStateChanges([t(1, true), t(2, false), t(25, true)], later, 20)).toBe(1);
  });
});
