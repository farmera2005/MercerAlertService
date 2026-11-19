import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  geocodeQuery,
  planGeocode,
  slugify,
  type DivisionRef,
  type GeoFields,
  type GeoMatch,
  type NodeOverride,
  type SiteRef,
} from '@mercer/core';
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
        divisionCodes: sites.divisionCodes,
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

export async function getSiteRow(db: DbOrTx, id: number): Promise<SiteRow | null> {
  const [row] = await db.select().from(sites).where(eq(sites.id, id));
  return row ?? null;
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
  | 'divisionCodes'
  | 'address'
  | 'city'
  | 'state'
  | 'lat'
  | 'lon'
  | 'mapX'
  | 'mapY'
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

/** Known division codes only, once each, in divisions order. */
async function orderedDivisionCodes(db: DbOrTx, codes: readonly string[]): Promise<string[]> {
  if (!codes.length) return [];
  const rows = await db
    .select({ code: divisions.code })
    .from(divisions)
    .where(inArray(divisions.code, [...new Set(codes)]))
    .orderBy(divisions.sortOrder, divisions.name);
  return rows.map((r) => r.code);
}

const geoOf = (s: Partial<SiteInput> & Partial<GeoFields>): GeoFields => ({
  address: s.address ?? null,
  city: s.city ?? null,
  state: s.state ?? null,
  lat: s.lat ?? null,
  lon: s.lon ?? null,
});

/**
 * The geo columns a save sets: a lookup to queue (geo_status 'pending'; the caller queues
 * `sites.geocode`), typed coordinates, or nothing.
 */
function geoColumns(before: GeoFields | null, after: GeoFields) {
  const plan = planGeocode(before, after);
  if (plan.action === 'lookup')
    return { geoStatus: 'pending' as const, geoQuery: plan.query, geoError: null };
  if (plan.action === 'manual')
    return { geoStatus: 'manual' as const, geoQuery: plan.query, geoLabel: null, geoError: null };
  return {};
}

export async function createSite(db: Db, input: SiteInput, actor: SiteActor): Promise<SiteRow> {
  return db.transaction(async (tx) => {
    const code = input.code?.trim() || slugify(input.name);
    const divisionCodes = await orderedDivisionCodes(tx, input.divisionCodes ?? []);
    const [row] = await tx
      .insert(sites)
      .values({
        ...input,
        ...geoColumns(null, geoOf(input)),
        divisionCodes,
        code,
        profileStatus: 'confirmed',
      })
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
    if (patch.divisionCodes)
      patch = { ...patch, divisionCodes: await orderedDivisionCodes(tx, patch.divisionCodes) };
    const geo = geoColumns(geoOf(before), geoOf({ ...before, ...patch }));
    const [after] = await tx
      .update(sites)
      .set({ ...patch, ...geo, profileStatus: 'confirmed', updatedAt: new Date() })
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

// ---------------------------------------------------------------------------------------------
// Map placement from addresses (the worker's sites.geocode job does the lookup)
// ---------------------------------------------------------------------------------------------

/** Queue a lookup for every site with an address or city but no coordinates; returns their IDs. */
export async function requestUnplacedGeocodes(db: Db, actor: SiteActor): Promise<number[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(sites)
      .where(or(isNull(sites.lat), isNull(sites.lon)));
    const ids: number[] = [];
    for (const s of rows) {
      const query = geocodeQuery(s);
      if (!query) continue;
      await tx
        .update(sites)
        .set({ geoStatus: 'pending', geoQuery: query, geoError: null })
        .where(eq(sites.id, s.id));
      ids.push(s.id);
    }
    if (ids.length)
      await writeAudit(tx, {
        ...actor,
        action: 'site.geocode_request',
        targetType: 'site',
        after: { siteIds: ids },
      });
    return ids;
  });
}

export type GeocodeOutcome =
  { kind: 'ok'; match: GeoMatch } | { kind: 'not_found' } | { kind: 'failed'; error: string };

/**
 * Store a lookup's result for `query`. Ignored (returns false) when the site has since been given
 * another address or typed coordinates. A match moves the site, audited as the worker.
 */
export async function finishGeocode(
  db: Db,
  siteId: number,
  query: string,
  outcome: GeocodeOutcome,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.geoQuery, query)))
      .for('update');
    if (!s || s.geoStatus === 'manual') return false;
    const now = new Date();
    if (outcome.kind === 'failed') {
      await tx
        .update(sites)
        .set({ geoStatus: 'failed', geoError: outcome.error.slice(0, 500) })
        .where(eq(sites.id, siteId));
      return true;
    }
    if (outcome.kind === 'not_found') {
      await tx
        .update(sites)
        .set({ geoStatus: 'not_found', geoLabel: null, geoError: null, geocodedAt: now })
        .where(eq(sites.id, siteId));
      return true;
    }
    const { lat, lon, label } = outcome.match;
    await tx
      .update(sites)
      .set({
        lat,
        lon,
        geoStatus: 'ok',
        geoLabel: label.slice(0, 500),
        geoError: null,
        geocodedAt: now,
        updatedAt: now,
      })
      .where(eq(sites.id, siteId));
    await writeAudit(tx, {
      actorType: 'system',
      actorLabel: 'worker',
      action: 'site.geocode',
      targetType: 'site',
      targetId: siteId,
      before: { lat: s.lat, lon: s.lon },
      after: { lat, lon, query, label },
    });
    return true;
  });
}
