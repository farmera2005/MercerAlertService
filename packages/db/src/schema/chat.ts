import {
  bigint,
  bigserial,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { Citation } from '@mercer/core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const chatRole = pgEnum('chat_role', ['user', 'assistant']);
export const chatStatus = pgEnum('chat_status', [
  'pending',
  'ok',
  'error',
  'refused',
  'budget_blocked',
]);

/** One conversation in "Ask the network", owned by one person. */
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** `local:<id>` or `entra:<id>`: only this person sees the thread. */
    userKey: text('user_key').notNull(),
    userLabel: text('user_label').notNull(),
    title: text('title').notNull(),
    /**
     * The API conversation exactly as sent (redacted, thinking blocks included). Append-only, so
     * later turns hit the prompt cache and keep the model's earlier reasoning valid.
     */
    history: jsonb('history').$type<unknown[]>().notNull().default([]),
    /** Placeholder → value map, so `[IP-1]` means the same address in every turn. */
    redaction: jsonb('redaction').$type<Record<string, string>>().notNull().default({}),
    /** Refs (INC-42, NODE-7, SITE-ROCK) that tools returned in this thread. */
    seenRefs: text('seen_refs')
      .array()
      .notNull()
      .default([] as string[]),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('chat_threads_user_idx').on(t.userKey, t.updatedAt)],
);

/** What people see: questions and answers (the API history lives on the thread). */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    threadId: bigint('thread_id', { mode: 'number' })
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: chatRole('role').notNull(),
    /** The question, or the answer with placeholders restored. */
    text: text('text').notNull().default(''),
    status: chatStatus('status').notNull().default('ok'),
    citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
    /** The tool calls behind an answer, as shown to the user ("Searching incidents (…)"). */
    steps: jsonb('steps').$type<string[]>().notNull().default([]),
    error: text('error'),
    model: text('model'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 5, mode: 'number' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [index('chat_messages_thread_idx').on(t.threadId, t.id)],
);
