/**
 * "Ask the network" storage: threads belong to one person; each question gets a pending answer
 * row that the worker fills in. The API history on the thread is only ever appended to.
 */
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Citation } from '@mercer/core';
import { chatMessages, chatThreads, incidents, orionNodes, sites } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

export type ChatThreadRow = typeof chatThreads.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;

/** Questions per thread; a longer conversation should start afresh. */
export const MAX_QUESTIONS_PER_THREAD = 25;

export async function listChatThreads(db: DbOrTx, userKey: string, limit = 50) {
  return db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.userKey, userKey))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(limit);
}

/** The thread if it belongs to `userKey` (null otherwise: no peeking at other people's chats). */
export async function getChatThread(
  db: DbOrTx,
  id: number,
  userKey: string,
): Promise<ChatThreadRow | null> {
  const [t] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, id), eq(chatThreads.userKey, userKey)));
  return t ?? null;
}

export async function getChatMessages(db: DbOrTx, threadId: number): Promise<ChatMessageRow[]> {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.id));
}

/** Questions asked by this person since `since` (for the per-hour limit). */
export async function countRecentQuestions(
  db: DbOrTx,
  userKey: string,
  since: Date,
): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(
      and(
        eq(chatThreads.userKey, userKey),
        eq(chatMessages.role, 'user'),
        gte(chatMessages.createdAt, since),
      ),
    );
  return r?.n ?? 0;
}

export type AskResult =
  | { ok: true; threadId: number; questionId: number; answerId: number }
  | { ok: false; error: string };

/**
 * Store a question (in a new thread when `threadId` is null) and a pending answer for the worker
 * to fill. Audited in the same transaction.
 */
export async function addChatQuestion(
  db: Db,
  input: { threadId: number | null; question: string; userKey: string; userLabel: string },
  actor: Actor,
  now = new Date(),
): Promise<AskResult> {
  return db.transaction(async (tx) => {
    let threadId = input.threadId;
    if (threadId !== null) {
      const t = await getChatThread(tx, threadId, input.userKey);
      if (!t) return { ok: false, error: 'That conversation does not exist.' };
      const [busy] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(chatMessages)
        .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.status, 'pending')));
      if ((busy?.n ?? 0) > 0)
        return { ok: false, error: 'Wait for the answer to the previous question.' };
      const [asked] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(chatMessages)
        .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, 'user')));
      if ((asked?.n ?? 0) >= MAX_QUESTIONS_PER_THREAD)
        return {
          ok: false,
          error: 'This conversation is long enough. Start a new one for the next question.',
        };
      await tx.update(chatThreads).set({ updatedAt: now }).where(eq(chatThreads.id, threadId));
    } else {
      const title = input.question.replace(/\s+/g, ' ').trim();
      const [t] = await tx
        .insert(chatThreads)
        .values({
          userKey: input.userKey,
          userLabel: input.userLabel,
          title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: chatThreads.id });
      threadId = t!.id;
    }
    const [q] = await tx
      .insert(chatMessages)
      .values({ threadId, role: 'user', text: input.question, createdAt: now, completedAt: now })
      .returning({ id: chatMessages.id });
    const [a] = await tx
      .insert(chatMessages)
      .values({ threadId, role: 'assistant', status: 'pending', createdAt: now })
      .returning({ id: chatMessages.id });
    // The question text stays in the thread; the audit row records that it was asked.
    await writeAudit(tx, {
      ...actor,
      action: 'chat.ask',
      targetType: 'chat_thread',
      targetId: threadId,
      after: { chars: input.question.length, newThread: input.threadId === null },
    });
    return { ok: true, threadId, questionId: q!.id, answerId: a!.id };
  });
}

export interface ChatAnswer {
  status: 'ok' | 'error' | 'refused' | 'budget_blocked';
  text: string;
  citations: Citation[];
  steps: string[];
  error: string | null;
  model: string | null;
  costUsd: number;
  /** API messages of this turn, appended to the thread history only on success. */
  historyAppend: unknown[];
  redaction: Record<string, string>;
  seenRefs: string[];
}

/** Fill in a pending answer; extend the thread history only when the turn completed. */
export async function finishChatAnswer(
  db: Db,
  threadId: number,
  answerId: number,
  a: ChatAnswer,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(chatMessages)
      .set({
        status: a.status,
        text: a.text,
        citations: a.citations,
        steps: a.steps,
        error: a.error?.slice(0, 1000) ?? null,
        model: a.model,
        costUsd: a.costUsd,
        completedAt: now,
      })
      .where(and(eq(chatMessages.id, answerId), eq(chatMessages.threadId, threadId)));
    await tx
      .update(chatThreads)
      .set({
        updatedAt: now,
        ...(a.status === 'ok' && a.historyAppend.length
          ? {
              history: sql`${chatThreads.history} || ${JSON.stringify(a.historyAppend)}::jsonb`,
              redaction: a.redaction,
              seenRefs: a.seenRefs,
            }
          : {}),
      })
      .where(eq(chatThreads.id, threadId));
  });
}

/** Answers left pending by a crashed worker are failed after this long. */
export async function failStaleChatAnswers(db: DbOrTx, olderThan: Date): Promise<number> {
  const r = await db
    .update(chatMessages)
    .set({
      status: 'error',
      error: 'The answer was interrupted. Please ask again.',
      completedAt: sql`now()`,
    })
    .where(and(eq(chatMessages.status, 'pending'), sql`${chatMessages.createdAt} < ${olderThan}`))
    .returning({ id: chatMessages.id });
  return r.length;
}

export async function deleteChatThread(
  db: Db,
  id: number,
  userKey: string,
  actor: Actor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await tx
      .delete(chatThreads)
      .where(and(eq(chatThreads.id, id), eq(chatThreads.userKey, userKey)))
      .returning({ id: chatThreads.id });
    if (!r.length) return false;
    await writeAudit(tx, {
      ...actor,
      action: 'chat.delete',
      targetType: 'chat_thread',
      targetId: id,
    });
    return true;
  });
}

/** Display labels for cited refs: incident titles, device hostnames, site names. */
export async function chatSourceLabels(
  db: DbOrTx,
  refs: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const incIds = refs.filter((r) => r.startsWith('INC-')).map((r) => Number(r.slice(4)));
  const nodeIds = refs.filter((r) => r.startsWith('NODE-')).map((r) => Number(r.slice(5)));
  const siteCodes = refs.filter((r) => r.startsWith('SITE-')).map((r) => r.slice(5).toLowerCase());
  if (incIds.length)
    for (const i of await db
      .select({ id: incidents.id, title: incidents.title, aiTitle: incidents.aiTitle })
      .from(incidents)
      .where(inArray(incidents.id, incIds.slice(0, 200))))
      out[`INC-${i.id}`] = i.aiTitle ?? i.title;
  if (nodeIds.length)
    for (const n of await db
      .select({ id: orionNodes.nodeId, caption: orionNodes.caption })
      .from(orionNodes)
      .where(inArray(orionNodes.nodeId, nodeIds.slice(0, 200))))
      out[`NODE-${n.id}`] = n.caption;
  if (siteCodes.length)
    for (const s of await db
      .select({ code: sites.code, name: sites.name })
      .from(sites)
      .where(inArray(sql`lower(${sites.code})`, siteCodes.slice(0, 200))))
      out[`SITE-${s.code.toUpperCase()}`] = s.name;
  return out;
}
