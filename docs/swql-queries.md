# SWQL query catalog

The source of truth is `packages/swis/src/queries.ts`. This file mirrors it for review.
All queries go to `POST /SolarWinds/InformationService/v3/Json/Query` with the body
`{ "query": "...", "parameters": { ... } }`.

Rules:

- **Explicit aliases on every column** (`AS AlertActiveID`). Result keys are then
  deterministic regardless of Orion version.
- **Required vs optional fields.** At startup and hourly, the worker reads
  `Metadata.Property` for every entity below. If an optional field doesn't exist in our
  Orion version, it is dropped from the SELECT and a warning is logged. If a required
  field is missing, that poller fails with a clear error. Optional fields are marked
  `?` below.
- **Paging.** Snapshot queries use `ORDER BY <unique key> WITH ROWS a TO b` with a page
  size of `SWIS_PAGE_SIZE` (default 1000), looping until a short page comes back.
  Incremental queries use `WHERE <id> > @cursor ORDER BY <id> WITH ROWS 1 TO n` and loop
  until a short page.
- **Parameters.** Values are always bound (`@cursor`). The only inlined values are
  validated integers in `WITH ROWS`, and custom-property column names validated against
  `^[A-Za-z_][A-Za-z0-9_]*$`.
- **Timestamps.** SWIS returns UTC. Strings without an offset are parsed as
  `SWIS_NAIVE_TIMEZONE` (default `UTC`). `swis-discover` prints server UTC and local time,
  so this can be confirmed.

Run `pnpm swis:discover` against our instance to confirm every field before the first
real deployment. `pnpm swis:discover --check-queries` also runs each production query
with `WITH ROWS 1 TO 1` and reports pass or fail.

---

## Q1. Active alerts: every 30 s (`SWIS_POLL_ALERTS_SEC`)

```sql
SELECT aa.AlertActiveID AS AlertActiveID, aa.AlertObjectID AS AlertObjectID,
       aa.TriggeredDateTime AS TriggeredDateTime, aa.TriggeredMessage AS TriggeredMessage,
       aa.Acknowledged AS Acknowledged, aa.AcknowledgedBy AS AcknowledgedBy,
       aa.AcknowledgedDateTime AS AcknowledgedDateTime,
       ao.AlertID AS AlertID, ao.EntityUri AS EntityUri, ao.EntityType AS EntityType,
       ao.EntityCaption AS EntityCaption, ao.RelatedNodeId AS RelatedNodeId,
       ao.RelatedNodeUri AS RelatedNodeUri, ao.RelatedNodeCaption AS RelatedNodeCaption,
       ao.TriggeredCount AS TriggeredCount, ao.LastTriggeredDateTime AS LastTriggeredDateTime,
       ac.Name AS AlertName, ac.Severity AS Severity, ac.ObjectType AS ObjectType
FROM Orion.AlertActive aa
INNER JOIN Orion.AlertObjects ao ON ao.AlertObjectID = aa.AlertObjectID
INNER JOIN Orion.AlertConfigurations ac ON ac.AlertID = ao.AlertID
ORDER BY aa.AlertActiveID
WITH ROWS 1 TO 1000
```

Required: `AlertActiveID, AlertObjectID, TriggeredDateTime, Acknowledged, AlertID, EntityUri, EntityType, AlertName, Severity`.
Optional: `TriggeredMessage?, AcknowledgedBy?, AcknowledgedDateTime?, EntityCaption?, RelatedNodeId?, RelatedNodeUri?, RelatedNodeCaption?, TriggeredCount?, LastTriggeredDateTime?, ObjectType?`.

Diffing against the stored snapshot by `AlertActiveID`:

| Situation                                  | Transition          |
| ------------------------------------------ | ------------------- |
| New ID                                     | `raised`            |
| New ID for an AlertObjectID we already had | `retriggered`       |
| Missing ID                                 | `cleared`           |
| `Acknowledged` flipped                     | `acked` / `unacked` |

