import { sql } from 'drizzle-orm';
import { slugify, type DivisionRef, type NodeOverride, type SiteRef } from '@mercer/core';
import { divisions, nodeSiteOverrides, sites } from '../schema';
import type { DbOrTx } from '../client';
import { writeAudit } from './audit';

export interface SiteContextData {
  sites: SiteRef[];
  divisions: DivisionRef[];
  overrides: Map<number, NodeOverride>;
}

export async function loadSiteContextData(db: DbOrTx): Promise<SiteContextData> {
  const [siteRows, divRows, ovRows] = await Promise.all([
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
