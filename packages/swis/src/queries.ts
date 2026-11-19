/**
 * The SWQL catalog. This is the ONLY place SWQL is written (see CLAUDE.md rule 4).
 * Keep docs/swql-queries.md in sync with every change here.
 */
import type { QuerySpec } from './query-builder';

const f = (alias: string, prop: string, required = false, as?: string) => ({
  alias,
  prop,
  required,
  as,
});

/** Q1 — active alerts with their alert object and definition. */
export const ACTIVE_ALERTS: QuerySpec = {
  name: 'activeAlerts',
  entities: { aa: 'Orion.AlertActive', ao: 'Orion.AlertObjects', ac: 'Orion.AlertConfigurations' },
  fields: [
    f('aa', 'AlertActiveID', true),
    f('aa', 'AlertObjectID', true),
    f('aa', 'TriggeredDateTime', true),
    f('aa', 'TriggeredMessage'),
    f('aa', 'Acknowledged', true),
    f('aa', 'AcknowledgedBy'),
    f('aa', 'AcknowledgedDateTime'),
    f('ao', 'AlertID', true),
    f('ao', 'EntityUri', true),
    f('ao', 'EntityType', true),
    f('ao', 'EntityCaption'),
    f('ao', 'RelatedNodeId'),
    f('ao', 'RelatedNodeUri'),
    f('ao', 'RelatedNodeCaption'),
    f('ao', 'TriggeredCount'),
    f('ao', 'LastTriggeredDateTime'),
    f('ac', 'Name', true, 'AlertName'),
    f('ac', 'Severity', true),
    f('ac', 'ObjectType'),
  ],
  from:
    'Orion.AlertActive aa ' +
    'INNER JOIN Orion.AlertObjects ao ON ao.AlertObjectID = aa.AlertObjectID ' +
    'INNER JOIN Orion.AlertConfigurations ac ON ac.AlertID = ao.AlertID',
  orderBy: ['aa.AlertActiveID'],
};

/** Q2 — nodes; custom-property columns are appended dynamically as `cp.<Field> AS CP_<Field>`. */
export const NODES: QuerySpec = {
  name: 'nodes',
  entities: { n: 'Orion.Nodes', cp: 'Orion.NodesCustomProperties' },
  fields: [
    f('n', 'NodeID', true),
    f('n', 'Caption', true),
    f('n', 'DNS'),
    f('n', 'SysName'),
    f('n', 'IPAddress'),
    f('n', 'Status', true),
    f('n', 'StatusDescription'),
    f('n', 'ResponseTime'),
    f('n', 'PercentLoss'),
    f('n', 'CPULoad'),
    f('n', 'PercentMemoryUsed'),
    f('n', 'Vendor'),
    f('n', 'MachineType'),
    f('n', 'LastBoot'),
    f('n', 'Unmanaged'),
    f('n', 'ObjectSubType'),
    f('n', 'Location'),
    f('n', 'IsServer'),
    f('n', 'Uri'),
  ],
  from: 'Orion.Nodes n',
  joinForExtras: 'LEFT JOIN Orion.NodesCustomProperties cp ON cp.NodeID = n.NodeID',
  orderBy: ['n.NodeID'],
};

export const CUSTOM_PROPERTY_PREFIX = 'CP_';

/** Q3 — interfaces. */
export const INTERFACES: QuerySpec = {
  name: 'interfaces',
  entities: { i: 'Orion.NPM.Interfaces' },
  fields: [
    f('i', 'InterfaceID', true),
    f('i', 'NodeID', true),
    f('i', 'Name'),
    f('i', 'Caption'),
    f('i', 'FullName'),
    f('i', 'Alias'),
    f('i', 'TypeDescription'),
    f('i', 'Status', true),
    f('i', 'OperStatus'),
    f('i', 'AdminStatus'),
    f('i', 'InPercentUtil'),
    f('i', 'OutPercentUtil'),
    f('i', 'Inbps', false, 'InBps'),
    f('i', 'Outbps', false, 'OutBps'),
    f('i', 'Speed'),
    f('i', 'InErrorsThisHour'),
    f('i', 'OutErrorsThisHour'),
    f('i', 'InDiscardsThisHour'),
    f('i', 'OutDiscardsThisHour'),
    f('i', 'UnManaged', false, 'Unmanaged'),
    f('i', 'Uri'),
  ],
  from: 'Orion.NPM.Interfaces i',
  orderBy: ['i.InterfaceID'],
};