`Severity` mapping (confirm with discovery): 0 Informational, 1 Warning, 2 Critical,
3 Serious, 4 Notice.

## Q2. Nodes + custom properties: every 60 s (`SWIS_POLL_NODES_SEC`)

```sql
SELECT n.NodeID AS NodeID, n.Caption AS Caption, n.DNS AS DNS, n.SysName AS SysName,
       n.IPAddress AS IPAddress, n.Status AS Status, n.StatusDescription AS StatusDescription,
       n.ResponseTime AS ResponseTime, n.PercentLoss AS PercentLoss, n.CPULoad AS CPULoad,
       n.PercentMemoryUsed AS PercentMemoryUsed, n.Vendor AS Vendor,
       n.MachineType AS MachineType, n.LastBoot AS LastBoot, n.Unmanaged AS Unmanaged,
       n.ObjectSubType AS ObjectSubType, n.Location AS Location, n.IsServer AS IsServer,
       n.Uri AS Uri,
       cp.Site AS CP_Site, cp.Division AS CP_Division, cp.City AS CP_City   -- discovered list
FROM Orion.Nodes n
LEFT JOIN Orion.NodesCustomProperties cp ON cp.NodeID = n.NodeID
ORDER BY n.NodeID
WITH ROWS 1 TO 1000
```

Required: `NodeID, Caption, Status`. All other fields are optional.

All node custom properties are selected, not only the mapped ones. They are stored in
`orion_nodes.custom_properties` so the admin mapping UI can switch fields without a code
change. The column list comes from Q12.

Status codes (`Orion.StatusInfo`, refreshed hourly) normalize as follows:

