'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  HOURS_MATCH,
  INCIDENT_KINDS,
  isLegacyWorkflowUrl,
  NOTIFY_TEST_QUEUE,
  type NotifyTestJob,
  type NotifyTestResult,
  PAGE_VIA,
  PRIORITIES,
  type RouteMatch,
  zonedTimeToUtc,
} from '@mercer/core';
import {
  CHANNEL_KEY_RE,
  createOverride,
  deleteChannel,
  deleteOverride,
  deletePerson,
  deleteRoutingRule,
  moveRoutingRule,
  saveChannel,
  savePerson,
  saveRoutingRule,
  setOncallWeek,
} from '@mercer/db';
import { adminActor } from '@/lib/auth';
import { runWorkerJob } from '@/lib/jobs';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export interface NotifyFormState {
  ok?: boolean;
  message?: string;
  errors?: Record<string, string>;
  at?: number;
}

const NOT_ADMIN: NotifyFormState = { ok: false, message: 'Only administrators can change this.' };
const fail = (errors: Record<string, string>): NotifyFormState => ({
  ok: false,
  message: 'Please fix the highlighted fields.',
  errors,
  at: Date.now(),
});
const issues = (e: z.ZodError) =>
  Object.fromEntries(e.issues.map((i) => [String(i.path[0] ?? 'form'), i.message]));
const text = (form: FormData, k: string) => String(form.get(k) ?? '').trim();
const optional = (v: string) => (v === '' ? null : v);

function refresh() {
  revalidatePath('/settings', 'layout');
}

// ---------------------------------------------------------------------------------------------
// Teams channels
// ---------------------------------------------------------------------------------------------

const channelSchema = z.object({
  key: z.string().regex(CHANNEL_KEY_RE, 'lower-case letters, digits and dashes, e.g. net-critical'),
  name: z.string().min(1, 'Required').max(120),
  description: z.string().max(300),
  enabled: z.boolean(),
  webhookUrl: z
    .string()
    .max(2000)
    .refine(
      (v) => v === '' || /^https?:\/\//.test(v),
      'Paste the full URL from the Workflows trigger',
    ),
});

export async function saveChannelAction(
  _: NotifyFormState,
  form: FormData,
): Promise<NotifyFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const p = channelSchema.safeParse({
    key: text(form, 'key'),
    name: text(form, 'name'),
    description: text(form, 'description'),
    enabled: form.get('enabled') === 'on',
    webhookUrl: text(form, 'webhookUrl'),
  });
  if (!p.success) return fail(issues(p.error));
  const cfg = await effectiveConfig();
  if (p.data.webhookUrl.startsWith('http://') && !cfg.notify.allowHttp)
    return fail({ webhookUrl: 'Teams webhooks use https://' });
  const webhookUrl =
    form.get('removeWebhook') === 'on'
      ? null
      : p.data.webhookUrl === ''
        ? undefined
        : p.data.webhookUrl;
  await saveChannel(
    server().db.db,
    server().box,
    {
      key: p.data.key,
      name: p.data.name,
      description: optional(p.data.description),
      enabled: p.data.enabled,
      webhookUrl,
    },
    actor,
  );
  refresh();
  if (webhookUrl && isLegacyWorkflowUrl(webhookUrl))
    return {
      ok: true,
      at: Date.now(),
      message:
        'Saved, but this is an old logic.azure.com address, which Microsoft stopped accepting for Teams workflows after 30 November 2025. Open the workflow in the Teams Workflows app (Edit → expand the first step) and paste its current URL.',
    };
  return { ok: true, message: 'Saved.', at: Date.now() };
}

export async function deleteChannelAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await deleteChannel(server().db.db, text(form, 'key'), actor);
  refresh();
}

