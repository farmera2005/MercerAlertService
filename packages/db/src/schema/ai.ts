import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { DigestContent, DigestFacts } from '@mercer/core';
import { incidents } from './incidents';
import { notifications } from './notify';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const aiPurpose = pgEnum('ai_purpose', [
  'severity',
  'summary',
  'digest_daily',
  'digest_weekly',
  'test',
  'chat',
]);
/**
 * One row per logical call. ok: first answer valid · retried: valid after the one retry ·
 * fallback: invalid twice, template used · error: API error or timeout · refused: the model
 * declined · budget_blocked: not sent, the daily budget is spent.
 */
export const aiCallStatus = pgEnum('ai_call_status', [
  'ok',
  'retried',
  'fallback',
  'error',
  'refused',
  'budget_blocked',
]);
export const digestKind = pgEnum('digest_kind', ['daily', 'weekly']);
export const digestSource = pgEnum('digest_source', ['ai', 'template']);

export const aiCalls = pgTable(
  'ai_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    purpose: aiPurpose('purpose').notNull(),
    model: text('model').notNull(),
    incidentId: bigint('incident_id', { mode: 'number' }).references(() => incidents.id, {
      onDelete: 'set null',
    }),
    attempts: smallint('attempts').notNull().default(1),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 5, mode: 'number' }).notNull().default(0),
    status: aiCallStatus('status').notNull(),
    stopReason: text('stop_reason'),
    /** Model that answered when a server-side fallback ran. */
    servedBy: text('served_by'),
    error: text('error'),
    redacted: boolean('redacted').notNull().default(false),
    requestId: text('request_id'),
  },
  (t) => [index('ai_calls_at_idx').on(t.at), index('ai_calls_incident_idx').on(t.incidentId)],
);

export const digests = pgTable(
  'digests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: digestKind('kind').notNull(),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    source: digestSource('source').notNull(),
    content: jsonb('content').$type<DigestContent>().notNull(),
    facts: jsonb('facts').$type<DigestFacts>().notNull(),
    markdown: text('markdown').notNull(),
    aiCallId: bigint('ai_call_id', { mode: 'number' }).references(() => aiCalls.id, {
      onDelete: 'set null',
    }),
    notificationId: bigint('notification_id', { mode: 'number' }).references(
      () => notifications.id,
      { onDelete: 'set null' },
    ),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('digests_kind_period_uq').on(t.kind, t.periodStart)],
);
