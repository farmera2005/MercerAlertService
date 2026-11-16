import { desc, eq } from 'drizzle-orm';
import { users } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';

export type UserRow = typeof users.$inferSelect;

interface RequestInfo {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Record a successful Microsoft sign-in. The admin flag follows the groups in the token, so
 * removing someone from the admin group takes effect at their next sign-in.
 */
export async function upsertEntraUser(
  db: Db,
  u: { oid: string; email: string; name: string; isAdmin: boolean },
  meta: RequestInfo,
  now = new Date(),
): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.entraOid, u.oid));
    const [row] = await tx
      .insert(users)
      .values({
        entraOid: u.oid,
        email: u.email,
        name: u.name,
        isAdmin: u.isAdmin,
        lastLoginAt: now,
      })
      .onConflictDoUpdate({
        target: users.entraOid,
        set: { email: u.email, name: u.name, isAdmin: u.isAdmin, lastLoginAt: now },
      })
      .returning();
    await writeAudit(tx, {
      actorType: 'user',
      actorId: `entra:${row!.id}`,
      actorLabel: `entra:${u.email || u.name}`,
      action: before ? 'auth.login' : 'auth.first_login',
      targetType: 'user',
      targetId: row!.id,
      before: before && before.isAdmin !== u.isAdmin ? { isAdmin: before.isAdmin } : undefined,
      after: !before || before.isAdmin !== u.isAdmin ? { isAdmin: u.isAdmin } : undefined,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return row!;
  });
}

export async function recordDeniedSignIn(
  db: DbOrTx,
  who: { email: string | null; reason: string },
  meta: RequestInfo,
): Promise<void> {
  await writeAudit(db, {
    actorType: 'user',
    actorLabel: `entra:${who.email ?? 'unknown'}`,
    action: 'auth.denied',
    after: { reason: who.reason },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

export async function getUser(db: DbOrTx, id: number): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}

export async function findUserByOid(db: DbOrTx, oid: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.entraOid, oid));
  return row;
}

export async function listUsers(db: DbOrTx): Promise<UserRow[]> {
  return db.select().from(users).orderBy(desc(users.lastLoginAt));
}
