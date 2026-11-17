import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { RouteMatch } from '@mercer/core';
import { incidents, incidentKind, incidentStatus, priority } from './incidents';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const channelKind = pgEnum('channel_kind', ['teams', 'sms', 'pushover']);
export const notificationPurpose = pgEnum('notification_purpose', [
  'incident_open',
  'incident_update',
  'incident_resolved',
  'escalation',
  'self_alert',
  'test',
  'digest',
]);
export const notificationStatus = pgEnum('notification_status', [
  'queued',
  'sent',
  'failed',
  'suppressed',
]);
export const pageVia = pgEnum('page_via', ['sms', 'pushover', 'both', 'none']);

/** Teams channels, each a Workflows webhook. The URL is a secret: sealed with SecretBox. */
export const notificationChannels = pgTable('notification_channels', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  webhookUrlEnc: text('webhook_url_enc'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const routingRules = pgTable('routing_rules', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  match: jsonb('match').$type<RouteMatch>().notNull().default({}),
  channelKey: text('channel_key').references(() => notificationChannels.key, {
    onDelete: 'set null',
    onUpdate: 'cascade',
  }),
  pageOncall: boolean('page_oncall').notNull().default(false),
  escalateAfterMin: integer('escalate_after_min'),
  stop: boolean('stop').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const people = pgTable('people', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'),
  phoneE164: text('phone_e164'),
  pushoverUserKey: text('pushover_user_key'),
  pageVia: pageVia('page_via').notNull().default('sms'),
  isItLead: boolean('is_it_lead').notNull().default(false),
  active: boolean('active').notNull().default(true),
  rotationPosition: integer('rotation_position'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Explicit on-call weeks; weeks without a row follow the rotation order in `people`. */
export const oncallWeeks = pgTable('oncall_weeks', {
  id: serial('id').primaryKey(),
  weekStart: date('week_start', { mode: 'string' }).notNull().unique(),
  primaryPersonId: integer('primary_person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  secondaryPersonId: integer('secondary_person_id').references(() => people.id, {
    onDelete: 'set null',
  }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const oncallOverrides = pgTable(
  'oncall_overrides',
  {
    id: serial('id').primaryKey(),
    personId: integer('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    reason: text('reason'),
    createdBy: text('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('oncall_overrides_ends_idx').on(t.endsAt)],
);

/**
 * Every notification, sent or not, and the outbox the sender works from: `queued` rows with
 * `next_attempt_at` due are claimed, sent and marked `sent` / requeued with backoff / `failed`.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    incidentId: bigint('incident_id', { mode: 'number' }).references(() => incidents.id, {
      onDelete: 'cascade',
    }),
    purpose: notificationPurpose('purpose').notNull(),
    kind: channelKind('kind').notNull(),
    channelKey: text('channel_key'),
    personId: integer('person_id').references(() => people.id, { onDelete: 'set null' }),
    recipient: text('recipient').notNull(),
    payload: jsonb('payload').notNull(),
    status: notificationStatus('status').notNull(),
    suppressReason: text('suppress_reason'),
    shadow: boolean('shadow').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    providerRef: text('provider_ref'),
    threadRef: text('thread_ref'),
    createdAt: ts('created_at').notNull(),
    nextAttemptAt: ts('next_attempt_at'),
    sentAt: ts('sent_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('notifications_outbox_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'queued'`),
    index('notifications_incident_idx').on(t.incidentId, t.createdAt),
    index('notifications_person_idx').on(t.personId, t.createdAt),
  ],
);

export const escalations = pgTable(
  'escalations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    incidentId: bigint('incident_id', { mode: 'number' })
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    level: smallint('level').notNull(),
    afterMin: integer('after_min').notNull(),
    dueAt: ts('due_at').notNull(),
    firedAt: ts('fired_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('escalations_pending_idx')
      .on(t.dueAt)
      .where(sql`${t.firedAt} IS NULL AND ${t.cancelledAt} IS NULL`),
    index('escalations_incident_idx').on(t.incidentId),
  ],
);

/** What has been announced for each incident (the dispatcher's memory). */
export const incidentNotifyState = pgTable('incident_notify_state', {
  incidentId: bigint('incident_id', { mode: 'number' })
    .primaryKey()
    .references(() => incidents.id, { onDelete: 'cascade' }),
  lastStatus: incidentStatus('last_status').notNull(),
  lastPriority: priority('last_priority').notNull(),
  lastKind: incidentKind('last_kind').notNull(),
  lastMaterialRev: integer('last_material_rev').notNull(),
  updateCount: integer('update_count').notNull().default(0),
  pagedAt: ts('paged_at'),
  pagedPersonIds: integer('paged_person_ids')
    .array()
    .notNull()
    .default(sql`'{}'::int[]`),
  lastSnoozedUntil: ts('last_snoozed_until'),
  baselined: boolean('baselined').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** /i/<code> links for SMS and push (short enough for a 300-character message). */
export const shortLinks = pgTable(
  'short_links',
  {
    code: text('code').primaryKey(),
    incidentId: bigint('incident_id', { mode: 'number' })
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [uniqueIndex('short_links_incident_uq').on(t.incidentId)],
);

/** Delivery health per Teams channel and provider; drives the dashboard banner and self-alerts. */
export const notifierHealth = pgTable('notifier_health', {
  key: text('key').primaryKey(),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessAt: ts('last_success_at'),
  lastFailureAt: ts('last_failure_at'),
  lastError: text('last_error'),
  lastAlertedAt: ts('last_alerted_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
