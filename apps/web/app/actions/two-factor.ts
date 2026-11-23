'use server';

/**
 * Two-step sign-in for local accounts: the second step after the password (authenticator code,
 * passkey or recovery code), setting factors up (also during a sign-in when Settings require it),
 * and removing them. Microsoft sign-ins are left to Entra ID.
 */
import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { renderSVG } from 'uqr';
import {
  formatTotpSecret,
  hashRecoveryCode,
  hasSecondFactor,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  randomToken,
  SECOND_STEP_MAX_ATTEMPTS,
  sha256Hex,
  totpUri,
  verifyTotp,
} from '@mercer/core';
import {
  addPasskey,
  createAuthChallenge,
  deleteAuthChallenge,
  disableTotp,
  enableTotp,
  getAuthChallenge,
  getTotp,
  getTwoFactorStatus,
  markChallengeVerified,
  noteChallengeFailure,
  passkeysForAccount,
  recordPasskeyUse,
  removePasskey,
  replaceRecoveryCodes,
  setChallengeWebauthn,
  useRecoveryCode,
  useTotpStep,
} from '@mercer/db';
import { actorOf, currentUser, TWO_FACTOR_SETUP_PATH } from '@/lib/auth';
import { requestMeta, tooManyFailures } from '@/lib/request';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';
import {
  cancelSecondStep,
  failSecondStep,
  finishSignIn,
  PASSKEY_RP_NAME,
  pendingSignIn,
  setupPrincipal,
  webauthnContext,
} from '@/lib/two-factor';

export interface TwoStepState {
  ok?: boolean;
  message?: string;
  at?: number;
  /** Shown once, right after the first second factor is set up or after new ones are made. */
  recoveryCodes?: string[];
  /** The second step of a sign-in is proven: completeSignInAction starts the session. */
  complete?: boolean;
}

const SETUP_TTL_MS = 15 * 60_000;
const EXPIRED = 'This sign-in has expired. Sign in again with your password.';
const NO_SETUP = 'Sign in first.';
const fail = (message: string): TwoStepState => ({ ok: false, message, at: Date.now() });

function limited(username: string): boolean {
  return tooManyFailures(`login-user:${username.toLowerCase()}`, 10);
}

// Passkey responses come from the browser: check their shape and size before the library does.
const b64url = z
  .string()
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]*$/);
const credentialBase = {
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
};
const registrationSchema = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: b64url,
    attestationObject: b64url,
    transports: z.array(z.string().max(32)).max(10).optional(),
    authenticatorData: b64url.optional(),
    publicKey: b64url.optional(),
    publicKeyAlgorithm: z.number().int().optional(),
  }),
});
const authenticationSchema = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.optional(),
  }),
});

async function sessionAccount() {
  const user = await currentUser();
  return user?.kind === 'local' ? { user, actor: await actorOf(user) } : null;
}

const codesAndHashes = () => {
  const codes = newRecoveryCodes();
  return { codes, hashes: codes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c)!)) };
};

// -------------------------------------------------------------------------------------------
// The second step of a sign-in
// -------------------------------------------------------------------------------------------

/** An authenticator code or a recovery code (form field `kind`). */
export async function verifySecondStepAction(
  _: TwoStepState,
  form: FormData,
): Promise<TwoStepState> {
  const p = await pendingSignIn();
  if (!p || p.mode !== 'verify') return fail(EXPIRED);
  if (limited(p.account.username)) return fail('Too many attempts. Wait 15 minutes and try again.');
  const { db } = server();
  const code = String(form.get('code') ?? '');

  if (form.get('kind') === 'recovery') {
    const normalized = normalizeRecoveryCode(code);
    const meta = await requestMeta();
    const left = normalized
      ? await useRecoveryCode(db.db, p.account.id, hashRecoveryCode(normalized), {
          actorType: 'user',
          actorId: `local:${p.account.id}`,
          actorLabel: `local:${p.account.username}`,
          ip: meta.ip,
          userAgent: meta.userAgent,
        })
      : null;
    if (left === null) return fail(await failSecondStep(p, 'recovery code'));
    const next = await finishSignIn(p, 'recovery_code');
    // Few left: show Account security, where new ones can be made.
    redirect(left <= 3 ? `${TWO_FACTOR_SETUP_PATH}?recovery_left=${left}` : next);
  }

  const totp = await getTotp(db.db, p.account.id);
  const step = totp
    ? verifyTotp(server().box.open(totp.sealedSecret), code, { lastStep: totp.lastStep })
    : null;
  if (step === null || !(await useTotpStep(db.db, p.account.id, step)))
    return fail(await failSecondStep(p, 'code'));
  redirect(await finishSignIn(p, 'totp'));
}

export async function passkeySignInOptionsAction() {
  const p = await pendingSignIn();
  if (!p || p.mode !== 'verify') return { ok: false as const, message: EXPIRED };
  const ctx = webauthnContext(await requestMeta());
  if (!ctx.usable) return { ok: false as const, message: ctx.why };
  const keys = (await passkeysForAccount(server().db.db, p.account.id)).filter(
    (k) => k.rpId === ctx.rpId,
  );
  if (!keys.length)
    return { ok: false as const, message: 'This account has no passkey for this address.' };
  const options = await generateAuthenticationOptions({
    rpID: ctx.rpId,
    allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports })),
    userVerification: 'preferred',
  });
  await setChallengeWebauthn(server().db.db, p.idHash, options.challenge);
  return { ok: true as const, options };
}

