/**
 * Two-step sign-in for local accounts: authenticator apps (TOTP), passkeys, recovery codes, and
 * the short-lived challenges between the password and a session. Secrets arrive sealed and code
 * hashes arrive hashed (`@mercer/core` two-factor); nothing here sees a plaintext secret.
 */
import { and, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { canRemoveFactor, type SecondFactors } from '@mercer/core';
import {
  accountPasskeys,
  accountRecoveryCodes,
  authChallenges,
  localAccounts,
  webSessions,
} from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

export type AuthChallengeKind = 'sign_in' | 'totp_setup' | 'passkey_add';
export type AuthChallenge = typeof authChallenges.$inferSelect;

export interface PasskeyView {
  id: number;
  name: string;
  rpId: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface TwoFactorStatus extends SecondFactors {
  totpEnabledAt: Date | null;
  passkeyList: PasskeyView[];
  recoveryCodesLeft: number;
}

export async function getTwoFactorStatus(db: DbOrTx, accountId: number): Promise<TwoFactorStatus> {
  const [acct] = await db
    .select({ totpEnabledAt: localAccounts.totpEnabledAt })
    .from(localAccounts)
    .where(eq(localAccounts.id, accountId));
  const passkeyList = await db
    .select({
      id: accountPasskeys.id,
      name: accountPasskeys.name,
      rpId: accountPasskeys.rpId,
      deviceType: accountPasskeys.deviceType,
      backedUp: accountPasskeys.backedUp,
      createdAt: accountPasskeys.createdAt,
      lastUsedAt: accountPasskeys.lastUsedAt,
    })
    .from(accountPasskeys)
    .where(eq(accountPasskeys.accountId, accountId))
    .orderBy(accountPasskeys.createdAt);
  const [codes] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountRecoveryCodes)
    .where(and(eq(accountRecoveryCodes.accountId, accountId), isNull(accountRecoveryCodes.usedAt)));
  return {
    totp: !!acct?.totpEnabledAt,
    totpEnabledAt: acct?.totpEnabledAt ?? null,
    passkeys: passkeyList.length,
    passkeyList,
    recoveryCodesLeft: codes?.n ?? 0,
  };
}

/** Second factors of every local account, for Settings → Sign-in. */
export async function twoFactorSummary(
  db: DbOrTx,
): Promise<Map<number, SecondFactors & { recoveryCodesLeft: number }>> {
  const rows = await db
    .select({
      id: localAccounts.id,
      totp: sql<boolean>`${localAccounts.totpEnabledAt} is not null`,
      passkeys: sql<number>`(select count(*)::int from account_passkeys p where p.account_id = local_accounts.id)`,
      recoveryCodesLeft: sql<number>`(select count(*)::int from account_recovery_codes r where r.account_id = local_accounts.id and r.used_at is null)`,
    })
    .from(localAccounts);
  return new Map(rows.map((r) => [r.id, r]));
}

async function lockFactors(tx: DbOrTx, accountId: number): Promise<SecondFactors | null> {
  const [acct] = await tx
    .select({ username: localAccounts.username, totpEnabledAt: localAccounts.totpEnabledAt })
    .from(localAccounts)
    .where(eq(localAccounts.id, accountId))
    .for('update');
  if (!acct) return null;
  const [p] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accountPasskeys)
    .where(eq(accountPasskeys.accountId, accountId));
  return { totp: !!acct.totpEnabledAt, passkeys: p?.n ?? 0 };
}

async function insertRecoveryCodes(tx: DbOrTx, accountId: number, hashes: string[]) {
  await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
  if (hashes.length)
    await tx
      .insert(accountRecoveryCodes)
      .values(hashes.map((codeHash) => ({ accountId, codeHash })));
}

const target = (accountId: number) => ({ targetType: 'local_account', targetId: accountId });

// -------------------------------------------------------------------------------------------
// Challenges
// -------------------------------------------------------------------------------------------

