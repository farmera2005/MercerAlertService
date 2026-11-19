import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  chunk,
  nodeSiteGroups,
  parseSwisUri,
  selectSiteGroups,
  type GroupMemberRef,
  type GroupRef,
  type SiteGroup,
  type SiteGroupConfig,
  type SiteGroupPlan,
  type SiteLinkRef,
} from '@mercer/core';
import { orionGroupMembers, orionGroups, siteNotesWrites, sites } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

export interface GroupMirrorRow {
  containerId: number;
  name: string;
  status: number | null;
  description: string | null;
  uri: string | null;
}

export interface GroupMemberRow {
  containerId: number;
  memberUri: string;
  memberPrimaryId: number | null;
  memberEntityType: string | null;
  name: string | null;
  status: number | null;
}

/** Full replace of the group mirror (a complete, successful groups poll only). */
export async function replaceGroupMirror(
  db: Db,
  groups: GroupMirrorRow[],
  members: GroupMemberRow[],
  now: Date,
): Promise<{ groups: number; members: number; notesChanged: number }> {
  return db.transaction(async (tx) => {
    const before = new Map(
      (
        await tx
          .select({ id: orionGroups.containerId, d: orionGroups.description })
          .from(orionGroups)
      ).map((g) => [g.id, g.d]),
    );
    const notesChanged = groups.filter(
      (g) => before.has(g.containerId) && before.get(g.containerId) !== g.description,
    ).length;
    await tx.execute(sql`TRUNCATE ${orionGroupMembers}, ${orionGroups}`);
    for (const part of chunk(groups, 1000))
      await tx.insert(orionGroups).values(part.map((g) => ({ ...g, syncedAt: now })));
    for (const part of chunk(members, 1000))
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
    return { groups: groups.length, members: members.length, notesChanged };
  });
}

/** The mirror as the pure site-group functions want it. */
export async function loadGroupMirror(
  db: DbOrTx,
): Promise<{ groups: GroupRef[]; members: GroupMemberRef[] }> {
  const groups = await db
    .select({ containerId: orionGroups.containerId, name: orionGroups.name })
    .from(orionGroups);
  const rows = await db
    .select({
      containerId: orionGroupMembers.containerId,
      memberUri: orionGroupMembers.memberUri,
      memberEntityType: orionGroupMembers.memberEntityType,
      nodeId: orionGroupMembers.nodeId,
    })
    .from(orionGroupMembers);
  const members = rows.map((r): GroupMemberRef => {
    const parsed = parseSwisUri(r.memberUri);
    const isGroup =
      parsed.nodeId === undefined &&
      parsed.containerId !== undefined &&
      (r.memberEntityType ?? 'Orion.Groups').includes('Group');
    return {
      containerId: r.containerId,
      nodeId: r.nodeId,
      memberContainerId: isGroup ? parsed.containerId! : null,
    };
  });
  return { groups, members };
}

export async function loadSiteLinkRefs(db: DbOrTx): Promise<SiteLinkRef[]> {
  return db
    .select({
      id: sites.id,
      code: sites.code,
      name: sites.name,
      aliases: sites.aliases,
      orionContainerId: sites.orionContainerId,
    })
    .from(sites);
}

/** Apply a link plan from planSiteGroupLinks: one transaction, every change audited. */
export async function applySiteGroupPlan(db: Db, plan: SiteGroupPlan): Promise<void> {
  if (!plan.link.length && !plan.rename.length && !plan.create.length) return;
  const actor: Actor = { actorType: 'system', actorLabel: 'worker' };
  await db.transaction(async (tx) => {
    for (const l of plan.link) {
      const [after] = await tx
        .update(sites)
        .set({ orionContainerId: l.containerId, updatedAt: new Date() })
        .where(eq(sites.id, l.siteId))
        .returning({ id: sites.id, name: sites.name, orionContainerId: sites.orionContainerId });
      await writeAudit(tx, {
        ...actor,
        action: 'site.group_link',
        targetType: 'site',
        targetId: l.siteId,
        after,
      });
    }
    for (const r of plan.rename) {
      await tx
        .update(sites)
        .set({
          name: r.to,
          // Keep the old name as an alias, so custom-property values that use it still match.
          aliases: sql`(SELECT array_agg(DISTINCT a) FROM unnest(${sites.aliases} || ARRAY[${r.from}]::text[]) a)`,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, r.siteId));
      await writeAudit(tx, {
        ...actor,
        action: 'site.group_rename',
        targetType: 'site',
        targetId: r.siteId,
        before: { name: r.from },
        after: { name: r.to },
      });
    }
    for (const c of plan.create) {
      const [created] = await tx
        .insert(sites)
        .values({
          code: c.code,
          name: c.name,
          aliases: [c.name],
          orionContainerId: c.containerId,
          profileStatus: 'auto',
        })
        .onConflictDoNothing()
        .returning({ id: sites.id, code: sites.code, name: sites.name });
      if (created)
        await writeAudit(tx, {
          ...actor,
          action: 'site.auto_create',
          targetType: 'site',
          targetId: created.id,
          after: { ...created, orionContainerId: c.containerId },
        });
    }
  });
}