/** Ask the worker to send a test message now and wait for the result. */
export async function testSendAction(_: NotifyFormState, form: FormData): Promise<NotifyFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const kind = text(form, 'kind');
  const target: NotifyTestJob['target'] =
    kind === 'teams'
      ? { kind: 'teams', channelKey: text(form, 'channelKey') }
      : { kind: kind === 'pushover' ? 'pushover' : 'sms', personId: Number(form.get('personId')) };
  const job: NotifyTestJob = { target, by: actor.display };
  const res = await runWorkerJob<NotifyTestResult>(NOTIFY_TEST_QUEUE, job, 30_000);
  refresh();
  if (res.status !== 'completed') return { ok: false, message: res.message, at: Date.now() };
  return { ...res.output, at: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Routing rules
// ---------------------------------------------------------------------------------------------

const ruleSchema = z.object({
  name: z.string().min(1, 'Required').max(120),
  enabled: z.boolean(),
  priorities: z.array(z.enum(PRIORITIES)),
  kinds: z.array(z.enum(INCIDENT_KINDS)),
  divisions: z.array(z.string().max(40)),
  siteIds: z.array(z.number().int().positive()),
  hours: z.enum(HOURS_MATCH),
  channelKey: z.string().max(40),
  pageOncall: z.boolean(),
  escalateAfterMin: z.union([z.literal(''), z.coerce.number().int().min(1).max(240)]),
  stop: z.boolean(),
});

export async function saveRuleAction(
  id: number | null,
  _: NotifyFormState,
  form: FormData,
): Promise<NotifyFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const p = ruleSchema.safeParse({
    name: text(form, 'name'),
    enabled: form.get('enabled') === 'on',
    priorities: form.getAll('priorities').map(String),
    kinds: form.getAll('kinds').map(String),
    divisions: form.getAll('divisions').map(String),
    siteIds: form.getAll('siteIds').map(Number),
    hours: text(form, 'hours') || 'any',
    channelKey: text(form, 'channelKey'),
    pageOncall: form.get('pageOncall') === 'on',
    escalateAfterMin: text(form, 'escalateAfterMin'),
    stop: form.get('stop') === 'on',
  });
  if (!p.success) return fail(issues(p.error));
  const d = p.data;
  if (!d.channelKey && !d.pageOncall)
    return fail({ channelKey: 'Choose a channel, page on-call, or both.' });
  const match: RouteMatch = {
    ...(d.priorities.length ? { priorities: d.priorities } : {}),
    ...(d.kinds.length ? { kinds: d.kinds } : {}),
    ...(d.divisions.length ? { divisions: d.divisions } : {}),
    ...(d.siteIds.length ? { siteIds: d.siteIds } : {}),
    ...(d.hours !== 'any' ? { hours: d.hours } : {}),
  };
  await saveRoutingRule(
    server().db.db,
    id,
    {
      name: d.name,
      enabled: d.enabled,
      match,
      channelKey: d.channelKey || null,
      pageOncall: d.pageOncall,
      escalateAfterMin: d.escalateAfterMin === '' ? null : d.escalateAfterMin,
      stop: d.stop,
    },
    actor,
  );
  refresh();
  return { ok: true, message: id ? 'Rule saved.' : 'Rule added.', at: Date.now() };
}

export async function deleteRuleAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await deleteRoutingRule(server().db.db, Number(form.get('id')), actor);
  refresh();
}

export async function moveRuleAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await moveRoutingRule(
    server().db.db,
    Number(form.get('id')),
    form.get('direction') === 'up' ? 'up' : 'down',
    actor,
  );
  refresh();
}

// ---------------------------------------------------------------------------------------------
// People and on-call
// ---------------------------------------------------------------------------------------------

