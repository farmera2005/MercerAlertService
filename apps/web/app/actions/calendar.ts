'use server';

import { revalidatePath } from 'next/cache';
import { zonedTimeToUtc } from '@mercer/core';
import { createMaintenance, deleteSeason, endMaintenance, saveSeason } from '@mercer/db';
import { adminActor } from '@/lib/auth';
import { getSettingsState } from '@/lib/settings';
import { server } from '@/lib/server';
import type { FormState } from './settings';

const NOT_SIGNED_IN: FormState = { ok: false, message: 'Your session has expired. Sign in again.' };
const MD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function values(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries())
    if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v;
  return out;
}

export async function saveSeasonAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await adminActor();
  if (!actor) return NOT_SIGNED_IN;
  const id = Number(form.get('id') ?? 0) || null;
  const name = String(form.get('name') ?? '').trim();
  const kind = form.get('kind') === 'harvest' ? 'harvest' : 'high_risk';
  const startMd = String(form.get('startMd') ?? '').trim();
  const endMd = String(form.get('endMd') ?? '').trim();
  const yearRaw = String(form.get('year') ?? '').trim();
  const multiplier = Number(form.get('multiplier'));
  const divisions = form.getAll('divisions').map(String).filter(Boolean);
  const errors: Record<string, string> = {};
  if (!name) errors.name = 'Required.';
  if (!MD.test(startMd)) errors.startMd = 'Use MM-DD, e.g. 09-01.';
  if (!MD.test(endMd)) errors.endMd = 'Use MM-DD, e.g. 12-15.';
  if (yearRaw && !/^\d{4}$/.test(yearRaw)) errors.year = 'A 4-digit year, or empty for every year.';
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 3)
    errors.multiplier = 'Between 1 and 3.';
  if (Object.keys(errors).length)
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      errors,
      values: values(form),
    };
  await saveSeason(
    server().db.db,
    id,
    {
      name,
      kind,
      startMd,
      endMd,
      year: yearRaw ? Number(yearRaw) : null,
      multiplier,
      divisions: divisions.length ? divisions : null,
      harvestCriticalOnly: form.get('harvestCriticalOnly') === 'on',
      enabled: form.get('enabled') === 'on',
    },
    actor,
  );
  revalidatePath('/', 'layout');
  return { ok: true, message: id ? 'Season saved.' : 'Season added.' };
}

export async function deleteSeasonAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await deleteSeason(server().db.db, Number(form.get('id')), actor);
  revalidatePath('/', 'layout');
}

/** "2026-11-16T14:30" (browser datetime-local) interpreted in APP_TIMEZONE. */
function parseLocal(value: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return zonedTimeToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, 0, 0, tz);
}

export async function createMaintenanceAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await adminActor();
  if (!actor) return NOT_SIGNED_IN;
  const tz = (await getSettingsState()).cfg?.timezone ?? 'America/New_York';
  const scope =
    (['global', 'site', 'node'] as const).find((s) => s === form.get('scope')) ?? 'site';
  const siteId = Number(form.get('siteId') ?? 0) || null;
  const nodeId = Number(form.get('nodeId') ?? 0) || null;
  const startsAt = parseLocal(String(form.get('startsAt') ?? ''), tz);
  const endsRaw = String(form.get('endsAt') ?? '');
  const endsAt = endsRaw ? parseLocal(endsRaw, tz) : null;
  const recurring = form.get('recurring') === 'on';
  const weekdays = form
    .getAll('weekdays')
    .map(Number)
    .filter((d) => d >= 1 && d <= 7);
  const recStart = String(form.get('recStart') ?? '');
  const duration = Number(form.get('durationMin'));
  const errors: Record<string, string> = {};
  if (scope === 'site' && !siteId) errors.siteId = 'Pick a site.';
  if (scope === 'node' && !nodeId) errors.nodeId = 'Pick a device.';
  if (!startsAt) errors.startsAt = 'Required.';
  if (endsRaw && !endsAt) errors.endsAt = 'Invalid date.';
  if (startsAt && endsAt && endsAt <= startsAt) errors.endsAt = 'Must be after the start.';
  if (!recurring && !endsAt) errors.endsAt = 'A one-off window needs an end.';
  if (recurring) {
    if (!weekdays.length) errors.weekdays = 'Pick at least one day.';
    if (!HHMM.test(recStart)) errors.recStart = 'Use HH:MM.';
    if (!Number.isInteger(duration) || duration < 5 || duration > 1440)
      errors.durationMin = '5–1440 minutes.';
  }
  if (Object.keys(errors).length)
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      errors,
      values: values(form),
    };
  await createMaintenance(
    server().db.db,
    {
      scope,
      siteId: scope === 'site' ? siteId : null,
      nodeId: scope === 'node' ? nodeId : null,
      startsAt: startsAt!,
      endsAt,
      recurrence: recurring ? { weekdays, start: recStart, durationMin: duration } : null,
      suppress: form.get('suppress') === 'incidents' ? 'incidents' : 'notifications',
      reason: String(form.get('reason') ?? '').trim() || null,
    },
    actor,
  );
  revalidatePath('/', 'layout');
  return { ok: true, message: 'Maintenance window added.' };
}

export async function endMaintenanceAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await endMaintenance(server().db.db, Number(form.get('id')), actor);
  revalidatePath('/', 'layout');
}
