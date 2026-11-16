import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sites } from './reference';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const orionNodes = pgTable(
  'orion_nodes',
  {
    nodeId: integer('node_id').primaryKey(),
    caption: text('caption').notNull(),
    dns: text('dns'),
    sysName: text('sys_name'),
    ipAddress: text('ip_address'),
    vendor: text('vendor'),
    machineType: text('machine_type'),
    status: smallint('status'),
    statusNorm: text('status_norm').notNull().default('unknown'),
    statusDescription: text('status_description'),
    responseTimeMs: real('response_time_ms'),
    percentLoss: real('percent_loss'),
    cpuLoad: real('cpu_load'),
    percentMemoryUsed: real('percent_memory_used'),
    lastBoot: ts('last_boot'),
    unmanaged: boolean('unmanaged').notNull().default(false),
    objectSubType: text('object_sub_type'),
    location: text('location'),
    isServer: boolean('is_server'),
    uri: text('uri'),
    customProperties: jsonb('custom_properties')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    divisionCode: text('division_code'),
    siteSource: text('site_source').notNull().default('none'),
    deviceRole: text('device_role').notNull().default('other'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastPolledAt: ts('last_polled_at').notNull().defaultNow(),
    lastStatusChangeAt: ts('last_status_change_at'),
    removedAt: ts('removed_at'),
  },
  (t) => [
    index('orion_nodes_site_idx').on(t.siteId),
    index('orion_nodes_status_idx').on(t.statusNorm),
  ],
);

export const orionInterfaces = pgTable(
  'orion_interfaces',
  {
    interfaceId: integer('interface_id').primaryKey(),
    nodeId: integer('node_id').notNull(),
    name: text('name'),
    caption: text('caption'),
    fullName: text('full_name'),
    alias: text('alias'),
    typeDescription: text('type_description'),
    status: smallint('status'),
    statusNorm: text('status_norm').notNull().default('unknown'),
    operStatus: smallint('oper_status'),
    adminStatus: smallint('admin_status'),
    inPercentUtil: real('in_percent_util'),
    outPercentUtil: real('out_percent_util'),
    inBps: doublePrecision('in_bps'),
    outBps: doublePrecision('out_bps'),
    speedBps: doublePrecision('speed_bps'),
    inErrorsHour: real('in_errors_hour'),
    outErrorsHour: real('out_errors_hour'),
    inDiscardsHour: real('in_discards_hour'),
    outDiscardsHour: real('out_discards_hour'),
    unmanaged: boolean('unmanaged').notNull().default(false),
    uri: text('uri'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastPolledAt: ts('last_polled_at').notNull().defaultNow(),
    lastStatusChangeAt: ts('last_status_change_at'),
    removedAt: ts('removed_at'),
  },
  (t) => [index('orion_interfaces_node_idx').on(t.nodeId)],
);

export const orionAlertConfigs = pgTable('orion_alert_configs', {
  alertId: integer('alert_id').primaryKey(),
  alertRefId: text('alert_ref_id'),
  name: text('name').notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  severity: smallint('severity').notNull().default(0),
  objectType: text('object_type'),
  syncedAt: ts('synced_at').notNull().defaultNow(),
});

export const orionActiveAlerts = pgTable(
  'orion_active_alerts',
  {
    alertActiveId: bigint('alert_active_id', { mode: 'number' }).primaryKey(),
    alertObjectId: integer('alert_object_id').notNull(),
    alertId: integer('alert_id').notNull(),
    alertName: text('alert_name').notNull(),
    severity: smallint('severity').notNull().default(0),
    objectType: text('object_type'),
    triggeredAt: ts('triggered_at'),
    message: text('message'),
    acknowledged: boolean('acknowledged').notNull().default(false),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: ts('acknowledged_at'),
    entityUri: text('entity_uri').notNull(),
    entityType: text('entity_type').notNull(),
    entityCaption: text('entity_caption'),
    relatedNodeId: integer('related_node_id'),
    relatedNodeCaption: text('related_node_caption'),
    nodeId: integer('node_id'),
    interfaceId: integer('interface_id'),
    siteId: integer('site_id'),
    triggerCount: integer('trigger_count'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    index('orion_active_alerts_object_idx').on(t.alertObjectId),
    index('orion_active_alerts_node_idx').on(t.nodeId),
    index('orion_active_alerts_site_idx').on(t.siteId),
  ],
);

export const topologyConnections = pgTable(
  'topology_connections',
  {
    id: serial('id').primaryKey(),
    srcNodeId: integer('src_node_id').notNull(),
    srcInterfaceId: integer('src_interface_id'),
    destNodeId: integer('dest_node_id').notNull(),
    destInterfaceId: integer('dest_interface_id'),
    layerType: text('layer_type'),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('topology_connections_uq').on(
      t.srcNodeId,
      t.srcInterfaceId,
      t.destNodeId,
      t.destInterfaceId,
      t.layerType,
    ),
    index('topology_connections_dest_idx').on(t.destNodeId),
  ],
);

export const orionDependencies = pgTable(
  'orion_dependencies',
  {
    dependencyId: integer('dependency_id').primaryKey(),
    name: text('name'),
    parentUri: text('parent_uri').notNull(),
    childUri: text('child_uri').notNull(),
    parentEntityType: text('parent_entity_type'),
    childEntityType: text('child_entity_type'),
    parentNodeId: integer('parent_node_id'),
    childNodeId: integer('child_node_id'),
    parentContainerId: integer('parent_container_id'),
    childContainerId: integer('child_container_id'),
    autoManaged: boolean('auto_managed').notNull().default(false),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [index('orion_dependencies_child_node_idx').on(t.childNodeId)],
);

export const orionGroups = pgTable('orion_groups', {
  containerId: integer('container_id').primaryKey(),
  name: text('name').notNull(),
  status: smallint('status'),
  description: text('description'),
  uri: text('uri'),
  syncedAt: ts('synced_at').notNull().defaultNow(),
});

export const orionGroupMembers = pgTable(
  'orion_group_members',
  {
    containerId: integer('container_id').notNull(),
    memberUri: text('member_uri').notNull(),
    memberEntityType: text('member_entity_type'),
    memberPrimaryId: integer('member_primary_id'),
    name: text('name'),
    status: smallint('status'),
    nodeId: integer('node_id'),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.containerId, t.memberUri] }),
    index('orion_group_members_node_idx').on(t.nodeId),
  ],
);

/** Orion.StatusInfo (status code names) — refreshed hourly. */
export const orionStatusInfo = pgTable('orion_status_info', {
  statusId: integer('status_id').primaryKey(),
  statusName: text('status_name').notNull(),
});
