import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { settingAssets } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

export type SettingAssetRow = typeof settingAssets.$inferSelect;

/** Asset keys in use. */
export const ASSET_KEYS = { mapImage: 'map.image' } as const;

export async function getSettingAsset(
  db: DbOrTx,
  key: string,
): Promise<SettingAssetRow | undefined> {
  const [row] = await db.select().from(settingAssets).where(eq(settingAssets.key, key));
  return row;
}

/** Metadata only (no bytes), for settings pages. */
export async function getSettingAssetInfo(db: DbOrTx, key: string) {
  const [row] = await db
    .select({
      key: settingAssets.key,
      contentType: settingAssets.contentType,
      width: settingAssets.width,
      height: settingAssets.height,
      sha256: settingAssets.sha256,
      updatedAt: settingAssets.updatedAt,
      updatedBy: settingAssets.updatedBy,
    })
    .from(settingAssets)
    .where(eq(settingAssets.key, key));
  return row;
}

export async function putSettingAsset(
  db: Db,
  key: string,
  file: { contentType: string; data: Buffer; width: number | null; height: number | null },
  actor: Actor,
): Promise<void> {
  const sha256 = createHash('sha256').update(file.data).digest('hex');
  await db.transaction(async (tx) => {
    const values = { ...file, sha256, updatedBy: actor.actorLabel, updatedAt: new Date() };
    await tx
      .insert(settingAssets)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: settingAssets.key, set: values });
    await writeAudit(tx, {
      ...actor,
      action: 'setting_asset.put',
      targetType: 'setting_asset',
      targetId: key,
      after: {
        contentType: file.contentType,
        bytes: file.data.length,
        width: file.width,
        height: file.height,
        sha256,
      },
    });
  });
}

export async function deleteSettingAsset(db: Db, key: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const del = await tx
      .delete(settingAssets)
      .where(eq(settingAssets.key, key))
      .returning({ key: settingAssets.key });
    if (del.length)
      await writeAudit(tx, {
        ...actor,
        action: 'setting_asset.delete',
        targetType: 'setting_asset',
        targetId: key,
      });
  });
}
