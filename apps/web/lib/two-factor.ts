import 'server-only';
import { isIP } from 'node:net';
import { cookies } from 'next/headers';
import {
  randomToken,
  SECOND_STEP_MAX_ATTEMPTS,
  SECOND_STEP_TTL_MS,
  sha256Hex,
  signInStep,
} from '@mercer/core';
import {
  createAuthChallenge,
  deleteAuthChallenge,
  getAuthChallenge,
  getLocalAccount,
  getTwoFactorStatus,
  noteChallengeFailure,
  writeAudit,
  type LocalAccount,
  type TwoFactorStatus,
} from '@mercer/db';
import { actorOf, currentUser, startSession, type Actor } from './auth';
import { noteFailure, requestMeta, type RequestMeta } from './request';
import { server } from './server';
import { effectiveConfig } from './settings';

/** Between the password and the session: the token of the 'sign_in' challenge. */
const COOKIE = 'mas_2fa';

export const safeNext = (v: unknown): string => {
  const s = typeof v === 'string' ? v : '/';
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
};

/** After a correct password, when a second step is needed: remember who, for ten minutes. */
export async function beginSecondStep(account: LocalAccount, next: string): Promise<void> {
  const token = randomToken();
  const meta = await requestMeta();
  await createAuthChallenge(server().db.db, {
    idHash: sha256Hex(token),
    accountId: account.id,
    kind: 'sign_in',
    data: { next: safeNext(next) },
    ttlMs: SECOND_STEP_TTL_MS,
  });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: meta.https,
    path: '/',
    maxAge: SECOND_STEP_TTL_MS / 1000,
  });
}

export interface PendingSignIn {
  idHash: string;
  account: LocalAccount;
  next: string;
  status: TwoFactorStatus;
  /** verify: use a second factor; enroll: set one up first (required); done: none needed now. */
  mode: 'verify' | 'enroll' | 'done';
  /** How the second step was proven, once it was (markChallengeVerified). */
  verified: string | null;
}

/** The sign-in waiting for its second step in this browser, if any. */
export async function pendingSignIn(): Promise<PendingSignIn | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const { db } = server();
  const idHash = sha256Hex(token);
  const row = await getAuthChallenge(db.db, idHash, 'sign_in');
  if (!row) return null;
  const account = await getLocalAccount(db.db, row.accountId);
  if (!account) return null;
  const status = await getTwoFactorStatus(db.db, account.id);
  return {
    idHash,
    account,
    next: safeNext(row.data.next),
    status,
    mode: signInStep(status, (await effectiveConfig()).auth.require2fa),
    verified: typeof row.data.verified === 'string' ? row.data.verified : null,
  };
}

/** Start the session the second step was for. Returns where to go next. */
export async function finishSignIn(p: PendingSignIn, method: string): Promise<string> {
  const { db } = server();
  const meta = await requestMeta();
  await startSession(p.account);
  await deleteAuthChallenge(db.db, p.idHash);
  (await cookies()).delete(COOKIE);
  await writeAudit(db.db, {
    actorType: 'user',
    actorId: `local:${p.account.id}`,
    actorLabel: `local:${p.account.username}`,
    action: 'auth.login',
    after: { method },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return p.next;
}

/** A wrong code: counted on the challenge and, like a wrong password, on the account. */
export async function failSecondStep(p: PendingSignIn, what: string): Promise<string> {
  const { db, log } = server();
  const meta = await requestMeta();
  noteFailure(`login-user:${p.account.username.toLowerCase()}`, 15 * 60_000);
  const attempts = await noteChallengeFailure(db.db, p.idHash, SECOND_STEP_MAX_ATTEMPTS);
  log.warn({ username: p.account.username, ip: meta.ip, what }, 'failed second sign-in step');
  if (attempts >= SECOND_STEP_MAX_ATTEMPTS) {
    (await cookies()).delete(COOKIE);
    return 'Too many wrong attempts. Sign in again with your password.';
  }
  return `That ${what} is not right. Try again.`;
}

export async function cancelSecondStep(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await deleteAuthChallenge(server().db.db, sha256Hex(token));
  jar.delete(COOKIE);
}

/**
 * Who may add a second factor: the signed-in local user, or someone half-way through a sign-in
 * whose account has none yet and must set one up (Settings require it). Never someone who has a
 * factor but has only given the password: that would let a password alone add a new one.
 */
export type SetupPrincipal =
  | { via: 'session'; account: LocalAccount; actor: Actor }
  | { via: 'sign_in'; account: LocalAccount; actor: Actor; pending: PendingSignIn };

export async function setupPrincipal(): Promise<SetupPrincipal | null> {
  const user = await currentUser();
  if (user?.kind === 'local') {
    const account = await getLocalAccount(server().db.db, user.id);
    return account ? { via: 'session', account, actor: await actorOf(user) } : null;
  }
  if (user) return null;
  const pending = await pendingSignIn();
  if (!pending || pending.mode !== 'enroll') return null;
  const meta = await requestMeta();
  return {
    via: 'sign_in',
    account: pending.account,
    pending,
    actor: {
      actorType: 'user',
      actorId: `local:${pending.account.id}`,
      actorLabel: `local:${pending.account.username}`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  };
}

/**
 * Where passkeys are bound: the address in the browser (WebAuthn RP ID), which can't be an IP
 * address. The origin the browser reports must be this address, over HTTPS or as the request saw
 * it (proxies that end TLS without forwarding the scheme).
 */
export function webauthnContext(
  meta: RequestMeta,
): { usable: true; rpId: string; origins: string[] } | { usable: false; why: string } {
  const u = new URL(meta.origin);
  if (isIP(u.hostname.replace(/^\[|\]$/g, '')))
    return {
      usable: false,
      why: 'Passkeys need MAS’s name in the address bar, not an IP address.',
    };
  return {
    usable: true,
    rpId: u.hostname,
    origins: [...new Set([meta.origin, `https://${u.host}`])],
  };
}

export const PASSKEY_RP_NAME = 'MercerAlertService';

/** A starting name for a new passkey, from the browser's user agent. */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'This device';
}
