'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AI_CHAT_QUEUE, type ChatJob } from '@mercer/core';
import {
  addChatQuestion,
  countRecentQuestions,
  deleteChatThread,
  finishChatAnswer,
} from '@mercer/db';
import type { ActionResult } from '@/components/stateful-form';
import { currentUser, userActor } from '@/lib/auth';
import { enqueueWorkerJob } from '@/lib/jobs';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

const MAX_QUESTION = 2000;

/** Ask a question (in `threadId`, or a new conversation). The worker answers it. */
export async function askAction(
  threadId: number | null,
  _: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const user = await currentUser();
  const actor = await userActor();
  if (!user || !actor) return { ok: false, message: 'Please sign in again.' };
  const cfg = await effectiveConfig();
  if (!cfg.ai.enabled || !cfg.ai.chat.enabled)
    return { ok: false, message: 'Ask the network is switched off.', at: Date.now() };
  const question = String(form.get('question') ?? '').trim();
  if (!question) return { ok: false, errors: { question: 'Type a question.' }, at: Date.now() };
  if (question.length > MAX_QUESTION)
    return {
      ok: false,
      errors: { question: `Keep it under ${MAX_QUESTION} characters.` },
      at: Date.now(),
    };
  const userKey = `${user.kind}:${user.id}`;
  const { db } = server();
  const asked = await countRecentQuestions(db.db, userKey, new Date(Date.now() - 3_600_000));
  if (asked >= cfg.ai.chat.perHour)
    return {
      ok: false,
      message: `That is ${asked} questions in the last hour, the limit per person. Try again later.`,
      at: Date.now(),
    };
  const r = await addChatQuestion(
    db.db,
    { threadId, question, userKey, userLabel: user.label },
    actor,
  );
  if (!r.ok) return { ok: false, message: r.error, at: Date.now() };
  const job: ChatJob = { threadId: r.threadId, answerId: r.answerId };
  try {
    await enqueueWorkerJob(AI_CHAT_QUEUE, job);
  } catch (err) {
    server().log.warn({ err: (err as Error).message }, 'could not queue a chat answer');
    await finishChatAnswer(db.db, r.threadId, r.answerId, {
      status: 'error',
      text: 'The MAS worker is not reachable, so the question could not be answered.',
      citations: [],
      steps: [],
      error: 'queue unavailable',
      model: null,
      costUsd: 0,
      historyAppend: [],
      redaction: {},
      seenRefs: [],
    });
  }
  if (threadId === null) redirect(`/ask/${r.threadId}`);
  revalidatePath(`/ask/${r.threadId}`);
  return { ok: true, at: Date.now() };
}

export async function deleteThreadAction(form: FormData): Promise<void> {
  const user = await currentUser();
  const actor = await userActor();
  if (!user || !actor) return;
  const id = Number(form.get('id'));
  if (Number.isInteger(id) && id > 0)
    await deleteChatThread(server().db.db, id, `${user.kind}:${user.id}`, actor);
  redirect('/ask');
}
