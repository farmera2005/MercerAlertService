'use server';

import { revalidatePath } from 'next/cache';
import { hashPassword, isDeviceRole } from '@mercer/core';
import {
  createLocalAccount,
  resetTwoFactor,
  saveNodeOverride,
  setLocalAccountDisabled,
  setLocalAccountPassword,
} from '@mercer/db';
import type { ActionResult } from '@/components/stateful-form';
import { adminActor } from '@/lib/auth';
import { server } from '@/lib/server';

const NOT_ADMIN: ActionResult = { ok: false, message: 'Only administrators can change this.' };
const USERNAME_RE = /^[A-Za-z0-9._@-]{3,64}$/;
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (message: string): ActionResult => ({ ok: true, message, at: Date.now() });
const fail = (errors: Record<string, string>): ActionResult => ({
  ok: false,
  message: 'Please fix the highlighted fields.',
  errors,
  at: Date.now(),
});

/** Settings → Devices: pin a node to a site and/or role (applies at the next node poll). */
export async function saveDeviceOverrideAction(
  nodeId: number,
  _: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const siteRaw = text(form, 'siteId');
  const roleRaw = text(form, 'role');
  const siteId = siteRaw ? Number(siteRaw) : null;
  if (siteId !== null && (!Number.isInteger(siteId) || siteId <= 0))
    return fail({ siteId: 'Choose a site.' });
  if (roleRaw && !isDeviceRole(roleRaw)) return fail({ role: 'Choose a role.' });
  const reason = text(form, 'reason').slice(0, 300) || null;
  await saveNodeOverride(
    server().db.db,
    nodeId,
    { siteId, deviceRole: roleRaw || null, reason },
    actor,
  );
  revalidatePath('/settings/devices');
  return done(
    siteId === null && !roleRaw
      ? 'Override removed. The node goes back to its Orion properties at the next poll.'
      : 'Saved. It applies at the next node poll (within about two minutes).',
  );
}

function checkPassword(form: FormData): Record<string, string> {
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');
  if (password.length < 12) return { password: 'Use at least 12 characters.' };
  if (password !== confirm) return { confirm: 'The passwords do not match.' };
  return {};
}

export async function createLocalAccountAction(
  _: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const username = text(form, 'username');
  const errors = {
    ...(USERNAME_RE.test(username)
      ? {}
      : { username: '3–64 characters: letters, digits, . _ @ -' }),
    ...checkPassword(form),
  };
  if (Object.keys(errors).length) return fail(errors);
  const r = await createLocalAccount(
    server().db.db,
    { username, passwordHash: await hashPassword(String(form.get('password'))) },
    actor,
  );
  if (!r.ok) return fail({ username: r.error });
  revalidatePath('/settings/sign-in');
  return done(`Created ${username}.`);
}

export async function resetLocalPasswordAction(
  id: number,
  _: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const errors = checkPassword(form);
  if (Object.keys(errors).length) return fail(errors);
  const ok = await setLocalAccountPassword(
    server().db.db,
    id,
    await hashPassword(String(form.get('password'))),
    actor,
  );
  revalidatePath('/settings/sign-in');
  return ok
    ? done('Password changed. That account is signed out everywhere.')
    : { ok: false, message: 'No such account.', at: Date.now() };
}

/** For a lost phone or key: remove an account's second factors and sign it out everywhere. */
export async function resetTwoFactorAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const id = Number(form.get('id'));
  if (actor.actorId === `local:${id}`)
    return {
      ok: false,
      message: 'Change your own under Account security.',
      at: Date.now(),
    };
  const ok = await resetTwoFactor(server().db.db, id, actor);
  revalidatePath('/settings/sign-in');
  return ok
    ? done('Two-step sign-in removed and signed out. The account sets it up again at sign-in.')
    : { ok: false, message: 'No such account.', at: Date.now() };
}

export async function setLocalAccountDisabledAction(
  _: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const id = Number(form.get('id'));
  const disable = form.get('disable') === 'true';
  const r = await setLocalAccountDisabled(server().db.db, id, disable, actor);
  revalidatePath('/settings/sign-in');
  return r.ok
    ? done(disable ? 'Disabled and signed out.' : 'Enabled.')
    : { ok: false, message: r.error, at: Date.now() };
}