export async function passkeySignInVerifyAction(input: unknown): Promise<TwoStepState> {
  const p = await pendingSignIn();
  if (!p || p.mode !== 'verify') return fail(EXPIRED);
  if (limited(p.account.username)) return fail('Too many attempts. Wait 15 minutes and try again.');
  const ctx = webauthnContext(await requestMeta());
  const response = authenticationSchema.safeParse(input);
  const { db, log } = server();
  const row = await getAuthChallenge(db.db, p.idHash, 'sign_in');
  if (!ctx.usable || !response.success || !row?.webauthnChallenge)
    return fail(await failSecondStep(p, 'passkey'));
  const key = (await passkeysForAccount(db.db, p.account.id)).find(
    (k) => k.credentialId === response.data.id && k.rpId === ctx.rpId,
  );
  if (!key) return fail(await failSecondStep(p, 'passkey'));
  try {
    const v = await verifyAuthenticationResponse({
      response: response.data,
      expectedChallenge: row.webauthnChallenge,
      expectedOrigin: ctx.origins,
      expectedRPID: ctx.rpId,
      credential: {
        id: key.credentialId,
        publicKey: new Uint8Array(key.publicKey),
        counter: key.counter,
        transports: key.transports,
      },
      requireUserVerification: false,
    });
    if (!v.verified) return fail(await failSecondStep(p, 'passkey'));
    await recordPasskeyUse(db.db, key.id, v.authenticationInfo.newCounter);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'passkey sign-in refused');
    return fail(await failSecondStep(p, 'passkey'));
  }
  // The session cookie is set by completeSignInAction: setting it here would re-render this page.
  await markChallengeVerified(db.db, p.idHash, 'passkey');
  return { ok: true, complete: true, at: Date.now() };
}

/**
 * Start the session once the second step is proven (or no longer needed, when the requirement
 * was turned off meanwhile), and go where the sign-in was headed.
 */
export async function completeSignInAction(): Promise<void> {
  const p = await pendingSignIn();
  if (!p) redirect('/login?error=expired');
  if (!p.verified && p.mode !== 'done') redirect('/login/two-step');
  redirect(await finishSignIn(p, p.verified ?? 'password'));
}

export async function cancelSignInAction(): Promise<void> {
  await cancelSecondStep();
  redirect('/login');
}

// -------------------------------------------------------------------------------------------
// Setting factors up (Account security, or during a sign-in that requires one)
// -------------------------------------------------------------------------------------------

export async function startTotpSetupAction() {
  const who = await setupPrincipal();
  if (!who) return { ok: false as const, message: NO_SETUP };
  const secret = newTotpSecret();
  const token = randomToken();
  await createAuthChallenge(server().db.db, {
    idHash: sha256Hex(token),
    accountId: who.account.id,
    kind: 'totp_setup',
    data: { sealedSecret: server().box.seal(secret) },
    ttlMs: SETUP_TTL_MS,
  });
  const uri = totpUri({ secret, account: who.account.username, issuer: PASSKEY_RP_NAME });
  const svg = renderSVG(uri, { border: 2, whiteColor: '#ffffff', blackColor: '#000000' });
  return {
    ok: true as const,
    token,
    secret: formatTotpSecret(secret),
    qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  };
}

export async function confirmTotpSetupAction(
  _: TwoStepState,
  form: FormData,
): Promise<TwoStepState> {
  const who = await setupPrincipal();
  if (!who) return fail(NO_SETUP);
  const { db } = server();
  const idHash = sha256Hex(String(form.get('token') ?? ''));
  const row = await getAuthChallenge(db.db, idHash, 'totp_setup', who.account.id);
  const sealed = typeof row?.data.sealedSecret === 'string' ? row.data.sealedSecret : null;
  if (!sealed) return fail('This setup has expired. Start again.');
  const step = verifyTotp(server().box.open(sealed), String(form.get('code') ?? ''));
  if (step === null) {
    const n = await noteChallengeFailure(db.db, idHash, SECOND_STEP_MAX_ATTEMPTS);
    return fail(
      n >= SECOND_STEP_MAX_ATTEMPTS
        ? 'Too many wrong codes. Start again.'
        : 'That code is not right. Check the time on your phone and try the newest code.',
    );
  }
  const first = !hasSecondFactor(await getTwoFactorStatus(db.db, who.account.id));
  const recovery = first ? codesAndHashes() : null;
  await enableTotp(
    db.db,
    who.account.id,
    { sealedSecret: sealed, step, recoveryHashes: recovery?.hashes },
    who.actor,
  );
  await deleteAuthChallenge(db.db, idHash);
  if (who.via === 'sign_in') await markChallengeVerified(db.db, who.pending.idHash, 'totp_setup');
  // No revalidatePath: re-rendering now would replace the form showing the recovery codes. The
  // browser refreshes once they've been seen.
  return {
    ok: true,
    message: 'The authenticator app is set up.',
    recoveryCodes: recovery?.codes,
    complete: who.via === 'sign_in',
    at: Date.now(),
  };
}