/** Q4 — L2/L3 topology links. */
export const TOPOLOGY_CONNECTIONS: QuerySpec = {
  name: 'topologyConnections',
  entities: { tc: 'Orion.TopologyConnections' },
  fields: [
    f('tc', 'SrcNodeID', true),
    f('tc', 'SrcInterfaceID', true),
    f('tc', 'DestNodeID', true),
    f('tc', 'DestInterfaceID', true),
    f('tc', 'LayerType'),
  ],
  from: 'Orion.TopologyConnections tc',
  orderBy: ['tc.SrcNodeID', 'tc.SrcInterfaceID', 'tc.DestNodeID', 'tc.DestInterfaceID'],
};

/** Q5 — Orion dependencies (parent/child). */
export const DEPENDENCIES: QuerySpec = {
  name: 'dependencies',
  entities: { d: 'Orion.Dependencies' },
  fields: [
    f('d', 'DependencyId', true),
    f('d', 'Name'),
    f('d', 'ParentUri', true),
    f('d', 'ChildUri', true),
    f('d', 'AutoManaged'),
    f('d', 'ParentEntityType'),
    f('d', 'ChildEntityType'),
  ],
  from: 'Orion.Dependencies d',
  orderBy: ['d.DependencyId'],
};

/** Q6 — groups. */
export const GROUPS: QuerySpec = {
  name: 'groups',
  entities: { c: 'Orion.Container' },
  fields: [
    f('c', 'ContainerID', true),
    f('c', 'Name', true),
    f('c', 'Status'),
    f('c', 'Description'),
    f('c', 'Uri'),
  ],
  from: 'Orion.Container c',
  orderBy: ['c.ContainerID'],
};

/** Q7 — group members. */
export const GROUP_MEMBERS: QuerySpec = {
  name: 'groupMembers',
  entities: { m: 'Orion.ContainerMembers' },
  fields: [
    f('m', 'ContainerID', true),
    f('m', 'MemberUri', true),
    f('m', 'MemberPrimaryID'),
    f('m', 'MemberEntityType'),
    f('m', 'Name'),
    f('m', 'Status'),
  ],
  from: 'Orion.ContainerMembers m',
  orderBy: ['m.ContainerID', 'm.MemberUri'],
};

/** Q8 — alert definitions. */
export const ALERT_CONFIGS: QuerySpec = {
  name: 'alertConfigs',
  entities: { ac: 'Orion.AlertConfigurations' },
  fields: [
    f('ac', 'AlertID', true),
    f('ac', 'AlertRefID'),
    f('ac', 'Name', true),
    f('ac', 'Description'),
    f('ac', 'Enabled'),
    f('ac', 'Severity', true),
    f('ac', 'ObjectType'),
  ],
  from: 'Orion.AlertConfigurations ac',
  orderBy: ['ac.AlertID'],
};

/** Q9 — events, incremental by EventID. */
export const EVENTS: QuerySpec = {
  name: 'events',
  entities: { e: 'Orion.Events', et: 'Orion.EventTypes' },
  fields: [
    f('e', 'EventID', true),
    f('e', 'EventTime', true),
    f('e', 'EventType', true),
    f('et', 'Name', false, 'EventTypeName'),
    f('e', 'Message'),
    f('e', 'NetworkNode'),
    f('e', 'NetObjectID'),
    f('e', 'NetObjectType'),
    f('e', 'Acknowledged'),
  ],
  from: 'Orion.Events e LEFT JOIN Orion.EventTypes et ON et.EventType = e.EventType',
  where: 'e.EventID > @cursor',
  orderBy: ['e.EventID'],
};
export const EVENTS_MAX_ID = 'SELECT MAX(e.EventID) AS MaxId FROM Orion.Events e';