const personSchema = z.object({
  name: z.string().min(1, 'Required').max(120),
  email: z.union([z.literal(''), z.email('Not an e-mail address')]),
  phoneE164: z.union([
    z.literal(''),
    z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +14195550123'),
  ]),
  pushoverUserKey: z.union([
    z.literal(''),
    z.string().regex(/^[A-Za-z0-9]{30}$/, 'A Pushover user key is 30 letters and digits'),
  ]),
  pageVia: z.enum(PAGE_VIA),
  isItLead: z.boolean(),
  active: z.boolean(),
  rotationPosition: z.union([z.literal(''), z.coerce.number().int().min(1).max(99)]),
});

export async function savePersonAction(
  id: number | null,
  _: NotifyFormState,
  form: FormData,
): Promise<NotifyFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const p = personSchema.safeParse({
    name: text(form, 'name'),
    email: text(form, 'email'),
    phoneE164: text(form, 'phoneE164').replace(/[\s().-]/g, ''),
    pushoverUserKey: text(form, 'pushoverUserKey'),
    pageVia: text(form, 'pageVia') || 'sms',
    isItLead: form.get('isItLead') === 'on',
    active: form.get('active') === 'on',
    rotationPosition: text(form, 'rotationPosition'),
  });
  if (!p.success) return fail(issues(p.error));
  const d = p.data;
  // Missing contact details are allowed (pages are then recorded as "no contact"), but say so.
  const missing =
    (d.pageVia === 'sms' || d.pageVia === 'both') && !d.phoneE164
      ? 'a mobile number'
      : (d.pageVia === 'pushover' || d.pageVia === 'both') && !d.pushoverUserKey
        ? 'a Pushover user key'
        : null;
  await savePerson(
    server().db.db,
    id,
    {
      name: d.name,
      email: optional(d.email),
      phoneE164: optional(d.phoneE164),
      pushoverUserKey: optional(d.pushoverUserKey),
      pageVia: d.pageVia,
      isItLead: d.isItLead,
      active: d.active,
      rotationPosition: d.rotationPosition === '' ? null : d.rotationPosition,
    },
    actor,
  );
  refresh();
  const done = id ? 'Saved.' : 'Person added.';
  return {
    ok: true,
    message:
      missing && d.active ? `${done} ${d.name} cannot be paged until ${missing} is added.` : done,
    at: Date.now(),
  };
}

export async function deletePersonAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await deletePerson(server().db.db, Number(form.get('id')), actor);
  refresh();
}

export async function setWeekAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  const weekStart = text(form, 'weekStart');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return;
  const primary = Number(form.get('primary')) || null;
  const secondary = Number(form.get('secondary')) || null;
  await setOncallWeek(server().db.db, weekStart, primary, primary ? secondary : null, actor);
  refresh();
}

/** "2026-11-16T14:30" (browser datetime-local) in APP_TIMEZONE. */
function parseLocal(value: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  return m ? zonedTimeToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, 0, 0, tz) : null;
}

export async function createOverrideAction(
  _: NotifyFormState,
  form: FormData,
): Promise<NotifyFormState> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const tz = (await effectiveConfig()).timezone;
  const personId = Number(form.get('personId'));
  const startsAt = parseLocal(text(form, 'startsAt'), tz);
  const endsAt = parseLocal(text(form, 'endsAt'), tz);
  const errors: Record<string, string> = {};
  if (!personId) errors.personId = 'Choose who covers.';
  if (!startsAt) errors.startsAt = 'Required.';
  if (!endsAt) errors.endsAt = 'Required.';
  else if (startsAt && endsAt <= startsAt) errors.endsAt = 'Must be after the start.';
  if (Object.keys(errors).length) return fail(errors);
  await createOverride(
    server().db.db,
    { personId, startsAt: startsAt!, endsAt: endsAt!, reason: optional(text(form, 'reason')) },
    actor,
  );
  refresh();
  return { ok: true, message: 'Cover added.', at: Date.now() };
}

export async function deleteOverrideAction(form: FormData): Promise<void> {
  const actor = await adminActor();
  if (!actor) return;
  await deleteOverride(server().db.db, Number(form.get('id')), actor);
  refresh();
}
