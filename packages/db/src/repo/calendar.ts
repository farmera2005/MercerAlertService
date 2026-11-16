import { desc, eq, gte, isNull, or } from 'drizzle-orm';
import { maintenanceWindows, seasonPeriods, type MaintenanceRecurrence } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

export type SeasonRow = typeof seasonPeriods.$inferSelect;
export type MaintenanceRow = typeof maintenanceWindows.$inferSelect;

export const SEED_SEASONS = [
  {
    name: 'Harvest',
    kind: 'harvest' as const,
    startMd: '09-01',
    endMd: '12-15',
    multiplier: 1.5,
    divisions: null,
    harvestCriticalOnly: false,
    enabled: true,
  },
  {
    name: 'Wheat harvest',
    kind: 'high_risk' as const,
    startMd: '06-25',
    endMd: '07-25',
    multiplier: 1.2,
    divisions: ['grain'],
    harvestCriticalOnly: false,
    enabled: false,
  },
  {
    name: 'Spring application season',
    kind: 'high_risk' as const,
    startMd: '03-15',
    endMd: '06-15',
    multiplier: 1.2,
    divisions: ['agronomy'],
    harvestCriticalOnly: false,
    enabled: false,
  },
];

export async function listSeasons(db: DbOrTx): Promise<SeasonRow[]> {
  return db.select().from(seasonPeriods).orderBy(seasonPeriods.startMd);
}

export type SeasonInput = Pick<
  typeof seasonPeriods.$inferInsert,
  | 'name'
  | 'kind'
  | 'startMd'
  | 'endMd'
  | 'year'
  | 'multiplier'
  | 'divisions'
  | 'harvestCriticalOnly'
  | 'enabled'
>;

export async function saveSeason(
  db: Db,
  id: number | null,
  input: SeasonInput,
  actor: Actor,
): Promise<SeasonRow> {
  return db.transaction(async (tx) => {
    if (id) {
      const [before] = await tx.select().from(seasonPeriods).where(eq(seasonPeriods.id, id));
      const [after] = await tx
        .update(seasonPeriods)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(seasonPeriods.id, id))
        .returning();
      await writeAudit(tx, {
        ...actor,
        action: 'season.update',
        targetType: 'season',
        targetId: id,
        before,
        after,
      });
      return after!;
    }
    const [row] = await tx.insert(seasonPeriods).values(input).returning();
    await writeAudit(tx, {
      ...actor,
      action: 'season.create',
      targetType: 'season',
      targetId: row!.id,
      after: row,
    });
    return row!;
  });
}

export async function deleteSeason(db: Db, id: number, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.delete(seasonPeriods).where(eq(seasonPeriods.id, id)).returning();
    if (before)
      await writeAudit(tx, {
        ...actor,
        action: 'season.delete',
        targetType: 'season',
        targetId: id,
        before,
      });
  });
}

/** Windows that are current, future, or ended within the last week. */
export async function listMaintenance(db: DbOrTx, now = new Date()): Promise<MaintenanceRow[]> {
  return db
    .select()
    .from(maintenanceWindows)
    .where(
      or(
        isNull(maintenanceWindows.endsAt),
        gte(maintenanceWindows.endsAt, new Date(now.getTime() - 7 * 86_400_000)),
      ),
    )
    .orderBy(desc(maintenanceWindows.startsAt));
}

export interface MaintenanceInput {
  scope: 'global' | 'site' | 'node';
  siteId: number | null;
  nodeId: number | null;
  startsAt: Date;
  endsAt: Date | null;
  recurrence: MaintenanceRecurrence | null;
  suppress: 'notifications' | 'incidents';
  reason: string | null;
}

export async function createMaintenance(
  db: Db,
  input: MaintenanceInput,
  actor: Actor,
): Promise<MaintenanceRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(maintenanceWindows)
      .values({ ...input, createdBy: actor.actorLabel })
      .returning();
    await writeAudit(tx, {
      ...actor,
      action: 'maintenance.create',
      targetType: 'maintenance_window',
      targetId: row!.id,
      after: row,
    });
    return row!;
  });
}

/** End a window now (kept for history) — or delete it if it has not started yet. */
export async function endMaintenance(
  db: Db,
  id: number,
  actor: Actor,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, id));
    if (!before) return;
    if (before.startsAt > now) {
      await tx.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id));
      await writeAudit(tx, {
        ...actor,
        action: 'maintenance.delete',
        targetType: 'maintenance_window',
        targetId: id,
        before,
      });
    } else {
      const [after] = await tx
        .update(maintenanceWindows)
        .set({ endsAt: now })
        .where(eq(maintenanceWindows.id, id))
        .returning();
      await writeAudit(tx, {
        ...actor,
        action: 'maintenance.end',
        targetType: 'maintenance_window',
        targetId: id,
        before,
        after,
      });
    }
  });
}