/** Q10 — alert history, incremental by AlertHistoryID. */
export const ALERT_HISTORY: QuerySpec = {
  name: 'alertHistory',
  entities: { ah: 'Orion.AlertHistory', ao: 'Orion.AlertObjects' },
  fields: [
    f('ah', 'AlertHistoryID', true),
    f('ah', 'EventType', true),
    f('ah', 'TimeStamp', true),
    f('ah', 'Message'),
    f('ah', 'AccountID'),
    f('ah', 'AlertActiveID'),
    f('ah', 'AlertObjectID'),
    f('ao', 'AlertID'),
    f('ao', 'EntityUri'),
    f('ao', 'RelatedNodeId'),
  ],
  from: 'Orion.AlertHistory ah LEFT JOIN Orion.AlertObjects ao ON ao.AlertObjectID = ah.AlertObjectID',
  where: 'ah.AlertHistoryID > @cursor',
  orderBy: ['ah.AlertHistoryID'],
};
export const ALERT_HISTORY_MAX_ID =
  'SELECT MAX(ah.AlertHistoryID) AS MaxId FROM Orion.AlertHistory ah';

/** Q11 — status code names. */
export const STATUS_INFO: QuerySpec = {
  name: 'statusInfo',
  entities: { si: 'Orion.StatusInfo' },
  fields: [f('si', 'StatusId', true), f('si', 'StatusName', true)],
  from: 'Orion.StatusInfo si',
  orderBy: ['si.StatusId'],
};

/** Q12 — node custom-property columns. */
export const NODE_CUSTOM_PROPERTIES =
  'SELECT cp.Field AS Field, cp.DataType AS DataType, cp.Description AS Description ' +
  'FROM Orion.CustomProperty cp WHERE cp.TargetEntity = @target';
export const NODE_CUSTOM_PROPERTIES_TARGET = 'Orion.NodesCustomProperties';

/** Q13 — schema probe. Entity names are bound as @e0..@eN. */
export function schemaProbeQuery(count: number): string {
  const params = Array.from({ length: count }, (_, i) => `@e${i}`).join(', ');
  return `SELECT p.EntityName AS EntityName, p.Name AS Name, p.Type AS Type FROM Metadata.Property p WHERE p.EntityName IN (${params})`;
}

/** Columns on Orion.NodesCustomProperties that are not user-defined custom properties. */
export const CUSTOM_PROPERTY_SYSTEM_COLUMNS = new Set([
  'NodeID',
  'InstanceType',
  'Uri',
  'InstanceSiteId',
  'DisplayName',
  'Description',
]);

/** Words we never splice in as a `cp.<Field>` column even if they pass the identifier regex. */
export const SWQL_RESERVED = new Set([
  'select',
  'from',
  'where',
  'order',
  'by',
  'group',
  'having',
  'join',
  'inner',
  'left',
  'right',
  'outer',
  'on',
  'as',
  'and',
  'or',
  'not',
  'in',
  'is',
  'null',
  'with',
  'rows',
  'to',
  'top',
  'distinct',
  'union',
  'all',
  'case',
  'when',
  'then',
  'else',
  'end',
  'like',
  'between',
  'asc',
  'desc',
  'totalrows',
  'limitation',
]);