export async function passkeyRegistrationOptionsAction() {
  const who = await setupPrincipal();
  if (!who) return { ok: false as const, message: NO_SETUP };
  const ctx = webauthnContext(await requestMeta());
  if (!ctx.usable) return { ok: false as const, message: ctx.why };
  const { db } = server();
  const existing = (await passkeysForAccount(db.db, who.account.id)).filter(
    (k) => k.rpId === ctx.rpId,
  );
  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: ctx.rpId,
    userName: who.account.username,
    // Stable and opaque, so an authenticator keeps one passkey per account.
    userID: new Uint8Array(createHash('sha256').update(`mas-local:${who.account.id}`).digest()),
    attestationType: 'none',
    excludeCredentials: existing.map((k) => ({ id: k.credentialId, transports: k.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const token = randomToken();
  await createAuthChallenge(db.db, {
    idHash: sha256Hex(token),
    accountId: who.account.id,
    kind: 'passkey_add',
    ttlMs: SETUP_TTL_MS,
  });
  await setChallengeWebauthn(db.db, sha256Hex(token), options.challenge);
  return { ok: true as const, token, options };
}

export async function passkeyRegistrationVerifyAction(
  token: string,
  input: unknown,
  name: string,
): Promise<TwoStepState> {
  const who = await setupPrincipal();
  if (!who) return fail(NO_SETUP);
  const ctx = webauthnContext(await requestMeta());
  if (!ctx.usable) return fail(ctx.why);
  const { db, log } = server();
  const idHash = sha256Hex(String(token));
  const row = await getAuthChallenge(db.db, idHash, 'passkey_add', who.account.id);
  const response = registrationSchema.safeParse(input);
  if (!row?.webauthnChallenge) return fail('This setup has expired. Start again.');
  if (!response.success) return fail('The browser sent a passkey MAS can’t read.');
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: response.data,
      expectedChallenge: row.webauthnChallenge,
      expectedOrigin: ctx.origins,
      expectedRPID: ctx.rpId,
      requireUserVerification: false,
    });
    if (!v.verified) return fail('The passkey could not be verified.');
    info = v.registrationInfo;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'passkey registration refused');
    return fail('The passkey could not be verified.');
  } finally {
    await deleteAuthChallenge(db.db, idHash);
  }
  const first = !hasSecondFactor(await getTwoFactorStatus(db.db, who.account.id));
  const recovery = first ? codesAndHashes() : null;
  const label =
    String(name ?? '')
      .trim()
      .slice(0, 60) || 'Passkey';
  const r = await addPasskey(
    db.db,
    who.account.id,
    {
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      rpId: ctx.rpId,
      name: label,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      recoveryHashes: recovery?.hashes,
    },
    who.actor,
  );
  if (!r.ok) return fail(r.error);
  if (who.via === 'sign_in')
    await markChallengeVerified(db.db, who.pending.idHash, 'passkey_setup');
  // As above: the browser refreshes once the recovery codes have been seen.
  return {
    ok: true,
    message: `Passkey “${label}” added.`,
    recoveryCodes: recovery?.codes,
    complete: who.via === 'sign_in',
    at: Date.now(),
  };
}

// -------------------------------------------------------------------------------------------
// Account security (signed in)
// -------------------------------------------------------------------------------------------

export async function disableTotpAction(): Promise<TwoStepState> {
  const me = await sessionAccount();
  if (!me) return fail(NO_SETUP);
  const required = (await effectiveConfig()).auth.require2fa;
  const r = await disableTotp(server().db.db, me.user.id, { required }, me.actor);
  revalidatePath(TWO_FACTOR_SETUP_PATH);
  return r.ok ? { ok: true, message: 'Authenticator app removed.', at: Date.now() } : fail(r.error);
}

export async function removePasskeyAction(_: TwoStepState, form: FormData): Promise<TwoStepState> {
  const me = await sessionAccount();
  if (!me) return fail(NO_SETUP);
  const required = (await effectiveConfig()).auth.require2fa;
  const r = await removePasskey(
    server().db.db,
    me.user.id,
    Number(form.get('id')),
    { required },
    me.actor,
  );
  revalidatePath(TWO_FACTOR_SETUP_PATH);
  return r.ok ? { ok: true, message: 'Passkey removed.', at: Date.now() } : fail(r.error);
}

export async function newRecoveryCodesAction(): Promise<TwoStepState> {
  const me = await sessionAccount();
  if (!me) return fail(NO_SETUP);
  const { codes, hashes } = codesAndHashes();
  const ok = await replaceRecoveryCodes(server().db.db, me.user.id, hashes, me.actor);
  revalidatePath(TWO_FACTOR_SETUP_PATH);
  return ok
    ? {
        ok: true,
        message: 'New recovery codes made. The old ones no longer work.',
        recoveryCodes: codes,
        at: Date.now(),
      }
    : fail('Set up an authenticator app or a passkey first.');
}
