import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { localAccounts, webSessions } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';

export type LocalAccount = typeof localAccounts.$inferSelect;

export async function countActiveAccounts(db: DbOrTx): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(localAccounts)
    .where(isNull(localAccounts.disabledAt));
  return r?.n ?? 0;
}

export async function findAccountByUsername(
  db: DbOrTx,
  username: string,
): Promise<LocalAccount | undefined> {
  const [row] = await db
    .select()
    .from(localAccounts)
    .where(eq(sql`lower(${localAccounts.username})`, username.toLowerCase()));
  return row;
}

/**
 * Create the first administrator. Serialised with an advisory lock so two browsers racing through
 * the setup screen cannot both claim the installation.
 */
export async function createFirstAdmin(
  db: Db,
  input: { username: string; passwordHash: string; ip?: string | null; userAgent?: string | null },
): Promise<LocalAccount | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4204202602)`);
    if ((await countActiveAccounts(tx)) > 0) return null;
    const [acct] = await tx
      .insert(localAccounts)
      .values({ username: input.username, passwordHash: input.passwordHash })
      .returning();
    await writeAudit(tx, {
      actorType: 'system',
      actorLabel: 'setup',
      action: 'account.create_first_admin',
      targetType: 'local_account',
      targetId: acct!.id,
      after: { username: input.username },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return acct!;
  });
}

export async function createSession(
  db: DbOrTx,
  s: {
    idHash: string;
    accountId: number;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await db.insert(webSessions).values({
    id: s.idHash,
    accountId: s.accountId,
    expiresAt: s.expiresAt,
    ip: s.ip,
    userAgent: s.userAgent,
  });
  await db
    .update(localAccounts)
    .set({ lastLoginAt: new Date() })
    .where(eq(localAccounts.id, s.accountId));
}

export async function getSession(db: DbOrTx, idHash: string, now = new Date()) {
  const [row] = await db
    .select({ session: webSessions, account: localAccounts })
    .from(webSessions)
    .innerJoin(localAccounts, eq(localAccounts.id, webSessions.accountId))
    .where(
      and(
        eq(webSessions.id, idHash),
        gt(webSessions.expiresAt, now),
        isNull(localAccounts.disabledAt),
      ),
    );
  return row;
}

export async function touchSession(db: DbOrTx, idHash: string, expiresAt: Date): Promise<void> {
  await db
    .update(webSessions)
    .set({ lastSeenAt: new Date(), expiresAt })
    .where(eq(webSessions.id, idHash));
}

export async function deleteSession(db: DbOrTx, idHash: string): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.id, idHash));
}

export async function purgeExpiredSessions(db: DbOrTx, now = new Date()): Promise<void> {
  await db.delete(webSessions).where(lt(webSessions.expiresAt, now));
}
