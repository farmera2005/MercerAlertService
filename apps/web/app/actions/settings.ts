'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  errorMessage,
  GROUPS_POLL_QUEUE,
  isSecretSetting,
  normalizeKey,
  settingsForSection,
  type SettingSection,
} from '@mercer/core';
import {
  addSiteAlias,
  createSite,
  deleteSite,
  setSiteGroupDecision,
  siteGroupInfo,
  updateSite,
} from '@mercer/db';
import {
  SETUP_QUEUES,
  type CertJobOutput,
  type ConnectionInput,
  type DiscoverJobOutput,
  type TestJobOutput,
} from '@mercer/swis/setup-contract';
import { adminActor } from '@/lib/auth';
import { enqueueWorkerJob, runWorkerJob } from '@/lib/jobs';
import { server } from '@/lib/server';
import { changesFromForm, saveChanges } from '@/lib/settings';
import { requestSiteNotesSave } from '@/lib/writeback';

export interface FormState {
  ok?: boolean;
  message?: string;
  errors?: Record<string, string>;
  /** Non-secret submitted values, echoed back on failure (see SettingField `submitted`). */
  values?: Record<string, string>;
}

function echo(
  form: FormData,
  exclude: (key: string) => boolean = () => false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v !== 'string' || k.startsWith('$ACTION') || exclude(k)) continue;
    if (k.startsWith('present:')) {
      const key = k.slice('present:'.length);
      out[key] ??= '';
    } else out[k] = v;
  }
  return out;
}

const NOT_SIGNED_IN: FormState = { ok: false, message: 'Your session has expired. Sign in again.' };

/** Save every rendered field of one or more registry sections. */
export async function saveSectionsAction(
  sections: SettingSection[],
  _: FormState,
  form: FormData,
): Promise<FormState> {
  const actor = await adminActor();
  if (!actor) return NOT_SIGNED_IN;
  const keys = sections.flatMap((s) => settingsForSection(s).map((d) => d.key));
  const res = await saveChanges(changesFromForm(form, keys), actor);
  if (!res.ok) return { ...res, values: echo(form, isSecretSetting) };
  revalidatePath('/', 'layout');
  return res;
}

// ---------------------------------------------------------------------------------------------
// Orion connection (run by the worker)
// ---------------------------------------------------------------------------------------------

function connectionFromForm(form: FormData): ConnectionInput {
  const { box } = server();
  const str = (k: string) => (form.has(k) ? String(form.get(k) ?? '') : undefined);
  const input: ConnectionInput = {};
  const host = str('SWIS_HOST');
  if (host !== undefined) input.host = host.trim();
  const port = str('SWIS_PORT');
  if (port) input.port = Number(port);
  const baseUrl = str('SWIS_BASE_URL');
  if (baseUrl !== undefined) input.baseUrl = baseUrl.trim();
  const user = str('SWIS_USERNAME');
  if (user !== undefined) input.username = user.trim();
  const password = str('SWIS_PASSWORD');
  if (password) input.passwordSealed = box.seal(password);
  const pem = str('SWIS_CA_CERT_PEM');
  if (pem !== undefined) input.caCertPem = pem;
  const servername = str('SWIS_TLS_SERVERNAME');
  if (servername !== undefined) input.servername = servername;
  if (form.has('present:SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY'))
    input.insecure = form.get('SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY') === 'on';
  return input;
}

export type CertState = { result?: CertJobOutput; message?: string };
export type TestState = { result?: TestJobOutput; message?: string };

export async function fetchCertificateAction(_: CertState, form: FormData): Promise<CertState> {
  if (!(await adminActor())) return { message: NOT_SIGNED_IN.message };
  const r = await runWorkerJob<CertJobOutput>(SETUP_QUEUES.cert, connectionFromForm(form), 30_000);
  return r.status === 'completed' ? { result: r.output } : { message: r.message };
}

export async function testConnectionAction(_: TestState, form: FormData): Promise<TestState> {
  if (!(await adminActor())) return { message: NOT_SIGNED_IN.message };
  const r = await runWorkerJob<TestJobOutput>(SETUP_QUEUES.test, connectionFromForm(form), 45_000);
  return r.status === 'completed' ? { result: r.output } : { message: r.message };
}

export type DiscoverState = { result?: DiscoverJobOutput; message?: string };

export async function runDiscoveryAction(_: DiscoverState): Promise<DiscoverState> {
  if (!(await adminActor())) return { message: NOT_SIGNED_IN.message };
  const r = await runWorkerJob<DiscoverJobOutput>(SETUP_QUEUES.discover, {}, 120_000);
  revalidatePath('/', 'layout');
  if (r.status !== 'completed') return { message: r.message };
  // The full report is stored by the worker and re-read by the page; keep the action payload small.
  return r.output.ok
    ? { message: `Discovery finished at ${new Date(r.output.at).toLocaleTimeString('en-US')}.` }
    : { result: r.output };
}

// ---------------------------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------------------------

/** Checked division codes (the repo keeps only known ones). */
function divisionCodesFrom(form: FormData): string[] {
  return form
    .getAll('divisionCodes')
    .map(String)
    .filter((c) => /^[a-z0-9_]{1,40}$/.test(c))
    .slice(0, 20);
}