export async function createAuthChallenge(
  db: DbOrTx,
  c: {
    idHash: string;
    accountId: number;
    kind: AuthChallengeKind;
    data?: Record<string, unknown>;
    ttlMs: number;
  },
  now = new Date(),
): Promise<void> {
  await db.insert(authChallenges).values({
    id: c.idHash,
    accountId: c.accountId,
    kind: c.kind,
    data: c.data ?? {},
    expiresAt: new Date(now.getTime() + c.ttlMs),
  });
}

/** A challenge that hasn't expired, of that kind (and that account, when given). */
export async function getAuthChallenge(
  db: DbOrTx,
  idHash: string,
  kind: AuthChallengeKind,
  accountId?: number,
  now = new Date(),
): Promise<AuthChallenge | undefined> {
  const [row] = await db
    .select()
    .from(authChallenges)
    .innerJoin(localAccounts, eq(localAccounts.id, authChallenges.accountId))
    .where(
      and(
        eq(authChallenges.id, idHash),
        eq(authChallenges.kind, kind),
        gt(authChallenges.expiresAt, now),
        isNull(localAccounts.disabledAt),
        accountId === undefined ? undefined : eq(authChallenges.accountId, accountId),
      ),
    );
  return row?.auth_challenges;
}

export async function setChallengeWebauthn(
  db: DbOrTx,
  idHash: string,
  challenge: string,
): Promise<void> {
  await db
    .update(authChallenges)
    .set({ webauthnChallenge: challenge })
    .where(eq(authChallenges.id, idHash));
}

/**
 * The second step was proven (a passkey, or a factor set up during the sign-in): the session can
 * start. Kept on the challenge so the session cookie is set by a separate request.
 */
export async function markChallengeVerified(
  db: DbOrTx,
  idHash: string,
  how: string,
): Promise<void> {
  await db
    .update(authChallenges)
    .set({ data: sql`${authChallenges.data} || ${JSON.stringify({ verified: how })}::jsonb` })
    .where(eq(authChallenges.id, idHash));
}

/** Count a wrong code. Returns the attempts so far; at `max` the challenge is gone. */
export async function noteChallengeFailure(
  db: DbOrTx,
  idHash: string,
  max: number,
): Promise<number> {
  const [r] = await db
    .update(authChallenges)
    .set({ attempts: sql`${authChallenges.attempts} + 1` })
    .where(eq(authChallenges.id, idHash))
    .returning({ attempts: authChallenges.attempts });
  const attempts = r?.attempts ?? max;
  if (attempts >= max) await deleteAuthChallenge(db, idHash);
  return attempts;
}

export async function deleteAuthChallenge(db: DbOrTx, idHash: string): Promise<void> {
  await db.delete(authChallenges).where(eq(authChallenges.id, idHash));
}

export async function purgeExpiredChallenges(db: DbOrTx, now = new Date()): Promise<void> {
  await db.delete(authChallenges).where(lt(authChallenges.expiresAt, now));
}

// -------------------------------------------------------------------------------------------
// Authenticator app
// -------------------------------------------------------------------------------------------

export async function getTotp(
  db: DbOrTx,
  accountId: number,
): Promise<{ sealedSecret: string; lastStep: number | null } | null> {
  const [r] = await db
    .select({ s: localAccounts.totpSecret, last: localAccounts.totpLastStep })
    .from(localAccounts)
    .where(and(eq(localAccounts.id, accountId), isNotNull(localAccounts.totpEnabledAt)));
  return r?.s ? { sealedSecret: r.s, lastStep: r.last } : null;
}

/**
 * Remember the time step a code was used in. False when that step (or a later one) was used
 * already, so the same code can't be replayed, even by two requests at once.
 */
export async function useTotpStep(db: DbOrTx, accountId: number, step: number): Promise<boolean> {
  const r = await db
    .update(localAccounts)
    .set({ totpLastStep: step })
    .where(
      and(
        eq(localAccounts.id, accountId),
        sql`(${localAccounts.totpLastStep} is null or ${localAccounts.totpLastStep} < ${step})`,
      ),
    )
    .returning({ id: localAccounts.id });
  return r.length > 0;
}

