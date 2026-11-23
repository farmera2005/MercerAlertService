/**
 * Two-step sign-in storage (Postgres): authenticator app, recovery codes, passkeys, sign-in
 * challenges and the admin reset, with their audit rows. Requires DATABASE_URL_TEST (a throwaway
 * database; the public schema is dropped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  generateMasterKey,
  hashRecoveryCode,
  initLogger,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  SecretBox,
  totpStep,
} from '@mercer/core';
import {
  addPasskey,
  createAuthChallenge,
  createDb,
  createLocalAccount,
  createSession,
  deleteAuthChallenge,
  disableTotp,
  enableTotp,
  getAuthChallenge,
  getSession,
  getTotp,
  getTwoFactorStatus,
  noteChallengeFailure,
  passkeysForAccount,
  purgeExpiredChallenges,
  removePasskey,
  resetTwoFactor,
  twoFactorSummary,
  useRecoveryCode,
  useTotpStep,
  type DbHandle,
} from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';

const url = process.env.DATABASE_URL_TEST;
initLogger({ service: 'test', level: 'silent' });
const admin = { actorType: 'user' as const, actorId: 'local:1', actorLabel: 'local:admin' };

describe.skipIf(!url)('two-step sign-in (integration)', () => {
  let h: DbHandle;
  let id: number;
  const box = SecretBox.fromBase64(generateMasterKey());
  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.pool.query(text, values)).rows as T[];
  const hashes = (codes: string[]) => codes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c)!));

  beforeAll(async () => {
    const pgAdmin = new pg.Client({ connectionString: url });
    await pgAdmin.connect();
    await pgAdmin.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
    await pgAdmin.end();
    await runMigrations(url!);
    h = createDb({ url: url!, poolMax: 2 });
    const r = await createLocalAccount(h.db, { username: 'breakglass', passwordHash: 'x' }, admin);
    if (!r.ok) throw new Error(r.error);
    id = r.id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('stores the authenticator secret sealed and refuses a code used twice', async () => {
    const secret = newTotpSecret();
    const codes = newRecoveryCodes();
    const step = totpStep();
    expect(
      await enableTotp(
        h.db,
        id,
        { sealedSecret: box.seal(secret), step, recoveryHashes: hashes(codes) },
        admin,
      ),
    ).toBe(true);
    const [row] = await q<{ totp_secret: string }>(
      'select totp_secret from local_accounts where id = $1',
      [id],
    );
    expect(row!.totp_secret).toMatch(/^v1:/);
    expect(row!.totp_secret).not.toContain(secret);
    const t = await getTotp(h.db, id);
    expect(box.open(t!.sealedSecret)).toBe(secret);
    expect(t!.lastStep).toBe(step);

    // The step that enabled it can't sign in; the next one can, once.
    expect(await useTotpStep(h.db, id, step)).toBe(false);
    expect(await useTotpStep(h.db, id, step + 1)).toBe(true);
    expect(await useTotpStep(h.db, id, step + 1)).toBe(false);
    expect(await getTwoFactorStatus(h.db, id)).toMatchObject({
      totp: true,
      passkeys: 0,
      recoveryCodesLeft: 10,
    });

    // Recovery codes: each works once, only the hash is stored.
    expect(await useRecoveryCode(h.db, id, hashes([codes[0]!])[0]!, admin)).toBe(9);
    expect(await useRecoveryCode(h.db, id, hashes([codes[0]!])[0]!, admin)).toBeNull();
    expect(await useRecoveryCode(h.db, id, 'f'.repeat(64), admin)).toBeNull();
    const stored = await q<{ code_hash: string }>(
      'select code_hash from account_recovery_codes where account_id = $1',
      [id],
    );
    expect(stored.some((r) => codes.some((c) => r.code_hash.includes(c)))).toBe(false);
  });

  it('keeps one factor while required, and removes recovery codes with the last one', async () => {
    expect(await disableTotp(h.db, id, { required: true }, admin)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/add a passkey/),
    });
    const pk = await addPasskey(
      h.db,
      id,
      {
        credentialId: 'cred-1',
        publicKey: Buffer.from([1, 2, 3]),
        counter: 0,
        transports: ['internal'],
        rpId: 'mas.example.net',
        name: 'Laptop',
        deviceType: 'multiDevice',
        backedUp: true,
      },
      admin,
    );
    expect(pk.ok).toBe(true);
    expect(
      await addPasskey(
        h.db,
        id,
        {
          credentialId: 'cred-1',
          publicKey: Buffer.from([1]),
          counter: 0,
          transports: [],
          rpId: 'mas.example.net',
          name: 'Again',
          deviceType: null,
          backedUp: false,
        },
        admin,
      ),
    ).toEqual({ ok: false, error: 'That passkey is already registered.' });
    // The session lookup knows a second step is set up.
    await createSession(h.db, {
      idHash: 's0',
      accountId: id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await getSession(h.db, 's0'))?.passkeys).toBe(1);
    const [stored] = await passkeysForAccount(h.db, id);
    expect(stored).toMatchObject({ credentialId: 'cred-1', counter: 0, rpId: 'mas.example.net' });
    expect(Buffer.from(stored!.publicKey)).toEqual(Buffer.from([1, 2, 3]));

    // With the passkey, the app can go; then the passkey can't (it's the last factor).
    expect(await disableTotp(h.db, id, { required: true }, admin)).toEqual({ ok: true });
    const pkId = pk.ok ? pk.id : 0;
    expect(await removePasskey(h.db, id, pkId, { required: true }, admin)).toMatchObject({
      ok: false,
    });
    expect((await getTwoFactorStatus(h.db, id)).recoveryCodesLeft).toBe(9);
    expect(await removePasskey(h.db, id, pkId, { required: false }, admin)).toEqual({ ok: true });
    expect(await getTwoFactorStatus(h.db, id)).toMatchObject({
      totp: false,
      passkeys: 0,
      recoveryCodesLeft: 0,
    });
  });

  it('runs sign-in challenges with a limit on wrong codes', async () => {
    await createAuthChallenge(h.db, {
      idHash: 'c1',
      accountId: id,
      kind: 'sign_in',
      data: { next: '/incidents' },
      ttlMs: 60_000,
    });
    expect(await getAuthChallenge(h.db, 'c1', 'sign_in')).toMatchObject({
      accountId: id,
      data: { next: '/incidents' },
    });
    expect(await getAuthChallenge(h.db, 'c1', 'totp_setup')).toBeUndefined();
    expect(await getAuthChallenge(h.db, 'c1', 'sign_in', id + 1)).toBeUndefined();
    for (let i = 1; i < 5; i++) expect(await noteChallengeFailure(h.db, 'c1', 5)).toBe(i);
    expect(await noteChallengeFailure(h.db, 'c1', 5)).toBe(5);
    expect(await getAuthChallenge(h.db, 'c1', 'sign_in')).toBeUndefined();

    await createAuthChallenge(h.db, { idHash: 'c2', accountId: id, kind: 'sign_in', ttlMs: -1 });
    expect(await getAuthChallenge(h.db, 'c2', 'sign_in')).toBeUndefined();
    await purgeExpiredChallenges(h.db);
    expect(await q('select id from auth_challenges where id = $1', ['c2'])).toEqual([]);
    await deleteAuthChallenge(h.db, 'nothing');
  });

  it('lets an admin reset everything for a lost phone, and audits it all', async () => {
    await enableTotp(
      h.db,
      id,
      {
        sealedSecret: box.seal(newTotpSecret()),
        step: 1,
        recoveryHashes: hashes(newRecoveryCodes()),
      },
      admin,
    );
    await createSession(h.db, {
      idHash: 's1',
      accountId: id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await getSession(h.db, 's1'))?.passkeys).toBe(0);
    expect((await twoFactorSummary(h.db)).get(id)).toEqual({
      id,
      totp: true,
      passkeys: 0,
      recoveryCodesLeft: 10,
    });
    expect(await resetTwoFactor(h.db, id, admin)).toBe(true);
    expect(await getSession(h.db, 's1')).toBeUndefined();
    expect(await getTwoFactorStatus(h.db, id)).toMatchObject({
      totp: false,
      passkeys: 0,
      recoveryCodesLeft: 0,
    });
    const audit = await q<{ action: string; after: unknown }>(
      `select action, after from audit_log where action like 'auth.2fa.%' order by id`,
    );
    expect(audit.map((a) => a.action)).toEqual([
      'auth.2fa.totp_enable',
      'auth.2fa.recovery_used',
      'auth.2fa.passkey_add',
      'auth.2fa.totp_disable',
      'auth.2fa.passkey_remove',
      'auth.2fa.totp_enable',
      'auth.2fa.reset',
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/v1:/);
  });
});
