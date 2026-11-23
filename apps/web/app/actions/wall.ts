'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { boardRefSchema, imageInfo, parseCidrList } from '@mercer/core';
import {
  ASSET_KEYS,
  createKioskToken,
  deleteSettingAsset,
  putSettingAsset,
  revokeKioskToken,
  rotateKioskToken,
  setKioskBoards,
  updateKioskToken,
} from '@mercer/db';
import { adminActor } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export interface KioskFormState {
  ok?: boolean;
  message?: string;
  errors?: Record<string, string>;
  /** Shown once after create/rotate; never stored. */
  url?: string;
  values?: { name?: string; cidrs?: string; expiresDays?: string };
}

const NOT_ADMIN: KioskFormState = {
  ok: false,
  message: 'Only administrators can change wall links.',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const kioskSchema = z.object({
  name: z.string().trim().min(1, 'Give the screen a name.').max(80),
  cidrs: z.string().max(2000).default(''),
  /** "keep" (edit only) leaves the current expiry unchanged. */
  expiresDays: z.enum(['', '30', '90', '365', 'keep']).default(''),
});

function parseKioskForm(form: FormData) {
  const raw = {
    name: String(form.get('name') ?? ''),
    cidrs: String(form.get('cidrs') ?? ''),
    expiresDays: String(form.get('expiresDays') ?? ''),
  };
  const parsed = kioskSchema.safeParse(raw);
  const errors: Record<string, string> = {};
  if (!parsed.success) for (const i of parsed.error.issues) errors[String(i.path[0])] ??= i.message;
  const cidr = parseCidrList(raw.cidrs);
  if (cidr.errors.length) errors.cidrs = cidr.errors.join('; ');
  return { raw, errors, data: parsed.success ? parsed.data : null, cidrs: cidr.cidrs };
}

const expiry = (days: string) =>
  days === 'keep' ? undefined : days ? new Date(Date.now() + Number(days) * 86_400_000) : null;

async function wallUrl(token: string): Promise<string> {
  return `${(await effectiveConfig()).baseUrl}/wall/${token}`;
}

export async function createKioskAction(
  _: KioskFormState,
  form: FormData,
): Promise<KioskFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const f = parseKioskForm(form);
  if (!f.data || Object.keys(f.errors).length)
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      errors: f.errors,
      values: f.raw,
    };
  const { token } = await createKioskToken(
    server().db.db,
    { name: f.data.name, allowedCidrs: f.cidrs, expiresAt: expiry(f.data.expiresDays) ?? null },
    actor,
  );
  revalidatePath('/settings/wall');
  return {
    ok: true,
    message: `Wall link “${f.data.name}” created. Copy it now: it is not shown again.`,
    url: await wallUrl(token),
  };
}

export async function updateKioskAction(
  id: number,
  _: KioskFormState,
  form: FormData,
): Promise<KioskFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const f = parseKioskForm(form);
  if (!f.data || Object.keys(f.errors).length)
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      errors: f.errors,
      values: f.raw,
    };
  const row = await updateKioskToken(
    server().db.db,
    id,
    { name: f.data.name, allowedCidrs: f.cidrs, expiresAt: expiry(f.data.expiresDays) },
    actor,
  );
  if (!row) return { ok: false, message: 'That link no longer exists or was revoked.' };
  revalidatePath('/settings/wall');
  return { ok: true, message: 'Saved.' };
}

export async function rotateKioskAction(id: number, _: KioskFormState): Promise<KioskFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const res = await rotateKioskToken(server().db.db, id, actor);
  if (!res) return { ok: false, message: 'That link no longer exists or was revoked.' };
  revalidatePath('/settings/wall');
  return {
    ok: true,
    message: 'New link created; the old one stopped working. Copy it now: it is not shown again.',
    url: await wallUrl(res.token),
  };
}

export async function revokeKioskAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await revokeKioskToken(server().db.db, Number(form.get('id')), actor);
  revalidatePath('/settings/wall');
}

export interface UploadState {
  ok?: boolean;
  message?: string;
}

export async function uploadMapImageAction(_: UploadState, form: FormData): Promise<UploadState> {
  const actor = await adminActor();
  if (!actor) return { ok: false, message: NOT_ADMIN.message };
  const file = form.get('image');
  if (!(file instanceof File) || file.size === 0)
    return { ok: false, message: 'Choose an image first.' };
  if (file.size > MAX_IMAGE_BYTES)
    return { ok: false, message: 'The image must be 5 MB or smaller.' };
  const data = Buffer.from(await file.arrayBuffer());
  const info = imageInfo(data);
  if (!info) return { ok: false, message: 'Use a PNG, JPEG or WebP image.' };
  if (info.width > 20000 || info.height > 20000)
    return { ok: false, message: 'The image is too large (over 20,000 pixels on a side).' };
  await putSettingAsset(
    server().db.db,
    ASSET_KEYS.mapImage,
    { contentType: info.type, data, width: info.width, height: info.height },
    actor,
  );
  revalidatePath('/', 'layout');
  return {
    ok: true,
    message: `Uploaded (${info.width} × ${info.height} px). Set each site's Map X/Y in Settings → Sites.`,
  };
}

export async function deleteMapImageAction(): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await deleteSettingAsset(server().db.db, ASSET_KEYS.mapImage, actor);
  revalidatePath('/', 'layout');
}

/** What a wall link's screen shows: the classic wall, or NOC boards in turn. */
export async function setKioskBoardsAction(
  id: number,
  _: KioskFormState,
  form: FormData,
): Promise<KioskFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const classic = form.get('shows') !== 'boards';
  const boards = classic
    ? []
    : form
        .getAll('boards')
        .map(String)
        .filter((b) => boardRefSchema.safeParse(b).success)
        .slice(0, 12);
  if (!classic && !boards.length)
    return { ok: false, message: 'Choose at least one board, or the classic wall.' };
  const secRaw = String(form.get('rotateSec') ?? '').trim();
  const sec = secRaw ? Number(secRaw) : null;
  if (sec !== null && (!Number.isInteger(sec) || sec < 5 || sec > 600))
    return { ok: false, message: 'Seconds per board must be a whole number from 5 to 600.' };
  const ok = await setKioskBoards(server().db.db, id, { boards, rotateSec: sec }, actor);
  if (!ok) return { ok: false, message: 'That link no longer exists or was revoked.' };
  revalidatePath('/settings/wall');
  return {
    ok: true,
    message: classic
      ? 'Saved: the classic wall. The screen switches within a minute.'
      : `Saved: ${boards.length} board${boards.length === 1 ? '' : 's'}. The screen switches within a minute.`,
  };
}