/**
 * Turn on (or replace) the authenticator app with a secret confirmed by a code. With
 * `recoveryHashes` (the account's first second factor) its recovery codes are replaced.
 */
export async function enableTotp(
  db: Db,
  accountId: number,
  input: { sealedSecret: string; step: number; recoveryHashes?: string[] },
  actor: Actor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const before = await lockFactors(tx, accountId);
    if (!before) return false;
    await tx
      .update(localAccounts)
      .set({
        totpSecret: input.sealedSecret,
        totpEnabledAt: new Date(),
        totpLastStep: input.step,
      })
      .where(eq(localAccounts.id, accountId));
    if (input.recoveryHashes) await insertRecoveryCodes(tx, accountId, input.recoveryHashes);
    await writeAudit(tx, {
      ...actor,
      action: before.totp ? 'auth.2fa.totp_replace' : 'auth.2fa.totp_enable',
      ...target(accountId),
      after: { recoveryCodes: input.recoveryHashes ? input.recoveryHashes.length : undefined },
    });
    return true;
  });
}

export async function disableTotp(
  db: Db,
  accountId: number,
  opts: { required: boolean },
  actor: Actor,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    const f = await lockFactors(tx, accountId);
    if (!f?.totp) return { ok: false, error: 'No authenticator app is set up.' };
    if (!canRemoveFactor(f, opts.required, 'totp'))
      return {
        ok: false,
        error: 'Two-step sign-in is required: add a passkey before removing the authenticator app.',
      };
    await tx
      .update(localAccounts)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
      .where(eq(localAccounts.id, accountId));
    if (f.passkeys === 0)
      await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
    await writeAudit(tx, { ...actor, action: 'auth.2fa.totp_disable', ...target(accountId) });
    return { ok: true };
  });
}

// -------------------------------------------------------------------------------------------
// Recovery codes
// -------------------------------------------------------------------------------------------

export async function replaceRecoveryCodes(
  db: Db,
  accountId: number,
  hashes: string[],
  actor: Actor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const f = await lockFactors(tx, accountId);
    if (!f || (!f.totp && f.passkeys === 0)) return false;
    await insertRecoveryCodes(tx, accountId, hashes);
    await writeAudit(tx, {
      ...actor,
      action: 'auth.2fa.recovery_codes',
      ...target(accountId),
      after: { count: hashes.length },
    });
    return true;
  });
}

/** Use a recovery code once. Returns how many are left, or null when it isn't valid. */
export async function useRecoveryCode(
  db: Db,
  accountId: number,
  codeHash: string,
  actor: Actor,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const r = await tx
      .update(accountRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(accountRecoveryCodes.accountId, accountId),
          eq(accountRecoveryCodes.codeHash, codeHash),
          isNull(accountRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: accountRecoveryCodes.id });
    if (!r.length) return null;
    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(accountRecoveryCodes)
      .where(
        and(eq(accountRecoveryCodes.accountId, accountId), isNull(accountRecoveryCodes.usedAt)),
      );
    await writeAudit(tx, {
      ...actor,
      action: 'auth.2fa.recovery_used',
      ...target(accountId),
      after: { left: left?.n ?? 0 },
    });
    return left?.n ?? 0;
  });
}

// -------------------------------------------------------------------------------------------
// Passkeys
// -------------------------------------------------------------------------------------------

export interface StoredPasskey {
  id: number;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  rpId: string;
}

export async function passkeysForAccount(db: DbOrTx, accountId: number): Promise<StoredPasskey[]> {
  return db
    .select({
      id: accountPasskeys.id,
      credentialId: accountPasskeys.credentialId,
      publicKey: accountPasskeys.publicKey,
      counter: accountPasskeys.counter,
      transports: accountPasskeys.transports,
      rpId: accountPasskeys.rpId,
    })
    .from(accountPasskeys)
    .where(eq(accountPasskeys.accountId, accountId));
}

