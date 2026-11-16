import type { DeviceRole } from '../mapping';
import type { StatusNorm } from '../orion';
import type { StateChange, TopologyGraph } from './types';

/** Upstream-ness of a role, used to orient topology links and choose roots. */
export const ROLE_RANK: Readonly<Record<DeviceRole, number>> = {
  firewall: 6,
  router: 5,
  core_switch: 5,
  switch: 4,
  server: 2,
  scale_system: 2,
  ups: 2,
  access_point: 1,
  other: 1,
};

export interface GraphInput {
  dependencies: ReadonlyArray<{
    parentNodeId: number | null;
    childNodeId: number | null;
    parentContainerId: number | null;
    childContainerId: number | null;
  }>;
  /** containerId → member node IDs. */
  groupMembers: ReadonlyMap<number, readonly number[]>;
  connections: ReadonlyArray<{ srcNodeId: number; destNodeId: number }>;
  roles: ReadonlyMap<number, DeviceRole>;
}

/**
 * Build child → parents. Orion dependencies are authoritative (a parent group's members are not
 * expanded: "group is down" semantics are ambiguous). Topology links are oriented by role rank;
 * links between equal ranks carry no direction and are ignored.
 */
export function buildTopologyGraph(input: GraphInput): TopologyGraph {
  const parents = new Map<number, Set<number>>();
  const add = (child: number, parent: number) => {
    if (child === parent) return;
    let s = parents.get(child);
    if (!s) parents.set(child, (s = new Set()));
    s.add(parent);
  };
  for (const d of input.dependencies) {
    if (d.parentNodeId === null) continue;
    if (d.childNodeId !== null) add(d.childNodeId, d.parentNodeId);
    if (d.childContainerId !== null) {
      for (const m of input.groupMembers.get(d.childContainerId) ?? []) add(m, d.parentNodeId);
    }
  }
  for (const c of input.connections) {
    const a = ROLE_RANK[input.roles.get(c.srcNodeId) ?? 'other'];
    const b = ROLE_RANK[input.roles.get(c.destNodeId) ?? 'other'];
    if (a > b) add(c.destNodeId, c.srcNodeId);
    else if (b > a) add(c.srcNodeId, c.destNodeId);
  }
  return { parents };
}

export interface RootContext {
  graph: TopologyGraph;
  statusOf(nodeId: number): StatusNorm | undefined;
  /** Down by status or by an active node-down alert that arrived before the node poll. */
  isDown(nodeId: number): boolean;
  roleOf(nodeId: number): DeviceRole;
  /** The down WAN-edge firewall at this node's site, if any (fallback when no graph edges exist). */
  siteFirewallDown(nodeId: number): number | null;
}

/**
 * Walk upstream through down/unreachable parents to the furthest device that is actually down.
 * Returns that device, or the node itself if it is down with nothing down above it, or the site's
 * down firewall, or null (unreachable with no visible cause).
 */
export function rootOf(start: number, ctx: RootContext): number | null {
  const seen = new Set<number>([start]);
  let cur = start;
  let lastDown: number | null = ctx.isDown(start) ? start : null;
  for (;;) {
    const ups = [...(ctx.graph.parents.get(cur) ?? [])].filter(
      (p) => !seen.has(p) && (ctx.isDown(p) || ctx.statusOf(p) === 'unreachable'),
    );
    if (!ups.length) break;
    ups.sort(
      (a, b) =>
        Number(ctx.isDown(b)) - Number(ctx.isDown(a)) ||
        ROLE_RANK[ctx.roleOf(b)] - ROLE_RANK[ctx.roleOf(a)],
    );
    cur = ups[0]!;
    seen.add(cur);
    if (ctx.isDown(cur)) lastDown = cur;
  }
  if (lastDown !== null && lastDown !== start) return lastDown;
  const fw = ctx.siteFirewallDown(start);
  if (fw !== null && fw !== start) return fw;
  return lastDown;
}

// ---------------------------------------------------------------------------------------------
// Flap detection
// ---------------------------------------------------------------------------------------------

/**
 * Count state changes in the window. Consecutive changes in the same direction are one change —
 * a node going down produces both a status change and a "Node is down" alert.
 */
export function countStateChanges(
  changes: readonly StateChange[],
  now: Date,
  windowMin: number,
): number {
  const since = now.getTime() - windowMin * 60_000;
  const recent = changes
    .filter((c) => c.at.getTime() >= since && c.at.getTime() <= now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  let count = 0;
  let last: boolean | null = null;
  for (const c of recent) {
    if (c.bad !== last) count++;
    last = c.bad;
  }
  return count;
}

export function isFlapping(
  changes: readonly StateChange[],
  now: Date,
  flapCount: number,
  windowMin: number,
): boolean {
  return countStateChanges(changes, now, windowMin) >= flapCount;
}
