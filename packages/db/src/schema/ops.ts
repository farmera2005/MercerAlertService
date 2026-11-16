import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { actorType, pollStatus } from './enums';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const pollerState = pgTable('poller_state', {
  poller: text('poller').primaryKey(),
  lastStartedAt: ts('last_started_at'),
  lastSuccessAt: ts('last_success_at'),
  lastErrorAt: ts('last_error_at'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastDurationMs: integer('last_duration_ms'),
  lastRowCount: integer('last_row_count'),
  cursor: jsonb('cursor').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const pollRuns = pgTable(
  'poll_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    poller: text('poller').notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
    status: pollStatus('status').notNull(),
    rowCount: integer('row_count').notNull().default(0),
    transitionCount: integer('transition_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull(),
    error: text('error'),
  },
  (t) => [index('poll_runs_poller_started_idx').on(t.poller, t.startedAt)],
);

export const componentHeartbeats = pgTable('component_heartbeats', {
  component: text('component').primaryKey(),
  lastBeatAt: ts('last_beat_at').notNull(),
  status: text('status').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  version: text('version'),
  host: text('host'),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
  ],
);
