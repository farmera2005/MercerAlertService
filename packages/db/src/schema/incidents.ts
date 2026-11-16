import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { PriorityFactors } from '@mercer/core';
import { sites } from './reference';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const alertState = pgEnum('alert_state', ['active', 'cleared']);
export const incidentStatus = pgEnum('incident_status', [
  'open',
  'acknowledged',
  'resolved',
  'closed',
]);
export const incidentKind = pgEnum('incident_kind', [
  'site_outage',
  'device_down',
  'flapping',
  'interface',
  'ups_power',
  'service',
  'monitoring_source_down',
  'generic',
]);
export const priority = pgEnum('priority', ['P1', 'P2', 'P3', 'P4']);
export const memberRole = pgEnum('member_role', ['root', 'symptom', 'member']);
export const seasonKind = pgEnum('season_kind', ['harvest', 'high_risk']);
export const maintenanceScope = pgEnum('maintenance_scope', ['global', 'site', 'node']);
export const maintenanceSuppress = pgEnum('maintenance_suppress', ['notifications', 'incidents']);

export const incidents = pgTable(
  'incidents',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    status: incidentStatus('status').notNull().default('open'),
    kind: incidentKind('kind').notNull().default('generic'),
    correlationKey: text('correlation_key').notNull(),
    title: text('title').notNull(),
    templateSummary: text('template_summary').notNull().default(''),
    aiTitle: text('ai_title'),
    aiSummary: jsonb('ai_summary'),
    aiSummaryAt: ts('ai_summary_at'),
    aiSummaryRev: integer('ai_summary_rev').notNull().default(0),
    priority: priority('priority').notNull(),
    basePriority: priority('base_priority').notNull(),
    baseScore: real('base_score').notNull().default(0),
    priorityFactors: jsonb('priority_factors').$type<PriorityFactors>().notNull(),
    aiPriorityAdjust: smallint('ai_priority_adjust'),
    aiPriorityReason: text('ai_priority_reason'),
    guardrailNote: text('guardrail_note'),
    primarySiteId: integer('primary_site_id').references(() => sites.id, { onDelete: 'set null' }),
    divisionCode: text('division_code'),
    affectedSiteIds: integer('affected_site_ids')
      .array()
      .notNull()
      .default(sql`'{}'::int[]`),
    rootNodeId: integer('root_node_id'),
    rootEntityUri: text('root_entity_uri'),
    recoveryTargetMin: integer('recovery_target_min').notNull(),
    openedAt: ts('opened_at').notNull(),
    lastActivityAt: ts('last_activity_at').notNull(),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by'),
    resolvePendingSince: ts('resolve_pending_since'),
    resolvedAt: ts('resolved_at'),
    resolvedBy: text('resolved_by'),
    closedAt: ts('closed_at'),
    snoozedUntil: ts('snoozed_until'),
    snoozedBy: text('snoozed_by'),
    alertCount: integer('alert_count').notNull().default(0),
    memberCount: integer('member_count').notNull().default(0),
    materialRev: integer('material_rev').notNull().default(0),
    inMaintenance: boolean('in_maintenance').notNull().default(false),
    seeded: boolean('seeded').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('incidents_open_idx')
      .on(t.status)
      .where(sql`${t.status} IN ('open','acknowledged')`),
    index('incidents_site_status_idx').on(t.primarySiteId, t.status),
    index('incidents_opened_idx').on(t.openedAt),
  ],
);

export const alertRecords = pgTable(
  'alert_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    dedupeKey: text('dedupe_key').notNull(),
    source: text('source').notNull().default('orion'),
    alertId: integer('alert_id'),
    alertName: text('alert_name').notNull(),
    entityUri: text('entity_uri'),
    entityType: text('entity_type'),
    entityCaption: text('entity_caption'),
    nodeId: integer('node_id'),
    interfaceId: integer('interface_id'),
    siteId: integer('site_id'),
    severity: text('severity').notNull().default('none'),
    state: alertState('state').notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    lastRaisedAt: ts('last_raised_at').notNull(),
    clearedAt: ts('cleared_at'),
    triggerCount: integer('trigger_count').notNull().default(1),
    currentAlertObjectId: integer('current_alert_object_id'),
    currentAlertActiveId: bigint('current_alert_active_id', { mode: 'number' }),
    lastMessage: text('last_message'),
    acknowledgedInOrion: boolean('acknowledged_in_orion').notNull().default(false),
    incidentId: bigint('incident_id', { mode: 'number' }).references(() => incidents.id, {
      onDelete: 'set null',
    }),
    suppressed: boolean('suppressed').notNull().default(false),
    seeded: boolean('seeded').notNull().default(false),
  },
  (t) => [
    uniqueIndex('alert_records_dedupe_uq').on(t.dedupeKey),
    index('alert_records_incident_idx').on(t.incidentId),
    index('alert_records_node_state_idx').on(t.nodeId, t.state),
    index('alert_records_active_idx')
      .on(t.state)
      .where(sql`${t.state} = 'active'`),
  ],
);

export const incidentMembers = pgTable(
  'incident_members',
  {
    incidentId: bigint('incident_id', { mode: 'number' })
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    alertRecordId: bigint('alert_record_id', { mode: 'number' })
      .notNull()
      .references(() => alertRecords.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('member'),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.incidentId, t.alertRecordId] }),
    index('incident_members_record_idx').on(t.alertRecordId),
  ],
);

export const incidentEvents = pgTable(
  'incident_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    incidentId: bigint('incident_id', { mode: 'number' })
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    type: text('type').notNull(),
    actor: text('actor').notNull().default('system'),
    message: text('message').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (t) => [index('incident_events_incident_idx').on(t.incidentId, t.at)],
);

/** Harvest window and other high-risk periods (Settings → Seasons). */
export const seasonPeriods = pgTable('season_periods', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  kind: seasonKind('kind').notNull(),
  startMd: text('start_md').notNull(),
  endMd: text('end_md').notNull(),
  year: integer('year'),
  multiplier: real('multiplier').notNull().default(1.2),
  divisions: text('divisions').array(),
  harvestCriticalOnly: boolean('harvest_critical_only').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export interface MaintenanceRecurrence {
  /** ISO weekdays, 1 = Monday … 7 = Sunday */
  weekdays: number[];
  /** "HH:MM" in APP_TIMEZONE */
  start: string;
  durationMin: number;
}

export const maintenanceWindows = pgTable(
  'maintenance_windows',
  {
    id: serial('id').primaryKey(),
    scope: maintenanceScope('scope').notNull(),
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    nodeId: integer('node_id'),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at'),
    recurrence: jsonb('recurrence').$type<MaintenanceRecurrence | null>(),
    suppress: maintenanceSuppress('suppress').notNull().default('notifications'),
    reason: text('reason'),
    createdBy: text('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('maintenance_windows_ends_idx').on(t.endsAt)],
);