function siteFromForm(form: FormData) {
  const num = (k: string) => {
    const v = String(form.get(k) ?? '').trim();
    return v === '' ? null : Number(v);
  };
  const text = (k: string) => {
    const v = String(form.get(k) ?? '').trim();
    return v === '' ? null : v;
  };
  return {
    name: String(form.get('name') ?? '').trim(),
    divisionCodes: divisionCodesFrom(form),
    city: text('city'),
    state: text('state'),
    lat: num('lat'),
    lon: num('lon'),
    mapX: num('mapX'),
    mapY: num('mapY'),
    tier: (['critical', 'high', 'standard'].includes(String(form.get('tier')))
      ? form.get('tier')
      : 'standard') as 'critical' | 'high' | 'standard',
    harvestCritical: form.get('harvestCritical') === 'on',
    aliases: String(form.get('aliases') ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    ownerGroup: text('ownerGroup'),
    contactNotes: text('contactNotes'),
  };
}

function validateSite(s: ReturnType<typeof siteFromForm>): Record<string, string> {
  const e: Record<string, string> = {};
  if (!s.name) e.name = 'Required.';
  if (s.lat !== null && (!Number.isFinite(s.lat) || s.lat < -90 || s.lat > 90))
    e.lat = 'Latitude between -90 and 90.';
  if (s.lon !== null && (!Number.isFinite(s.lon) || s.lon < -180 || s.lon > 180))
    e.lon = 'Longitude between -180 and 180.';
  for (const k of ['mapX', 'mapY'] as const)
    if (s[k] !== null && (!Number.isInteger(s[k]) || s[k]! < 0 || s[k]! > 20000))
      e[k] = 'Whole pixels from the top-left corner of the map image.';
  return e;
}

export async function saveSiteAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await adminActor();
  if (!actor) return NOT_SIGNED_IN;
  const s = siteFromForm(form);
  const errors = validateSite(s);
  // Checkboxes repeat a name, which echo() would collapse to the last one.
  const values = () => ({ ...echo(form), divisionCodes: s.divisionCodes.join(',') });
  if (Object.keys(errors).length)
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      errors,
      values: values(),
    };
  const id = Number(form.get('id') ?? 0);
  const { db } = server();
  const linked = id ? (await siteGroupInfo(db.db, [id])).get(id) : undefined;
  let notesMessage: { ok: boolean; message: string } | null = null;
  try {
    if (id && linked) {
      // Linked to a SolarWinds group: the name follows the group, and the notes are the group
      // description (written by the worker), so neither is saved here.
      const { name: _name, contactNotes: _notes, ...rest } = s;
      await updateSite(db.db, id, rest, actor);
      const text = String(form.get('groupNotes') ?? '').replace(/\r\n/g, '\n');
      const base = form.has('groupNotesBase') ? String(form.get('groupNotesBase')) : null;
      if (form.has('groupNotes') && text.trim() !== (base ?? '').replace(/\r\n/g, '\n').trim()) {
        if (text.length > 4000)
          return {
            ok: false,
            message: 'Notes can be at most 4,000 characters.',
            errors: { groupNotes: 'Too long.' },
            values: values(),
          };
        notesMessage = await requestSiteNotesSave(id, text.trim(), base, actor);
      }
    } else if (id) await updateSite(db.db, id, s, actor);
    else await createSite(db.db, s, actor);
  } catch (err) {
    if (String(err).includes('sites_code_unique'))
      return {
        ok: false,
        message: 'A site with that name already exists.',
        errors: { name: 'Already exists.' },
        values: values(),
      };
    throw err;
  }
  revalidatePath('/', 'layout');
  if (notesMessage)
    return {
      ok: notesMessage.ok,
      message: `Site saved. ${notesMessage.message}`,
    };
  return { ok: true, message: id ? 'Site saved.' : 'Site added.' };
}

export async function deleteSiteAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await deleteSite(server().db.db, Number(form.get('id')), actor);
  revalidatePath('/', 'layout');
}

/** Resolve an Orion "Site" value that matched no profile: new site, or alias of an existing one. */
export async function mapOrionSiteValueAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  const value = String(form.get('value') ?? '').trim();
  const target = String(form.get('target') ?? '');
  if (!value || !normalizeKey(value)) return;
  const { db } = server();
  if (target === 'new') {
    await createSite(
      db.db,
      {
        name: value,
        aliases: [value],
        tier: 'standard',
        harvestCritical: false,
        divisionCodes: divisionCodesFrom(form),
      },
      actor,
    ).catch(() => {});
  } else if (Number(target)) {
    await addSiteAlias(db.db, Number(target), value, actor);
  }
  revalidatePath('/', 'layout');
}

// ---------------------------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------------------------

export async function finishSetupAction(_: FormState): Promise<FormState> {
  const actor = await adminActor();
  if (!actor) return NOT_SIGNED_IN;
  const res = await saveChanges({}, actor, { MAS_SETUP_COMPLETE: 'true' });
  if (!res.ok) return res;
  redirect('/?welcome=1');
}

/**
 * "Use as a site" / "Not a site" / "Undo" on Settings → Mapping: an admin decision about one
 * SolarWinds group. It wins over detection and the manual settings; the worker re-reads the
 * groups at once so sites are linked or unlinked within seconds.
 */
export async function setSiteGroupDecisionAction(
  containerId: number,
  groupName: string,
  decision: 'site' | 'not_site' | null,
): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  if (!Number.isInteger(containerId) || containerId <= 0) return;
  const { db, log } = server();
  await setSiteGroupDecision(
    db.db,
    { containerId, groupName: groupName.slice(0, 300), decision },
    actor,
  );
  await enqueueWorkerJob(GROUPS_POLL_QUEUE, {}).catch((err: unknown) =>
    log.warn({ err: errorMessage(err) }, 'could not queue a groups poll'),
  );
  revalidatePath('/settings/mapping');
  revalidatePath('/setup/mapping');
}