export const SNAPSHOT_SPECS = [
  ACTIVE_ALERTS,
  NODES,
  INTERFACES,
  TOPOLOGY_CONNECTIONS,
  DEPENDENCIES,
  GROUPS,
  GROUP_MEMBERS,
  ALERT_CONFIGS,
  STATUS_INFO,
] as const;
export const INCREMENTAL_SPECS = [EVENTS, ALERT_HISTORY] as const;
export const ALL_SPECS: readonly QuerySpec[] = [...SNAPSHOT_SPECS, ...INCREMENTAL_SPECS];

/** Every entity any query touches (for the schema probe). */
export function probedEntities(): string[] {
  const set = new Set<string>();
  for (const s of ALL_SPECS) for (const e of Object.values(s.entities)) set.add(e);
  return [...set].sort();
}

// ---------------------------------------------------------------------------------------------
// Discovery-only queries (scripts/swis-discover.ts)
// ---------------------------------------------------------------------------------------------

export const DISCOVERY = {
  entitiesExist: (count: number) =>
    `SELECT e.FullName AS FullName FROM Metadata.Entity e WHERE e.FullName IN (${Array.from(
      { length: count },
      (_, i) => `@e${i}`,
    ).join(', ')})`,
  serverTime: 'SELECT TOP 1 GETUTCDATE() AS UtcNow, GETDATE() AS LocalNow FROM Orion.Engines eng',
  vendors:
    'SELECT n.Vendor AS Vendor, n.MachineType AS MachineType, COUNT(n.NodeID) AS Nodes ' +
    'FROM Orion.Nodes n GROUP BY n.Vendor, n.MachineType',
  /** `field` must already be validated by SchemaProbe (identifier regex). */
  customPropertyValues: (field: string) =>
    `SELECT cp.${field} AS Value, COUNT(cp.NodeID) AS Nodes FROM Orion.NodesCustomProperties cp GROUP BY cp.${field}`,
  customPropertyDetails: NODE_CUSTOM_PROPERTIES,
  counts: {
    nodes: 'SELECT COUNT(n.NodeID) AS N FROM Orion.Nodes n',
    interfaces: 'SELECT COUNT(i.InterfaceID) AS N FROM Orion.NPM.Interfaces i',
    activeAlerts: 'SELECT COUNT(aa.AlertActiveID) AS N FROM Orion.AlertActive aa',
    topologyConnections: 'SELECT COUNT(tc.SrcNodeID) AS N FROM Orion.TopologyConnections tc',
    dependencies: 'SELECT COUNT(d.DependencyId) AS N FROM Orion.Dependencies d',
    groups: 'SELECT COUNT(c.ContainerID) AS N FROM Orion.Container c',
    alertConfigs: 'SELECT COUNT(ac.AlertID) AS N FROM Orion.AlertConfigurations ac',
  } as Record<string, string>,
  verbArguments:
    'SELECT va.VerbName AS VerbName, va.Position AS Position, va.Name AS Name, va.Type AS Type ' +
    'FROM Metadata.VerbArgument va WHERE va.EntityName = @entity ORDER BY va.VerbName, va.Position',
  /** Whether SWIS allows updating an entity's properties (site notes → group description). */
  entityCanUpdate:
    'SELECT e.FullName AS FullName, e.CanUpdate AS CanUpdate FROM Metadata.Entity e WHERE e.FullName = @entity',
  sampleTimestamps:
    'SELECT TOP 3 aa.AlertActiveID AS AlertActiveID, aa.TriggeredDateTime AS TriggeredDateTime FROM Orion.AlertActive aa ORDER BY aa.AlertActiveID DESC',
};

// ---------------------------------------------------------------------------------------------
// Write-back (worker, with the write-capable account)
// ---------------------------------------------------------------------------------------------

export const WRITEBACK = {
  /** One group, read just before and after writing its description (site notes). */
  groupById:
    'SELECT c.ContainerID AS ContainerID, c.Name AS Name, c.Description AS Description, c.Uri AS Uri ' +
    'FROM Orion.Container c WHERE c.ContainerID = @id',
};
