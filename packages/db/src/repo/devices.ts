/**
 * Settings → Devices: nodes as MAS mapped them (site, division, role and where each came from),
 * and per-node overrides for nodes whose custom properties are missing or wrong. The worker's
 * site resolver applies an override at the next node poll.
 */
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { nodeSiteOverrides, orionNodes, sites } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

export type DeviceFilter = 'unmapped' | 'overridden' | 'all';

export async function deviceCounts(db: DbOrTx) {
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unmapped: sql<number>`count(*) filter (where ${orionNodes.siteId} is null)::int`,
      roleOther: sql<number>`count(*) filter (where ${orionNodes.deviceRole} = 'other')::int`,
    })
    .from(orionNodes)
    .where(isNull(orionNodes.removedAt));
  const [o] = await db.select({ n: sql<number>`count(*)::int` }).from(nodeSiteOverrides);
  return {
    total: r?.total ?? 0,
    unmapped: r?.unmapped ?? 0,
    roleOther: r?.roleOther ?? 0,
    overridden: o?.n ?? 0,
  };
}

export async function listDevicesForAdmin(
  db: DbOrTx,
  f: { filter: DeviceFilter; q?: string; limit?: number },
) {
  const where: SQL[] = [isNull(orionNodes.removedAt)];
  if (f.filter === 'unmapped') where.push(isNull(orionNodes.siteId));
  if (f.filter === 'overridden') where.push(sql`${nodeSiteOverrides.nodeId} is not null`);
  if (f.q?.trim()) {
    const t = `%${f.q.trim()}%`;
    where.push(or(ilike(orionNodes.caption, t), ilike(orionNodes.dns, t), ilike(sites.name, t))!);
  }
  const overrideSite = sql<
    string | null
  >`(select s.name from sites s where s.id = ${nodeSiteOverrides.siteId})`;
  return db
    .select({
      nodeId: orionNodes.nodeId,
      caption: orionNodes.caption,
      status: orionNodes.statusNorm,
      role: orionNodes.deviceRole,
      siteSource: orionNodes.siteSource,
      siteId: orionNodes.siteId,
      siteName: sites.name,
      customProperties: orionNodes.customProperties,
      override: {
        siteId: nodeSiteOverrides.siteId,
        siteName: overrideSite,
        deviceRole: nodeSiteOverrides.deviceRole,
        reason: nodeSiteOverrides.reason,
        updatedBy: nodeSiteOverrides.updatedBy,
        updatedAt: nodeSiteOverrides.updatedAt,
      },
    })
    .from(orionNodes)
    .leftJoin(sites, eq(sites.id, orionNodes.siteId))
    .leftJoin(nodeSiteOverrides, eq(nodeSiteOverrides.nodeId, orionNodes.nodeId))
    .where(and(...where))
    .orderBy(asc(orionNodes.caption))
    .limit(f.limit ?? 200);
}

/** Set (or clear, when both are null) a node's site and role override. */
export async function saveNodeOverride(
  db: Db,
  nodeId: number,
  input: { siteId: number | null; deviceRole: string | null; reason: string | null },
  actor: Actor & { display?: string },
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(nodeSiteOverrides)
      .where(eq(nodeSiteOverrides.nodeId, nodeId));
    if (input.siteId === null && input.deviceRole === null) {
      await tx.delete(nodeSiteOverrides).where(eq(nodeSiteOverrides.nodeId, nodeId));
    } else {
      const values = {
        siteId: input.siteId,
        deviceRole: input.deviceRole,
        reason: input.reason,
        updatedBy: actor.display ?? actor.actorLabel,
        updatedAt: now,
      };
      await tx
        .insert(nodeSiteOverrides)
        .values({ nodeId, ...values })
        .onConflictDoUpdate({ target: nodeSiteOverrides.nodeId, set: values });
    }
    await writeAudit(tx, {
      ...actor,
      action:
        input.siteId === null && input.deviceRole === null
          ? 'device.override.clear'
          : 'device.override',
      targetType: 'node',
      targetId: nodeId,
      before: before
        ? { siteId: before.siteId, deviceRole: before.deviceRole, reason: before.reason }
        : undefined,
      after: input,
    });
  });
}
