import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomToken, sha256Hex } from '@mercer/core';
import {
  countActiveAccounts,
  createSession,
  deleteSession,
  getSession,
  getUser,
  touchSession,
  type LocalAccount,
} from '@mercer/db';
import { requestMeta } from './request';
import { server } from './server';
import { auth as entraSession, signOut as entraSignOut } from './sso';

const COOKIE = 'mas_session';
const IDLE_MS = 12 * 3600_000;
const ABSOLUTE_MS = 7 * 86_400_000;

/**
 * Two ways in: Microsoft Entra ID (the IT team) and local administrator accounts (created by the
 * setup wizard; break-glass when Entra is unavailable). Both end up as the same CurrentUser.
 */
export interface CurrentUser {
  kind: 'local' | 'entra';
  id: number;
  /** Shown in the header and in incident timelines ("Acknowledged by …"). */
  username: string;
  /** Written to audit rows: local:<username> or entra:<email>. */
  label: string;
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

/** End both kinds of session. */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await deleteSession(server().db.db, sha256Hex(token));
  jar.delete(COOKIE);
  try {
    await entraSignOut({ redirect: false });
  } catch {
    // No Microsoft session (or sign-in not configured): nothing to end.
  }
}

async function localUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const id = sha256Hex(token);
  const row = await getSession(server().db.db, id);
  if (!row) return null;
  const now = Date.now();
  if (now - row.session.createdAt.getTime() > ABSOLUTE_MS) return null;
  if (now - row.session.lastSeenAt.getTime() > 5 * 60_000)
    await touchSession(server().db.db, id, new Date(now + IDLE_MS));
  return {
    kind: 'local',
    id: row.account.id,
    username: row.account.username,
    label: `local:${row.account.username}`,
    isAdmin: row.account.isAdmin,
  };
}

async function microsoftUser(): Promise<CurrentUser | null> {
  let uid: number | undefined;
  try {
    uid = (await entraSession())?.uid;
  } catch (err) {
    server().log.debug({ err: (err as Error).message }, 'no Microsoft session');
    return null;
  }
  if (!uid) return null;
  const u = await getUser(server().db.db, uid);
  if (!u || u.disabledAt) return null;
  return {
    kind: 'entra',
    id: u.id,
    username: u.name,
    label: `entra:${u.email || u.name}`,
    isAdmin: u.isAdmin,
  };
}

export async function currentUser(): Promise<CurrentUser | null> {
  return (await localUser()) ?? (await microsoftUser());
}

async function toLogin(fallback: string): Promise<never> {
  if ((await countActiveAccounts(server().db.db)) === 0) redirect('/setup');
  const requested = (await headers()).get('x-mas-path');
  const next =
    requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : fallback;
  redirect(`/login?next=${encodeURIComponent(next)}`);
}

/** For dashboard pages: anyone signed in. Redirects to /setup (fresh install) or /login. */
export async function requireUser(fallback = '/'): Promise<CurrentUser> {
  const user = await currentUser();
  if (user) return user;
  return toLogin(fallback);
}

/** For Settings and the setup wizard: admins only. Signed-in non-admins see a 403 page. */
export async function requireAdmin(fallback = '/'): Promise<CurrentUser> {
  const user = await currentUser();
  if (user?.isAdmin) return user;
  if (user) redirect('/forbidden');
  return toLogin(fallback);
}

async function actorFor(user: CurrentUser | null): Promise<(Actor & { display: string }) | null> {
  if (!user) return null;
  const meta = await requestMeta();
  return {
    actorType: 'user',
    actorId: `${user.kind}:${user.id}`,
    actorLabel: user.label,
    display: user.username,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };
}

/** For server actions that change configuration: the audit actor, or null (not an admin). */
export async function adminActor(): Promise<(Actor & { display: string }) | null> {
  const user = await currentUser();
  return actorFor(user?.isAdmin ? user : null);
}

/** For incident actions (ack, snooze, notes): any signed-in user. */
export async function userActor(): Promise<(Actor & { display: string }) | null> {
  return actorFor(await currentUser());
}
