import { eq, sql } from 'drizzle-orm';
import { slugify, type DivisionRef, type NodeOverride, type SiteRef } from '@mercer/core';
import { divisions, nodeSiteOverrides, sites } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import { inSequence } from './helpers';

export interface SiteContextData {
  sites: SiteRef[];
  divisions: DivisionRef[];
  overrides: Map<number, NodeOverride>;
}

export async function loadSiteContextData(db: DbOrTx): Promise<SiteContextData> {
  const [siteRows, divRows, ovRows] = await inSequence([
    db
      .select({
        id: sites.id,
        code: sites.code,
        name: sites.name,
        aliases: sites.aliases,
        divisionCode: sites.divisionCode,
      })
      .from(sites),
    db
      .select({ code: divisions.code, name: divisions.name, aliases: divisions.aliases })
      .from(divisions),
    db.select().from(nodeSiteOverrides),
  ]);
  return {
    sites: siteRows,
    divisions: divRows,
    overrides: new Map(
      ovRows.map((o) => [
        o.nodeId,
        { siteId: o.siteId, divisionCode: o.divisionCode, deviceRole: o.deviceRole },
      ]),
    ),
  };
}

/**
 * Create placeholder Site Profiles for custom-property values that match no site, so new
 * locations show up on the dashboard immediately (profile_status = 'auto'; admins complete them).
 */
export async function createAutoSites(db: DbOrTx, values: string[]): Promise<number> {
  const unique = [...new Map(values.map((v) => [slugify(v), v.trim()])).entries()].filter(
    ([code]) => code,
  );
  if (!unique.length) return 0;
  const created = await db
    .insert(sites)
    .values(
      unique.map(([code, name]) => ({
        code,
        name,
        aliases: [name],
        profileStatus: 'auto' as const,
      })),
    )
    .onConflictDoNothing({ target: sites.code })
    .returning({ id: sites.id, code: sites.code, name: sites.name });
  for (const s of created) {
    await writeAudit(db, {
      actorType: 'system',
      actorLabel: 'worker',
      action: 'site.auto_create',
      targetType: 'site',
      targetId: s.id,
      after: s,
    });
  }
  return created.length;
}

export async function countSites(db: DbOrTx): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(sites);
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Site Profile editing (setup wizard / Settings → Sites). Every change is audited.
// ---------------------------------------------------------------------------------------------

export type SiteRow = typeof sites.$inferSelect;
export type DivisionRow = typeof divisions.$inferSelect;

export async function listSites(db: DbOrTx): Promise<Array<SiteRow & { nodeCount: number }>> {
  const rows = await db
    .select({
      site: sites,
      nodeCount: sql<number>`(select count(*)::int from orion_nodes n where n.site_id = ${sites.id} and n.removed_at is null)`,
    })
    .from(sites)
    .orderBy(sites.name);
  return rows.map((r) => ({ ...r.site, nodeCount: r.nodeCount }));
}

export async function listDivisions(db: DbOrTx): Promise<DivisionRow[]> {
  return db.select().from(divisions).orderBy(divisions.sortOrder, divisions.name);
}

export type SiteInput = Pick<
  typeof sites.$inferInsert,
  | 'name'
  | 'divisionCode'
  | 'city'
  | 'state'
  | 'lat'
  | 'lon'
  | 'tier'
  | 'harvestCritical'
  | 'aliases'
  | 'ownerGroup'
  | 'contactNotes'
> & { code?: string };

interface SiteActor {
  actorType: 'user' | 'kiosk' | 'system';
  actorId?: string | null;
  actorLabel: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSite(db: Db, input: SiteInput, actor: SiteActor): Promise<SiteRow> {
  return db.transaction(async (tx) => {
    const code = input.code?.trim() || slugify(input.name);
    const [row] = await tx
      .insert(sites)
      .values({ ...input, code, profileStatus: 'confirmed' })
      .returning();
    await writeAudit(tx, {
      ...actor,
      action: 'site.create',
      targetType: 'site',
      targetId: row!.id,
      after: row,
    });
    return row!;
  });
}

export async function updateSite(
  db: Db,
  id: number,
  patch: Partial<SiteInput>,
  actor: SiteActor,
): Promise<SiteRow | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(sites).where(eq(sites.id, id));
    if (!before) return null;
    const [after] = await tx
      .update(sites)
      .set({ ...patch, profileStatus: 'confirmed', updatedAt: new Date() })
      .where(eq(sites.id, id))
      .returning();
    await writeAudit(tx, {
      ...actor,
      action: 'site.update',
      targetType: 'site',
      targetId: id,
      before,
      after,
    });
    return after ?? null;
  });
}

export async function deleteSite(db: Db, id: number, actor: SiteActor): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx.delete(sites).where(eq(sites.id, id)).returning();
    if (!before) return false;
    await writeAudit(tx, {
      ...actor,
      action: 'site.delete',
      targetType: 'site',
      targetId: id,
      before,
    });
    return true;
  });
}

/** Map an Orion custom-property value onto an existing site (adds it as an alias). */
export async function addSiteAlias(
  db: Db,
  id: number,
  alias: string,
  actor: SiteActor,
): Promise<SiteRow | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(sites).where(eq(sites.id, id));
    if (!before) return null;
    if (before.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) return before;
    const [after] = await tx
      .update(sites)
      .set({ aliases: [...before.aliases, alias], updatedAt: new Date() })
      .where(eq(sites.id, id))
      .returning();
    await writeAudit(tx, {
      ...actor,
      action: 'site.add_alias',
      targetType: 'site',
      targetId: id,
      before: { aliases: before.aliases },
      after: { aliases: after!.aliases },
    });
    return after ?? null;
  });
}
