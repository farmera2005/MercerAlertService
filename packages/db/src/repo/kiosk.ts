import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { randomToken, sha256Hex } from '@mercer/core';
import { kioskTokens } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

export type KioskTokenRow = typeof kioskTokens.$inferSelect;

export interface KioskTokenInput {
  name: string;
  allowedCidrs: string[];
  expiresAt: Date | null;
}

const PREFIX_LEN = 6;
const TOUCH_EVERY_MS = 5 * 60_000;

/** What the audit log keeps about a token: never the token itself. */
const describe = (
  r: Pick<KioskTokenRow, 'name' | 'allowedCidrs' | 'expiresAt' | 'tokenPrefix'>,
) => ({
  name: r.name,
  allowedCidrs: r.allowedCidrs,
  expiresAt: r.expiresAt?.toISOString() ?? null,
  tokenPrefix: r.tokenPrefix,
});

export async function listKioskTokens(db: DbOrTx): Promise<KioskTokenRow[]> {
  return db
    .select()
    .from(kioskTokens)
    .orderBy(sql`${kioskTokens.revokedAt} IS NOT NULL`, desc(kioskTokens.createdAt));
}

/** Create a wall link. The plain token is returned once and never stored. */
export async function createKioskToken(
  db: Db,
  input: KioskTokenInput,
  actor: Actor,
): Promise<{ row: KioskTokenRow; token: string }> {
  const token = randomToken(32);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(kioskTokens)
      .values({
        name: input.name,
        tokenHash: sha256Hex(token),
        tokenPrefix: token.slice(0, PREFIX_LEN),
        allowedCidrs: input.allowedCidrs,
        expiresAt: input.expiresAt,
        createdBy: actor.actorLabel,
      })
      .returning();
    await writeAudit(tx, {
      ...actor,
      action: 'kiosk.create',
      targetType: 'kiosk_token',
      targetId: row!.id,
      after: describe(row!),
    });
    return { row: row!, token };
  });
}

/** Replace the token of an existing link (the old URL stops working at once). */
export async function rotateKioskToken(
  db: Db,
  id: number,
  actor: Actor,
): Promise<{ row: KioskTokenRow; token: string } | null> {
  const token = randomToken(32);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(kioskTokens).where(eq(kioskTokens.id, id));
    if (!before || before.revokedAt) return null;
    const [row] = await tx
      .update(kioskTokens)
      .set({
        tokenHash: sha256Hex(token),
        tokenPrefix: token.slice(0, PREFIX_LEN),
        rotatedAt: new Date(),
        lastUsedAt: null,
        lastUsedIp: null,
      })
      .where(eq(kioskTokens.id, id))
      .returning();
    await writeAudit(tx, {
      ...actor,
      action: 'kiosk.rotate',
      targetType: 'kiosk_token',
      targetId: id,
      before: { tokenPrefix: before.tokenPrefix },
      after: { tokenPrefix: row!.tokenPrefix },
    });
    return { row: row!, token };
  });
}

export async function updateKioskToken(
  db: Db,
  id: number,
  /** `expiresAt` undefined keeps the current expiry. */
  input: Omit<KioskTokenInput, 'expiresAt'> & { expiresAt?: Date | null },
  actor: Actor,
): Promise<KioskTokenRow | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(kioskTokens).where(eq(kioskTokens.id, id));
    if (!before || before.revokedAt) return null;
    const [row] = await tx
      .update(kioskTokens)
      .set({
        name: input.name,
        allowedCidrs: input.allowedCidrs,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      })
      .where(eq(kioskTokens.id, id))
      .returning();
    await writeAudit(tx, {
      ...actor,
      action: 'kiosk.update',
      targetType: 'kiosk_token',
      targetId: id,
      before: describe(before),
      after: describe(row!),
    });
    return row!;
  });
}

export async function revokeKioskToken(db: Db, id: number, actor: Actor): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(kioskTokens)
      .set({ revokedAt: new Date(), revokedBy: actor.actorLabel })
      .where(and(eq(kioskTokens.id, id), isNull(kioskTokens.revokedAt)))
      .returning();
    if (!row) return false;
    await writeAudit(tx, {
      ...actor,
      action: 'kiosk.revoke',
      targetType: 'kiosk_token',
      targetId: id,
      before: describe(row),
    });
    return true;
  });
}

/** The live token row for a presented token, or null (unknown, revoked or expired). */
export async function findKioskToken(
  db: DbOrTx,
  token: string,
  now = new Date(),
): Promise<KioskTokenRow | null> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const [row] = await db
    .select()
    .from(kioskTokens)
    .where(
      and(
        eq(kioskTokens.tokenHash, sha256Hex(token)),
        isNull(kioskTokens.revokedAt),
        or(isNull(kioskTokens.expiresAt), gt(kioskTokens.expiresAt, now)),
      ),
    );
  return row ?? null;
}

/** Last-used bookkeeping, at most every few minutes per screen (a wall refreshes constantly). */
export async function touchKioskToken(
  db: DbOrTx,
  row: KioskTokenRow,
  ip: string | null,
  now = new Date(),
): Promise<void> {
  const fresh = row.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() < TOUCH_EVERY_MS;
  if (fresh && row.lastUsedIp === ip) return;
  await db
    .update(kioskTokens)
    .set({ lastUsedAt: now, lastUsedIp: ip })
    .where(eq(kioskTokens.id, row.id));
}
