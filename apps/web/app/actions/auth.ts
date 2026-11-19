'use server';

import { redirect } from 'next/navigation';
import { hashPassword, verifyPassword } from '@mercer/core';
import {
  createFirstAdmin,
  deleteInternalSetting,
  findAccountByUsername,
  writeAudit,
} from '@mercer/db';
import { INTERNAL_SETTING_KEYS } from '@mercer/core';
import { endSession, startSession } from '@/lib/auth';
import { effectiveConfig } from '@/lib/settings';
import { ENTRA_PROVIDER_ID, signIn } from '@/lib/sso';
import { noteFailure, rateLimit, requestMeta, tooManyFailures } from '@/lib/request';
import { server } from '@/lib/server';
import { checkSetupCode } from '@/lib/setup-code';

const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

export interface AuthFormState {
  message?: string;
  errors?: Record<string, string>;
  /** Echoed non-secret inputs (React resets forms after an action). */
  values?: { setupCode?: string; username?: string };
}

const USERNAME_RE = /^[A-Za-z0-9._@-]{3,64}$/;

const safeNext = (v: unknown) => {
  const s = typeof v === 'string' ? v : '/';
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
};

export async function claimSetupAction(_: AuthFormState, form: FormData): Promise<AuthFormState> {
  const meta = await requestMeta();
  if (
    // Per-IP only when the IP is trustworthy; the global cap alone makes guessing 32^8 codes hopeless.
    (meta.ip && !rateLimit(`setup:${meta.ip}`, 10, 15 * 60_000)) ||
    !rateLimit('setup:global', 50, 60 * 60_000)
  ) {
    return { message: 'Too many attempts. Wait 15 minutes and try again.' };
  }
  const code = String(form.get('setupCode') ?? '');
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');
  const errors: Record<string, string> = {};
  if (!USERNAME_RE.test(username)) errors.username = '3–64 characters: letters, digits, . _ @ -';
  if (password.length < 12) errors.password = 'Use at least 12 characters.';
  else if (password !== confirm) errors.confirm = 'The passwords do not match.';
  if (!(await checkSetupCode(code)))
    errors.setupCode = 'That setup code is not correct. Copy it from the web container log.';
  if (Object.keys(errors).length) return { errors, values: { setupCode: code, username } };

  const { db, log } = server();
  const account = await createFirstAdmin(db.db, {
    username,
    passwordHash: await hashPassword(password),
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  if (!account) return { message: 'An administrator already exists. Sign in instead.' };
  await deleteInternalSetting(db.db, INTERNAL_SETTING_KEYS.setupCode);
  log.info({ username }, 'first administrator created via setup wizard');
  await startSession(account);
  redirect('/setup/orion');
}

export async function loginAction(_: AuthFormState, form: FormData): Promise<AuthFormState> {
  const meta = await requestMeta();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '/');
  // Failed attempts are limited per address and per account. Successful sign-ins don't count, so
  // a shared break-glass account is not locked out by normal use. A looser cap on all attempts
  // bounds the scrypt work one address can cause.
  const failKeys = [
    `login-user:${username.toLowerCase()}`,
    ...(meta.ip ? [`login:${meta.ip}`] : []),
  ];
  if (
    failKeys.some((k) => tooManyFailures(k, LOGIN_MAX_FAILURES)) ||
    (meta.ip && !rateLimit(`login-any:${meta.ip}`, 60, LOGIN_WINDOW_MS))
  ) {
    return { message: 'Too many attempts. Wait 15 minutes and try again.' };
  }
  const { db, log } = server();
  const account = await findAccountByUsername(db.db, username);
  const ok =
    !!account && !account.disabledAt && (await verifyPassword(password, account.passwordHash));
  if (!ok || !account) {
    for (const k of failKeys) noteFailure(k, LOGIN_WINDOW_MS);
    log.warn({ username, ip: meta.ip }, 'failed sign-in');
    return { message: 'Incorrect username or password.', values: { username } };
  }
  await startSession(account);
  await writeAudit(db.db, {
    actorType: 'user',
    actorId: `local:${account.id}`,
    actorLabel: `local:${account.username}`,
    action: 'auth.login',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  redirect(safeNext(next));
}

/** Start the Microsoft Entra ID sign-in (redirects to login.microsoftonline.com). */
export async function microsoftSignInAction(form: FormData): Promise<void> {
  const cfg = await effectiveConfig();
  if (!cfg.auth.entra) redirect('/login?error=not_configured');
  await signIn(ENTRA_PROVIDER_ID, { redirectTo: safeNext(form.get('next')) });
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect('/login');
}
