import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomToken, sha256Hex } from '@mercer/core';
import {
  countActiveAccounts,
  createSession,
  deleteSession,
  getSession,
  touchSession,
  type LocalAccount,
} from '@mercer/db';
import { requestMeta } from './request';
import { server } from './server';

const COOKIE = 'mas_session';
const IDLE_MS = 12 * 3600_000;
const ABSOLUTE_MS = 7 * 86_400_000;

export interface CurrentUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface Actor {
  actorType: 'user';
  actorId: string;
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
}

export async function startSession(account: LocalAccount): Promise<void> {
  const token = randomToken();
  const meta = await requestMeta();
  await createSession(server().db.db, {
    idHash: sha256Hex(token),
    accountId: account.id,
    expiresAt: new Date(Date.now() + IDLE_MS),
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: meta.https,
    path: '/',
    maxAge: ABSOLUTE_MS / 1000,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await deleteSession(server().db.db, sha256Hex(token));
  jar.delete(COOKIE);
}

export async function currentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const id = sha256Hex(token);
  const row = await getSession(server().db.db, id);
  if (!row) return null;
  const now = Date.now();
  if (now - row.session.createdAt.getTime() > ABSOLUTE_MS) return null;
  if (now - row.session.lastSeenAt.getTime() > 5 * 60_000)
    await touchSession(server().db.db, id, new Date(now + IDLE_MS));
  return { id: row.account.id, username: row.account.username, isAdmin: row.account.isAdmin };
}

/**
 * For pages: redirect to /setup (fresh install) or /login when there is no admin session. The
 * return path is the requested URL (forwarded by proxy.ts), falling back to `fallback`.
 */
export async function requireAdmin(fallback = '/'): Promise<CurrentUser> {
  const user = await currentUser();
  if (user?.isAdmin) return user;
  if ((await countActiveAccounts(server().db.db)) === 0) redirect('/setup');
  const requested = (await headers()).get('x-mas-path');
  const next =
    requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : fallback;
  redirect(`/login?next=${encodeURIComponent(next)}`);
}

/** For server actions: returns the audit actor or null (caller returns an error state). */
export async function adminActor(): Promise<Actor | null> {
  const user = await currentUser();
  if (!user?.isAdmin) return null;
  const meta = await requestMeta();
  return {
    actorType: 'user',
    actorId: String(user.id),
    actorLabel: `local:${user.username}`,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };
}
