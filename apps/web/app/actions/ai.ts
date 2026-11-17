'use server';

import { revalidatePath } from 'next/cache';
import {
  AI_TEST_QUEUE,
  DIGEST_QUEUES,
  type AiTestJob,
  type AiTestResult,
  type DigestRunJob,
  type DigestRunResult,
} from '@mercer/core';
import { writeAudit } from '@mercer/db';
import type { ActionResult } from '@/components/stateful-form';
import { adminActor } from '@/lib/auth';
import { runWorkerJob } from '@/lib/jobs';
import { server } from '@/lib/server';

const NOT_ADMIN: ActionResult = { ok: false, message: 'Only administrators can do this.' };
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]*$/;

/** Settings → AI → Test: the worker makes one tiny call with the saved key. */
export async function aiTestAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const model = String(form.get('model') ?? '').trim();
  if (model && !MODEL_RE.test(model))
    return { ok: false, message: 'That is not a Claude model ID.', at: Date.now() };
  const job: AiTestJob = { by: actor.display, ...(model ? { model } : {}) };
  await writeAudit(server().db.db, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    ip: actor.ip,
    userAgent: actor.userAgent,
    action: 'ai.test',
    targetType: 'ai',
    after: { model: model || 'default' },
  });
  const res = await runWorkerJob<AiTestResult>(AI_TEST_QUEUE, job, 120_000);
  revalidatePath('/settings/ai');
  if (res.status !== 'completed') return { ok: false, message: res.message, at: Date.now() };
  return { ...res.output, at: Date.now() };
}

/** Settings → Digests → Send now (covers the period up to now; posts like the scheduled one). */
export async function digestNowAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await adminActor();
  if (!actor) return NOT_ADMIN;
  const kind = form.get('kind') === 'weekly' ? 'weekly' : 'daily';
  await writeAudit(server().db.db, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    ip: actor.ip,
    userAgent: actor.userAgent,
    action: 'digest.send',
    targetType: 'digest',
    after: { kind },
  });
  const job: DigestRunJob = { manual: true, by: actor.display };
  const res = await runWorkerJob<DigestRunResult>(DIGEST_QUEUES[kind], job, 240_000);
  revalidatePath('/settings/digests');
  revalidatePath('/digests');
  if (res.status !== 'completed') return { ok: false, message: res.message, at: Date.now() };
  return { ok: res.output.ok, message: res.output.message, at: Date.now() };
}