export async function addPasskey(
  db: Db,
  accountId: number,
  p: {
    credentialId: string;
    publicKey: Buffer;
    counter: number;
    transports: string[];
    rpId: string;
    name: string;
    deviceType: string | null;
    backedUp: boolean;
    recoveryHashes?: string[];
  },
  actor: Actor,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    if (!(await lockFactors(tx, accountId))) return { ok: false, error: 'No such account.' };
    const [taken] = await tx
      .select({ id: accountPasskeys.id })
      .from(accountPasskeys)
      .where(eq(accountPasskeys.credentialId, p.credentialId));
    if (taken) return { ok: false, error: 'That passkey is already registered.' };
    const [row] = await tx
      .insert(accountPasskeys)
      .values({
        accountId,
        credentialId: p.credentialId,
        publicKey: p.publicKey,
        counter: p.counter,
        transports: p.transports,
        rpId: p.rpId,
        name: p.name,
        deviceType: p.deviceType,
        backedUp: p.backedUp,
      })
      .returning({ id: accountPasskeys.id });
    if (p.recoveryHashes) await insertRecoveryCodes(tx, accountId, p.recoveryHashes);
    await writeAudit(tx, {
      ...actor,
      action: 'auth.2fa.passkey_add',
      ...target(accountId),
      after: { passkeyId: row!.id, name: p.name, rpId: p.rpId },
    });
    return { ok: true, id: row!.id };
  });
}

export async function removePasskey(
  db: Db,
  accountId: number,
  passkeyId: number,
  opts: { required: boolean },
  actor: Actor,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    const f = await lockFactors(tx, accountId);
    if (!f) return { ok: false, error: 'No such account.' };
    const [pk] = await tx
      .select({ name: accountPasskeys.name, rpId: accountPasskeys.rpId })
      .from(accountPasskeys)
      .where(and(eq(accountPasskeys.id, passkeyId), eq(accountPasskeys.accountId, accountId)));
    if (!pk) return { ok: false, error: 'No such passkey.' };
    if (!canRemoveFactor(f, opts.required, 'passkey'))
      return {
        ok: false,
        error:
          'Two-step sign-in is required: set up the authenticator app or another passkey first.',
      };
    await tx.delete(accountPasskeys).where(eq(accountPasskeys.id, passkeyId));
    if (!f.totp && f.passkeys === 1)
      await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
    await writeAudit(tx, {
      ...actor,
      action: 'auth.2fa.passkey_remove',
      ...target(accountId),
      before: { passkeyId, name: pk.name, rpId: pk.rpId },
    });
    return { ok: true };
  });
}

/** After a passkey sign-in: its new signature counter and when it was used. */
export async function recordPasskeyUse(
  db: DbOrTx,
  passkeyId: number,
  counter: number,
): Promise<void> {
  await db
    .update(accountPasskeys)
    .set({ counter, lastUsedAt: new Date() })
    .where(eq(accountPasskeys.id, passkeyId));
}

// -------------------------------------------------------------------------------------------
// Admin
// -------------------------------------------------------------------------------------------

/**
 * For a lost phone or key: remove the account's authenticator app, passkeys and recovery codes,
 * and end its sessions. With two-step sign-in required, it sets one up at its next sign-in.
 */
export async function resetTwoFactor(db: Db, accountId: number, actor: Actor): Promise<boolean> {
  return db.transaction(async (tx) => {
    const f = await lockFactors(tx, accountId);
    if (!f) return false;
    await tx
      .update(localAccounts)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
      .where(eq(localAccounts.id, accountId));
    await tx.delete(accountPasskeys).where(eq(accountPasskeys.accountId, accountId));
    await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
    await tx.delete(authChallenges).where(eq(authChallenges.accountId, accountId));
    await tx.delete(webSessions).where(eq(webSessions.accountId, accountId));
    await writeAudit(tx, {
      ...actor,
      action: 'auth.2fa.reset',
      ...target(accountId),
      before: { totp: f.totp, passkeys: f.passkeys },
    });
    return true;
  });
}
