import { sql } from 'drizzle-orm';
import { chunk, parseSwisUri } from '@mercer/core';
import {
  orionAlertConfigs,
  orionDependencies,
  orionGroupMembers,
  orionGroups,
  orionStatusInfo,
  topologyConnections,
} from '../schema';
import type { Db, Tx } from '../client';
import { excludedSet } from './helpers';

/** Omitted parts are left untouched (e.g. when Orion.TopologyConnections is not readable). */
export interface TopologyBundle {
  connections?: Array<{
    srcNodeId: number;
    srcInterfaceId: number | null;
    destNodeId: number;
    destInterfaceId: number | null;
    layerType: string | null;
  }>;
  dependencies?: Array<{
    dependencyId: number;
    name: string | null;
    parentUri: string;
    childUri: string;
    autoManaged: boolean;
    parentEntityType: string | null;
    childEntityType: string | null;
  }>;
  groups?: Array<{
    containerId: number;
    name: string;
    status: number | null;
    description: string | null;
    uri: string | null;
  }>;
  members?: Array<{
    containerId: number;
    memberUri: string;
    memberPrimaryId: number | null;
    memberEntityType: string | null;
    name: string | null;
    status: number | null;
  }>;
}

/** Full replace of the provided topology/dependency/group tables in one transaction. */
export async function replaceTopology(
  db: Db,
  b: TopologyBundle,
  now: Date,
): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const out: Record<string, number> = {};
    if (b.connections) {
      await tx.execute(sql`TRUNCATE ${topologyConnections}`);
      out.connections = await insertConnections(tx, b.connections, now);
    }
    if (b.dependencies) {
      await tx.execute(sql`TRUNCATE ${orionDependencies}`);
      await insertDependencies(tx, b.dependencies, now);
      out.dependencies = b.dependencies.length;
    }
    if (b.groups && b.members) {
      await tx.execute(sql`TRUNCATE ${orionGroupMembers}, ${orionGroups}`);
      for (const part of chunk(b.groups, 1000)) {
        await tx.insert(orionGroups).values(part.map((g) => ({ ...g, syncedAt: now })));
      }
      for (const part of chunk(b.members, 1000)) {
        await tx
          .insert(orionGroupMembers)
          .values(
            part.map((m) => ({
              ...m,
              nodeId: parseSwisUri(m.memberUri).nodeId ?? null,
              syncedAt: now,
            })),
          )
          .onConflictDoNothing();
      }
      out.groups = b.groups.length;
      out.members = b.members.length;
    }
    return out;
  });
}

async function insertConnections(
  tx: Tx,
  connections: NonNullable<TopologyBundle['connections']>,
  now: Date,
): Promise<number> {
  // Topology can contain duplicate rows (both directions / multiple discoveries) — dedupe.
  const seen = new Set<string>();
  const conns = connections.filter((c) => {
    const k = `${c.srcNodeId}:${c.srcInterfaceId}:${c.destNodeId}:${c.destInterfaceId}:${c.layerType}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (const part of chunk(conns, 1000)) {
    await tx
      .insert(topologyConnections)
      .values(part.map((c) => ({ ...c, syncedAt: now })))
      .onConflictDoNothing();
  }
  return conns.length;
}

async function insertDependencies(
  tx: Tx,
  deps: NonNullable<TopologyBundle['dependencies']>,
  now: Date,
): Promise<void> {
  for (const part of chunk(deps, 500)) {
    await tx.insert(orionDependencies).values(
      part.map((d) => {
        const p = parseSwisUri(d.parentUri);
        const c = parseSwisUri(d.childUri);
        return {
          ...d,
          parentNodeId: p.nodeId ?? null,
          childNodeId: c.nodeId ?? null,
          parentContainerId: p.containerId ?? null,
          childContainerId: c.containerId ?? null,
          syncedAt: now,
        };
      }),
    );
  }
}

export async function upsertAlertConfigs(
  db: Db,
  rows: Array<{
    alertId: number;
    alertRefId: string | null;
    name: string;
    description: string | null;
    enabled: boolean;
    severity: number;
    objectType: string | null;
  }>,
  now: Date,
): Promise<number> {
  for (const part of chunk(rows, 500)) {
    await insertAlertConfigChunk(db, part, now);
  }
  return rows.length;
}

async function insertAlertConfigChunk(
  db: Db,
  part: Parameters<typeof upsertAlertConfigs>[1],
  now: Date,
) {
  await db
    .insert(orionAlertConfigs)
    .values(part.map((r) => ({ ...r, syncedAt: now })))
    .onConflictDoUpdate({
      target: orionAlertConfigs.alertId,
      set: excludedSet(orionAlertConfigs, ['alertId']),
    });
}

export async function replaceStatusInfo(
  db: Db,
  rows: Array<{ statusId: number; statusName: string }>,
): Promise<void> {
  if (!rows.length) return;
  await db
    .insert(orionStatusInfo)
    .values(rows)
    .onConflictDoUpdate({
      target: orionStatusInfo.statusId,
      set: excludedSet(orionStatusInfo, ['statusId']),
    });
}
