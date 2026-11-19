/**
 * "Ask the network" answers. The web app stores the question with a pending answer and queues
 * `ai.chat`; this job runs the tool loop (packages/ai), streams progress to the person who
 * asked over the event bus, and stores the answer. The tools are read-only database queries.
 */
import { runChatTurn } from '@mercer/ai';
import {
  errorMessage,
  localDateTime,
  stablePrefix,
  type BusEvent,
  type ChatJob,
} from '@mercer/core';
import {
  failStaleChatAnswers,
  finishChatAnswer,
  getChatMessages,
  loadSiteProfiles,
  publishEvent,
  runChatTool,
  chatThreads,
} from '@mercer/db';
import { eq } from 'drizzle-orm';
import { aiRunner, type AiDeps } from './ai';

/** Streamed text is batched into events of at most this many characters (pg_notify limit). */
const DELTA_MAX = 1500;
const FLUSH_MS = 250;

export interface ChatJobResult {
  status: string;
  steps: number;
}

export async function runChatJob(d: AiDeps, job: ChatJob): Promise<ChatJobResult> {
  const now = d.now();
  const [thread] = await d.db.select().from(chatThreads).where(eq(chatThreads.id, job.threadId));
  if (!thread) return { status: 'missing', steps: 0 };
  const messages = await getChatMessages(d.db, thread.id);
  const answer = messages.find((m) => m.id === job.answerId);
  if (!answer || answer.status !== 'pending') return { status: 'not_pending', steps: 0 };
  const question = [...messages].reverse().find((m) => m.role === 'user' && m.id < answer.id);

  const publish = (ev: Omit<Extract<BusEvent, { t: 'chat' }>, 't' | 'thread' | 'user'>) =>
    publishEvent(d.db, { t: 'chat', thread: thread.id, user: thread.userKey, ...ev }).catch(
      (err: unknown) => d.log.warn({ err: errorMessage(err) }, 'chat event not published'),
    );

  if (!d.cfg.ai.enabled || !d.cfg.ai.chat.enabled || !question) {
    await finishChatAnswer(d.db, thread.id, answer.id, {
      status: 'error',
      text: !question
        ? 'The question was not found.'
        : 'Ask the network is switched off (Settings → AI).',
      citations: [],
      steps: [],
      error: 'disabled',
      model: null,
      costUsd: 0,
      historyAppend: [],
      redaction: thread.redaction,
      seenRefs: thread.seenRefs,
    });
    await publish({ k: 'done' });
    return { status: 'disabled', steps: 0 };
  }

  // Batch streamed text so a long answer is a handful of events, not hundreds.
  let buffer = '';
  let timer: NodeJS.Timeout | null = null;
  let sending: Promise<unknown> = Promise.resolve();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (buffer) {
      const part = buffer.slice(0, DELTA_MAX);
      buffer = buffer.slice(DELTA_MAX);
      sending = sending.then(() => publish({ k: 'delta', text: part }));
    }
  };

  const result = await runChatTurn(aiRunner(d), {
    model: d.cfg.ai.models.chat,
    prefix: stablePrefix(d.cfg.ai.environmentNotes, await loadSiteProfiles(d.db)),
    history: thread.history as never,
    redaction: thread.redaction,
    seenRefs: thread.seenRefs,
    question: question.text,
    nowLocal: localDateTime(now, d.cfg.timezone),
    timeZone: d.cfg.timezone,
    executeTool: (name, input) =>
      runChatTool(d.db, name, input, { now: d.now(), timeZone: d.cfg.timezone }),
    onStep: (label) => {
      flush();
      sending = sending.then(() => publish({ k: 'step', text: label.slice(0, 300) }));
    },
    onText: (delta) => {
      buffer += delta;
      if (buffer.length >= DELTA_MAX) flush();
      else timer ??= setTimeout(flush, FLUSH_MS);
    },
  });
  flush();
  await sending;
  await finishChatAnswer(d.db, thread.id, answer.id, {
    status: result.status,
    text: result.text,
    citations: result.citations,
    steps: result.steps,
    error: result.error,
    model: result.model,
    costUsd: result.costUsd,
    historyAppend: result.historyAppend,
    redaction: result.redaction,
    seenRefs: result.seenRefs,
  });
  await publish({ k: 'done' });
  d.log.info(
    {
      thread: thread.id,
      status: result.status,
      steps: result.steps.length,
      costUsd: result.costUsd,
    },
    'chat answer',
  );
  return { status: result.status, steps: result.steps.length };
}

/** Pending answers older than this were lost (worker restart); tell the person. */
export async function failStaleChats(d: AiDeps): Promise<number> {
  return failStaleChatAnswers(d.db, new Date(d.now().getTime() - 6 * 60_000));
}