/** nodeId → siteId through SolarWinds site groups; empty when site groups are not configured. */
export async function loadGroupSiteMap(
  db: DbOrTx,
  cfg: SiteGroupConfig,
): Promise<{ byNode: Map<number, number>; ambiguous: number[]; siteGroups: SiteGroup[] }> {
  const { groups, members } = await loadGroupMirror(db);
  const siteGroups = selectSiteGroups(groups, members, cfg);
  if (!siteGroups.length) return { byNode: new Map(), ambiguous: [], siteGroups };
  const links = await db
    .select({ id: sites.id, containerId: sites.orionContainerId })
    .from(sites)
    .where(
      inArray(
        sites.orionContainerId,
        siteGroups.map((g) => g.containerId),
      ),
    );
  const siteByContainer = new Map(links.map((l) => [l.containerId!, l.id]));
  const { byNode: groupByNode, ambiguous } = nodeSiteGroups(siteGroups, members);
  const byNode = new Map<number, number>();
  for (const [nodeId, containerId] of groupByNode) {
    const siteId = siteByContainer.get(containerId);
    if (siteId !== undefined) byNode.set(nodeId, siteId);
  }
  return { byNode, ambiguous, siteGroups };
}

// ---------------------------------------------------------------------------------------------
// Site notes = the linked group's description
// ---------------------------------------------------------------------------------------------

export interface SiteGroupInfo {
  siteId: number;
  containerId: number;
  /** null when the group is no longer in SolarWinds (or not polled yet). */
  groupName: string | null;
  description: string | null;
  syncedAt: Date | null;
}

export async function siteGroupInfo(
  db: DbOrTx,
  siteIds: number[],
): Promise<Map<number, SiteGroupInfo>> {
  if (!siteIds.length) return new Map();
  const rows = await db
    .select({
      siteId: sites.id,
      containerId: sites.orionContainerId,
      groupName: orionGroups.name,
      description: orionGroups.description,
      syncedAt: orionGroups.syncedAt,
    })
    .from(sites)
    .leftJoin(orionGroups, eq(orionGroups.containerId, sites.orionContainerId))
    .where(and(inArray(sites.id, siteIds), sql`${sites.orionContainerId} IS NOT NULL`));
  return new Map(
    rows.map((r) => [
      r.siteId,
      {
        siteId: r.siteId,
        containerId: r.containerId!,
        groupName: r.groupName,
        description: r.description,
        syncedAt: r.syncedAt,
      },
    ]),
  );
}

export type SiteNotesWriteRow = typeof siteNotesWrites.$inferSelect;

export type RequestSiteNotesResult = { ok: true; writeId: number } | { ok: false; error: string };

/** Record the edit (audited, same transaction); the caller queues the worker job. */
export async function requestSiteNotesWrite(
  db: Db,
  input: { siteId: number; text: string; base: string | null },
  actor: Actor,
): Promise<RequestSiteNotesResult> {
  return db.transaction(async (tx) => {
    const [site] = await tx
      .select({ id: sites.id, containerId: sites.orionContainerId })
      .from(sites)
      .where(eq(sites.id, input.siteId));
    if (!site) return { ok: false, error: 'Site not found.' };
    if (site.containerId === null)
      return { ok: false, error: 'This site is not linked to a SolarWinds group.' };
    const [pending] = await tx
      .select({ id: siteNotesWrites.id })
      .from(siteNotesWrites)
      .where(and(eq(siteNotesWrites.siteId, input.siteId), eq(siteNotesWrites.status, 'pending')))
      .limit(1);
    if (pending)
      return { ok: false, error: 'The previous change is still being saved to SolarWinds.' };
    const [row] = await tx
      .insert(siteNotesWrites)
      .values({
        siteId: input.siteId,
        containerId: site.containerId,
        text: input.text,
        base: input.base,
        requestedBy: actor.actorLabel,
      })
      .returning({ id: siteNotesWrites.id });
    await writeAudit(tx, {
      ...actor,
      action: 'site.notes.update',
      targetType: 'site',
      targetId: input.siteId,
      before: { notes: input.base },
      after: { notes: input.text, solarwindsGroup: site.containerId },
    });
    return { ok: true, writeId: row!.id };
  });
}

export async function getSiteNotesWrite(
  db: DbOrTx,
  id: number,
): Promise<(SiteNotesWriteRow & { groupUri: string | null }) | null> {
  const [row] = await db
    .select({ w: siteNotesWrites, groupUri: orionGroups.uri })
    .from(siteNotesWrites)
    .leftJoin(orionGroups, eq(orionGroups.containerId, siteNotesWrites.containerId))
    .where(eq(siteNotesWrites.id, id));
  return row ? { ...row.w, groupUri: row.groupUri } : null;
}

export async function finishSiteNotesWrite(
  db: DbOrTx,
  id: number,
  status: 'ok' | 'conflict' | 'failed' | 'skipped',
  error: string | null = null,
): Promise<void> {
  await db
    .update(siteNotesWrites)
    .set({ status, error, completedAt: new Date() })
    .where(eq(siteNotesWrites.id, id));
}

/** The newest write per site, for "saving…" / "could not save" next to the notes. */
export async function latestSiteNotesWrites(
  db: DbOrTx,
  siteIds: number[],
): Promise<Map<number, SiteNotesWriteRow>> {
  if (!siteIds.length) return new Map();
  const rows = await db
    .selectDistinctOn([siteNotesWrites.siteId])
    .from(siteNotesWrites)
    .where(inArray(siteNotesWrites.siteId, siteIds))
    .orderBy(siteNotesWrites.siteId, desc(siteNotesWrites.createdAt), desc(siteNotesWrites.id));
  return new Map(rows.map((r) => [r.siteId, r]));
}

/** After a confirmed write, store what SolarWinds now holds (read back from SWIS). */
export async function setGroupMirrorDescription(
  db: DbOrTx,
  containerId: number,
  description: string | null,
): Promise<void> {
  await db.update(orionGroups).set({ description }).where(eq(orionGroups.containerId, containerId));
}