| Code(s) | Normalized                                        |
| ------- | ------------------------------------------------- |
| 1       | up                                                |
| 2       | down                                              |
| 3       | warning                                           |
| 14      | critical                                          |
| 12      | unreachable (Orion's dependency-suppressed child) |
| 9       | unmanaged                                         |
| 0, 17   | unknown                                           |
| others  | other                                             |

A change in normalized status produces a `node status` transition. Each poll also folds
into the `node_metrics_5m` rollup.

## Q3. Interfaces: every 180 s (`SWIS_POLL_INTERFACES_SEC`)

```sql
SELECT i.InterfaceID AS InterfaceID, i.NodeID AS NodeID, i.Name AS Name, i.Caption AS Caption,
       i.FullName AS FullName, i.Alias AS Alias, i.TypeDescription AS TypeDescription,
       i.Status AS Status, i.OperStatus AS OperStatus, i.AdminStatus AS AdminStatus,
       i.InPercentUtil AS InPercentUtil, i.OutPercentUtil AS OutPercentUtil,
       i.Inbps AS InBps, i.Outbps AS OutBps, i.Speed AS Speed,
       i.InErrorsThisHour AS InErrorsThisHour, i.OutErrorsThisHour AS OutErrorsThisHour,
       i.InDiscardsThisHour AS InDiscardsThisHour, i.OutDiscardsThisHour AS OutDiscardsThisHour,
       i.UnManaged AS Unmanaged, i.Uri AS Uri
FROM Orion.NPM.Interfaces i
ORDER BY i.InterfaceID
WITH ROWS 1 TO 1000
```

Required: `InterfaceID, NodeID, Status`.

A status change produces an `interface status` transition. Each poll also folds into
`interface_metrics_5m`.

## Q4–Q8. Topology, dependencies, groups, alert definitions: hourly (`SWIS_POLL_TOPOLOGY_SEC`) and at startup

Each of these is a full replace inside a single transaction.

```sql
-- Q4 Orion.TopologyConnections (L2/L3 links from NPM topology: CDP/LLDP/bridge tables)
SELECT tc.SrcNodeID AS SrcNodeID, tc.SrcInterfaceID AS SrcInterfaceID,
       tc.DestNodeID AS DestNodeID, tc.DestInterfaceID AS DestInterfaceID,
       tc.LayerType AS LayerType
FROM Orion.TopologyConnections tc
ORDER BY tc.SrcNodeID, tc.SrcInterfaceID, tc.DestNodeID, tc.DestInterfaceID
WITH ROWS 1 TO 1000

-- Q5 Orion.Dependencies (parent/child; parents may be nodes, interfaces or groups)
SELECT d.DependencyId AS DependencyId, d.Name AS Name, d.ParentUri AS ParentUri,
       d.ChildUri AS ChildUri, d.AutoManaged AS AutoManaged,
       d.ParentEntityType AS ParentEntityType, d.ChildEntityType AS ChildEntityType
FROM Orion.Dependencies d
ORDER BY d.DependencyId
WITH ROWS 1 TO 1000

-- Q6 Orion.Container (groups)
SELECT c.ContainerID AS ContainerID, c.Name AS Name, c.Status AS Status,
       c.Description AS Description, c.Uri AS Uri
FROM Orion.Container c
ORDER BY c.ContainerID
WITH ROWS 1 TO 1000

-- Q7 Orion.ContainerMembers
SELECT m.ContainerID AS ContainerID, m.MemberUri AS MemberUri,
       m.MemberPrimaryID AS MemberPrimaryID, m.MemberEntityType AS MemberEntityType,
       m.Name AS Name, m.Status AS Status
FROM Orion.ContainerMembers m
ORDER BY m.ContainerID, m.MemberUri
WITH ROWS 1 TO 1000

-- Q8 Orion.AlertConfigurations (names, severity, enabled flag for weekly "misconfigured rule" analysis)
SELECT ac.AlertID AS AlertID, ac.AlertRefID AS AlertRefID, ac.Name AS Name,
       ac.Description AS Description, ac.Enabled AS Enabled, ac.Severity AS Severity,
       ac.ObjectType AS ObjectType
FROM Orion.AlertConfigurations ac
ORDER BY ac.AlertID
WITH ROWS 1 TO 1000
```

Required fields:

| Query | Required                                                 |
| ----- | -------------------------------------------------------- |
| Q4    | `SrcNodeID, SrcInterfaceID, DestNodeID, DestInterfaceID` |
| Q5    | `DependencyId, ParentUri, ChildUri`                      |
| Q6    | `ContainerID, Name`                                      |
| Q7    | `ContainerID, MemberUri`                                 |
| Q8    | `AlertID, Name, Severity`                                |

URIs are parsed locally:

- `…/Orion.Nodes/NodeID=12` → node 12
- `…/Orion.Nodes/NodeID=12/Interfaces/InterfaceID=34` → interface 34
- `…/Orion.Groups/ContainerID=5` → group 5

## Q9. Events: every 300 s (`SWIS_POLL_EVENTS_SEC`), incremental

```sql
SELECT e.EventID AS EventID, e.EventTime AS EventTime, e.EventType AS EventType,
       et.Name AS EventTypeName, e.Message AS Message, e.NetworkNode AS NetworkNode,
       e.NetObjectID AS NetObjectID, e.NetObjectType AS NetObjectType,
       e.Acknowledged AS Acknowledged
FROM Orion.Events e
LEFT JOIN Orion.EventTypes et ON et.EventType = e.EventType
WHERE e.EventID > @cursor
ORDER BY e.EventID
WITH ROWS 1 TO 2000
```

On the first run there is no cursor. We run `SELECT MAX(e.EventID) AS MaxId FROM Orion.Events e`
and start from `MaxId − SWIS_EVENTS_BACKFILL` (default 2000).

## Q10. Alert history: every 300 s, incremental

```sql
SELECT ah.AlertHistoryID AS AlertHistoryID, ah.EventType AS EventType, ah.TimeStamp AS TimeStamp,
       ah.Message AS Message, ah.AccountID AS AccountID, ah.AlertActiveID AS AlertActiveID,
       ah.AlertObjectID AS AlertObjectID, ao.AlertID AS AlertID, ao.EntityUri AS EntityUri,
       ao.RelatedNodeId AS RelatedNodeId
FROM Orion.AlertHistory ah
LEFT JOIN Orion.AlertObjects ao ON ao.AlertObjectID = ah.AlertObjectID
WHERE ah.AlertHistoryID > @cursor
ORDER BY ah.AlertHistoryID
WITH ROWS 1 TO 2000
```

`EventType` is stored raw. Known values (confirm with discovery): 0 triggered, 1 reset,
2 acknowledged, 3 note added. The weekly trends job uses this table to find rules that
fire constantly and are never acknowledged.

## Q11. Status codes: hourly

```sql
SELECT si.StatusId AS StatusId, si.StatusName AS StatusName FROM Orion.StatusInfo si ORDER BY si.StatusId
```

## Q12. Node custom-property columns: hourly

```sql
SELECT cp.Field AS Field, cp.DataType AS DataType, cp.Description AS Description
FROM Orion.CustomProperty cp
WHERE cp.TargetEntity = @target          -- 'Orion.NodesCustomProperties'
```

Fallback if `Orion.CustomProperty` isn't readable:
`Metadata.Property WHERE EntityName = 'Orion.NodesCustomProperties'`, minus system
columns (`NodeID`, `InstanceType`, `Uri`, `InstanceSiteId`, `DisplayName`,
`Description`).

## Q13. Schema probe: startup and hourly

```sql
SELECT p.EntityName AS EntityName, p.Name AS Name, p.Type AS Type
FROM Metadata.Property p
WHERE p.EntityName IN (@e0, @e1, @e2, …)
```

## Discovery-only (`scripts/swis-discover.ts`)

- `Metadata.Entity`: confirms that each entity we use exists.
- `Metadata.Property` for each entity: lists fields and types, and marks which Q1–Q13
  fields are missing.
- `Orion.CustomProperty` for nodes. For each node custom property it also runs
  `SELECT cp.<Field> AS Value, COUNT(cp.NodeID) AS Nodes FROM Orion.NodesCustomProperties cp GROUP BY cp.<Field>`.
  The output shows the actual Site and Division values, so they can be mapped to site
  profiles.
- `SELECT n.Vendor, n.MachineType, COUNT(n.NodeID) … GROUP BY n.Vendor, n.MachineType`:
  supports device-role classification.
- `SELECT TOP 1 GETUTCDATE() AS UtcNow, GETDATE() AS LocalNow FROM Orion.Engines`: time-zone check.
- Counts for topology connections, dependencies and groups, so we know whether Orion has
  dependencies and topology configured.
- `Metadata.Verb` / `Metadata.VerbArgument` for `Orion.AlertActive`: confirms the
  `Acknowledge` signature before write-back is enabled.

## Write-back (feature flag, separate account)

```
POST /SolarWinds/InformationService/v3/Json/Invoke/Orion.AlertActive/Acknowledge
Body: [[<AlertObjectID>, …], "Acknowledged in MercerAlertService by <user> (INC-1042)"]
```

Implemented in M3 (`apps/worker/src/writeback.ts`, queue `swis.writeback.ack`). It is only
sent when `SWIS_WRITEBACK_ENABLED=true` and the separate `SWIS_WRITE_USERNAME` /
`SWIS_WRITE_PASSWORD` are set, after someone acknowledges an incident in MAS. The IDs are the
incident's member alerts that are still active and not yet acknowledged in Orion. The call is
not retried by the client (pg-boss retries the job twice); every success is written to the
audit log and every attempt to the incident timeline. The next alerts poll sees
`Acknowledged = 1` and records an `acked` transition, so a second acknowledgement finds nothing
to do.
