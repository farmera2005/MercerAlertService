import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { localAccounts, webSessions } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

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

export async function getLocalAccount(db: DbOrTx, id: number): Promise<LocalAccount | undefined> {
  const [row] = await db
    .select()
    .from(localAccounts)
    .where(and(eq(localAccounts.id, id), isNull(localAccounts.disabledAt)));
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
    .select({
      session: webSessions,
      account: localAccounts,
      /** Passkeys registered: with the authenticator app, whether a second step is set up. */
      passkeys: sql<number>`(select count(*)::int from account_passkeys p where p.account_id = local_accounts.id)`,
    })
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

// ---------------------------------------------------------------------------------------------
// Local (break-glass) accounts, managed in Settings → Sign-in
// ---------------------------------------------------------------------------------------------

export async function listLocalAccounts(db: DbOrTx) {
  return db
    .select({
      id: localAccounts.id,
      username: localAccounts.username,
      createdAt: localAccounts.createdAt,
      lastLoginAt: localAccounts.lastLoginAt,
      disabledAt: localAccounts.disabledAt,
    })
    .from(localAccounts)
    .orderBy(localAccounts.username);
}

export async function createLocalAccount(
  db: Db,
  input: { username: string; passwordHash: string },
  actor: Actor,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    if (await findAccountByUsername(tx, input.username))
      return { ok: false, error: 'That username is taken.' };
    const [a] = await tx
      .insert(localAccounts)
      .values({ username: input.username, passwordHash: input.passwordHash })
      .returning({ id: localAccounts.id });
    await writeAudit(tx, {
      ...actor,
      action: 'auth.local.create',
      targetType: 'local_account',
      targetId: a!.id,
      after: { username: input.username },
    });
    return { ok: true, id: a!.id };
  });
}

/** New password; every session of that account ends. */
export async function setLocalAccountPassword(
  db: Db,
  id: number,
  passwordHash: string,
  actor: Actor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await tx
      .update(localAccounts)
      .set({ passwordHash })
      .where(eq(localAccounts.id, id))
      .returning({ username: localAccounts.username });
    if (!r.length) return false;
    await tx.delete(webSessions).where(eq(webSessions.accountId, id));
    await writeAudit(tx, {
      ...actor,
      action: 'auth.local.password',
      targetType: 'local_account',
      targetId: id,
      after: { username: r[0]!.username },
    });
    return true;
  });
}

/** Disable or re-enable an account. The last active account cannot be disabled. */
export async function setLocalAccountDisabled(
  db: Db,
  id: number,
  disabled: boolean,
  actor: Actor,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4204202602)`);
    if (disabled && (await countActiveAccounts(tx)) <= 1)
      return {
        ok: false,
        error: 'This is the last active local account; keep it so someone can always sign in.',
      };
    const r = await tx
      .update(localAccounts)
      .set({ disabledAt: disabled ? now : null })
      .where(eq(localAccounts.id, id))
      .returning({ username: localAccounts.username });
    if (!r.length) return { ok: false, error: 'No such account.' };
    if (disabled) await tx.delete(webSessions).where(eq(webSessions.accountId, id));
    await writeAudit(tx, {
      ...actor,
      action: disabled ? 'auth.local.disable' : 'auth.local.enable',
      targetType: 'local_account',
      targetId: id,
      after: { username: r[0]!.username },
    });
    return { ok: true };
  });
}
