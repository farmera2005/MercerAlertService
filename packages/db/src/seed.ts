import { sql } from 'drizzle-orm';
import { divisions, seasonPeriods, sites } from './schema';
import { SEED_SEASONS } from './repo/calendar';
import type { Db } from './client';
import { SEED_DIVISIONS, SEED_SITES } from './seed-data';

/**
 * Idempotent: inserts missing divisions and placeholder sites, never overwrites rows an admin
 * may already have edited. `sites: 'if-empty'` (used on deploy) only seeds a brand-new install,
 * so a placeholder an admin deleted is not resurrected.
 */
export async function seedReferenceData(
  db: Db,
  opts: { sites: 'missing' | 'if-empty' } = { sites: 'missing' },
): Promise<{ divisions: number; sites: number }> {
  return db.transaction(async (tx) => {
    const d = await tx
      .insert(divisions)
      .values(SEED_DIVISIONS)
      .onConflictDoNothing()
      .returning({ code: divisions.code });
    // Season calendar: only on a fresh install, so admin edits/deletions are never undone.
    const [seasonCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(seasonPeriods);
    if ((seasonCount?.n ?? 0) === 0) await tx.insert(seasonPeriods).values(SEED_SEASONS);
    if (opts.sites === 'if-empty') {
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(sites);
      if ((row?.n ?? 0) > 0) return { divisions: d.length, sites: 0 };
    }
    const s = await tx
      .insert(sites)
      .values(
        SEED_SITES.map((x) => ({
          ...x,
          city: x.city || null,
          profileStatus: 'placeholder' as const,
        })),
      )
      .onConflictDoNothing({ target: sites.code })
      .returning({ id: sites.id });
    return { divisions: d.length, sites: s.length };
  });
}
