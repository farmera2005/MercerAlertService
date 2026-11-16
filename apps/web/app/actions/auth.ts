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
import { rateLimit, requestMeta } from '@/lib/request';
import { server } from '@/lib/server';
import { checkSetupCode } from '@/lib/setup-code';

export interface AuthFormState {
  message?: string;
  errors?: Record<string, string>;
  /** Echoed non-secret inputs (React resets forms after an action). */
  values?: { setupCode?: string; username?: string };
}

const USERNAME_RE = /^[A-Za-z0-9._@-]{3,64}$/;

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
  if (
    (meta.ip && !rateLimit(`login:${meta.ip}`, 10, 15 * 60_000)) ||
    !rateLimit(`login-user:${username.toLowerCase()}`, 10, 15 * 60_000)
  ) {
    return { message: 'Too many attempts. Wait 15 minutes and try again.' };
  }
  const { db, log } = server();
  const account = await findAccountByUsername(db.db, username);
  const ok =
    !!account && !account.disabledAt && (await verifyPassword(password, account.passwordHash));
  if (!ok || !account) {
    log.warn({ username, ip: meta.ip }, 'failed sign-in');
    return { message: 'Incorrect username or password.', values: { username } };
  }
  await startSession(account);
  await writeAudit(db.db, {
    actorType: 'user',
    actorId: String(account.id),
    actorLabel: `local:${account.username}`,
    action: 'auth.login',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect('/login');
}
