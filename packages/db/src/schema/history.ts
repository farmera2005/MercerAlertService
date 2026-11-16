import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { transitionKind } from './enums';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** State changes observed in SWIS (the raw input to correlation). */
export const entityTransitions = pgTable(
  'entity_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: transitionKind('kind').notNull(),
    /** alert: raised|retriggered|cleared|acked|unacked · node/interface: status · source: down|up */
    change: text('change').notNull(),
    entityKey: text('entity_key').notNull(),
    nodeId: integer('node_id'),
    interfaceId: integer('interface_id'),
    siteId: integer('site_id'),
    alertObjectId: integer('alert_object_id'),
    alertActiveId: bigint('alert_active_id', { mode: 'number' }),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    observedAt: ts('observed_at').notNull().defaultNow(),
    /** Orion-side timestamp when known (e.g. TriggeredDateTime). */
    sourceAt: ts('source_at'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    correlatedAt: ts('correlated_at'),
  },
  (t) => [
    index('entity_transitions_pending_idx')
      .on(t.id)
      .where(sql`${t.correlatedAt} IS NULL`),
    index('entity_transitions_node_idx').on(t.nodeId, t.observedAt),
    index('entity_transitions_entity_idx').on(t.kind, t.entityKey, t.observedAt),
    index('entity_transitions_observed_idx').on(t.observedAt),
  ],
);

export const nodeMetrics5m = pgTable(
  'node_metrics_5m',
  {
    nodeId: integer('node_id').notNull(),
    bucket: ts('bucket').notNull(),
    samples: integer('samples').notNull().default(1),
    rtAvg: real('rt_avg'),
    rtMax: real('rt_max'),
    lossAvg: real('loss_avg'),
    lossMax: real('loss_max'),
    cpuAvg: real('cpu_avg'),
    cpuMax: real('cpu_max'),
    memAvg: real('mem_avg'),
    memMax: real('mem_max'),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.bucket] }),
    index('node_metrics_5m_bucket_idx').on(t.bucket),
  ],
);

export const interfaceMetrics5m = pgTable(
  'interface_metrics_5m',
  {
    interfaceId: integer('interface_id').notNull(),
    bucket: ts('bucket').notNull(),
    samples: integer('samples').notNull().default(1),
    inUtilAvg: real('in_util_avg'),
    inUtilMax: real('in_util_max'),
    outUtilAvg: real('out_util_avg'),
    outUtilMax: real('out_util_max'),
    inBpsAvg: real('in_bps_avg'),
    outBpsAvg: real('out_bps_avg'),
    inErrors: real('in_errors'),
    outErrors: real('out_errors'),
    inDiscards: real('in_discards'),
    outDiscards: real('out_discards'),
  },
  (t) => [
    primaryKey({ columns: [t.interfaceId, t.bucket] }),
    index('interface_metrics_5m_bucket_idx').on(t.bucket),
  ],
);

export const orionEvents = pgTable(
  'orion_events',
  {
    eventId: bigint('event_id', { mode: 'number' }).primaryKey(),
    eventTime: ts('event_time'),
    eventType: integer('event_type').notNull(),
    eventTypeName: text('event_type_name'),
    message: text('message'),
    nodeId: integer('node_id'),
    netObjectId: text('net_object_id'),
    netObjectType: text('net_object_type'),
    acknowledged: boolean('acknowledged').notNull().default(false),
    ingestedAt: ts('ingested_at').notNull().defaultNow(),
  },
  (t) => [
    index('orion_events_node_time_idx').on(t.nodeId, t.eventTime),
    index('orion_events_time_idx').on(t.eventTime),
  ],
);

export const orionAlertHistory = pgTable(
  'orion_alert_history',
  {
    alertHistoryId: bigint('alert_history_id', { mode: 'number' }).primaryKey(),
    eventType: smallint('event_type').notNull(),
    message: text('message'),
    at: ts('at'),
    accountId: text('account_id'),
    alertActiveId: bigint('alert_active_id', { mode: 'number' }),
    alertObjectId: integer('alert_object_id'),
    alertId: integer('alert_id'),
    entityUri: text('entity_uri'),
    relatedNodeId: integer('related_node_id'),
    ingestedAt: ts('ingested_at').notNull().defaultNow(),
  },
  (t) => [
    index('orion_alert_history_alert_idx').on(t.alertId, t.at),
    index('orion_alert_history_at_idx').on(t.at),
  ],
);
