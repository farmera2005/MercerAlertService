/**
 * Zod schemas for SWIS result rows and mappers to normalized records. Schemas are lenient about
 * representation (numbers-as-strings, 0/1 booleans) but strict about required keys.
 */
import { z } from 'zod';
import { parseSwisDate, parseSwisUri } from '@mercer/core';
import { CUSTOM_PROPERTY_PREFIX } from './queries';

const numeric = z.union([
  z.number(),
  z
    .string()
    .regex(/^\s*-?\d+(\.\d+)?\s*$/)
    .transform(Number),
]);
const reqInt = numeric.pipe(z.number().int());
const optNum = numeric.nullable().optional();
const optInt = reqInt.nullable().optional();
const optStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .nullable()
  .optional();
const reqStr = z.union([z.string(), z.number()]).transform((v) => String(v));
const optBool = z
  .union([z.boolean(), z.number(), z.string()])
  .transform((v) => v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes)$/i.test(v)))
  .nullable()
  .optional();
const dateish = z.union([z.string(), z.null()]).optional();

const n = (v: number | null | undefined) =>
  v === undefined || v === null || !Number.isFinite(v) ? null : v;
const s = (v: string | null | undefined) => (v === undefined || v === null || v === '' ? null : v);

export interface ParseContext {
  naiveTimeZone: string;
}

// --- Q1 active alerts -------------------------------------------------------------------------

export const activeAlertRow = z.object({
  AlertActiveID: reqInt,
  AlertObjectID: reqInt,
  TriggeredDateTime: dateish,
  TriggeredMessage: optStr,
  Acknowledged: optBool,
  AcknowledgedBy: optStr,
  AcknowledgedDateTime: dateish,
  AlertID: reqInt,
  EntityUri: reqStr,
  EntityType: reqStr,
  EntityCaption: optStr,
  RelatedNodeId: optInt,
  RelatedNodeUri: optStr,
  RelatedNodeCaption: optStr,
  TriggeredCount: optInt,
  LastTriggeredDateTime: dateish,
  AlertName: reqStr,
  Severity: optInt,
  ObjectType: optStr,
});

export interface SwisActiveAlert {
  alertActiveId: number;
  alertObjectId: number;
  alertId: number;
  alertName: string;
  severity: number;
  objectType: string | null;
  triggeredAt: Date | null;
  message: string | null;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  entityUri: string;
  entityType: string;
  entityCaption: string | null;
  relatedNodeId: number | null;
  relatedNodeCaption: string | null;
  /** RelatedNodeId, or the NodeID parsed from EntityUri. */
  nodeId: number | null;
  interfaceId: number | null;
  triggerCount: number | null;
}

export function mapActiveAlert(
  r: z.infer<typeof activeAlertRow>,
  ctx: ParseContext,
): SwisActiveAlert {
  const uri = parseSwisUri(r.EntityUri);
  const relatedNodeId = n(r.RelatedNodeId);
  return {
    alertActiveId: r.AlertActiveID,
    alertObjectId: r.AlertObjectID,
    alertId: r.AlertID,
    alertName: r.AlertName,
    severity: r.Severity ?? 0,
    objectType: s(r.ObjectType),
    triggeredAt: parseSwisDate(r.TriggeredDateTime, ctx.naiveTimeZone),
    message: s(r.TriggeredMessage),
    acknowledged: !!r.Acknowledged,
    acknowledgedBy: s(r.AcknowledgedBy),
    acknowledgedAt: parseSwisDate(r.AcknowledgedDateTime, ctx.naiveTimeZone),
    entityUri: r.EntityUri,
    entityType: r.EntityType,
    entityCaption: s(r.EntityCaption),
    relatedNodeId,
    relatedNodeCaption: s(r.RelatedNodeCaption),
    nodeId: relatedNodeId && relatedNodeId > 0 ? relatedNodeId : (uri.nodeId ?? null),
    interfaceId: uri.interfaceId ?? null,
    triggerCount: n(r.TriggeredCount),
  };
}

// --- Q2 nodes ---------------------------------------------------------------------------------

export const nodeRow = z.looseObject({
  NodeID: reqInt,
  Caption: optStr,
  DNS: optStr,
  SysName: optStr,
  IPAddress: optStr,
  Status: optInt,
  StatusDescription: optStr,
  ResponseTime: optNum,
  PercentLoss: optNum,
  CPULoad: optNum,
  PercentMemoryUsed: optNum,
  Vendor: optStr,
  MachineType: optStr,
  LastBoot: dateish,
  Unmanaged: optBool,
  ObjectSubType: optStr,
  Location: optStr,
  IsServer: optBool,
  Uri: optStr,
});

export interface SwisNode {
  nodeId: number;
  caption: string;
  dns: string | null;
  sysName: string | null;
  ipAddress: string | null;
  status: number | null;
  statusDescription: string | null;
  /** Orion reports -1 when unknown; normalized to null. */
  responseTimeMs: number | null;
  percentLoss: number | null;
  cpuLoad: number | null;
  percentMemoryUsed: number | null;
  vendor: string | null;
  machineType: string | null;
  lastBoot: Date | null;
  unmanaged: boolean;
  objectSubType: string | null;
  location: string | null;
  isServer: boolean | null;
  uri: string | null;
  customProperties: Record<string, unknown>;
}

const nonNegative = (v: number | null | undefined) => {
  const x = n(v);
  return x === null || x < 0 ? null : x;
};

export function mapNode(r: z.infer<typeof nodeRow>, ctx: ParseContext): SwisNode {
  const customProperties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith(CUSTOM_PROPERTY_PREFIX))
      customProperties[k.slice(CUSTOM_PROPERTY_PREFIX.length)] = v ?? null;
  }
  return {
    nodeId: r.NodeID,
    caption: s(r.Caption) ?? s(r.DNS) ?? s(r.SysName) ?? `node-${r.NodeID}`,
    dns: s(r.DNS),
    sysName: s(r.SysName),
    ipAddress: s(r.IPAddress),
    status: n(r.Status),
    statusDescription: s(r.StatusDescription),
    responseTimeMs: nonNegative(r.ResponseTime),
    percentLoss: nonNegative(r.PercentLoss),
    cpuLoad: nonNegative(r.CPULoad),
    percentMemoryUsed: nonNegative(r.PercentMemoryUsed),
    vendor: s(r.Vendor),
    machineType: s(r.MachineType),
    lastBoot: parseSwisDate(r.LastBoot, ctx.naiveTimeZone),
    unmanaged: !!r.Unmanaged,
    objectSubType: s(r.ObjectSubType),
    location: s(r.Location),
    isServer: r.IsServer ?? null,
    uri: s(r.Uri),
    customProperties,
  };
}

// --- Q3 interfaces ----------------------------------------------------------------------------

export const interfaceRow = z.object({
  InterfaceID: reqInt,
  NodeID: reqInt,
  Name: optStr,
  Caption: optStr,
  FullName: optStr,
  Alias: optStr,
  TypeDescription: optStr,
  Status: optInt,
  OperStatus: optInt,
  AdminStatus: optInt,
  InPercentUtil: optNum,
  OutPercentUtil: optNum,
  InBps: optNum,
  OutBps: optNum,
  Speed: optNum,
  InErrorsThisHour: optNum,
  OutErrorsThisHour: optNum,
  InDiscardsThisHour: optNum,
  OutDiscardsThisHour: optNum,
  Unmanaged: optBool,
  Uri: optStr,
});

export interface SwisInterface {
  interfaceId: number;
  nodeId: number;
  name: string | null;
  caption: string | null;
  fullName: string | null;
  alias: string | null;
  typeDescription: string | null;
  status: number | null;
  operStatus: number | null;
  adminStatus: number | null;
  inPercentUtil: number | null;
  outPercentUtil: number | null;
  inBps: number | null;
  outBps: number | null;
  speedBps: number | null;
  inErrorsHour: number | null;
  outErrorsHour: number | null;
  inDiscardsHour: number | null;
  outDiscardsHour: number | null;
  unmanaged: boolean;
  uri: string | null;
}

export function mapInterface(r: z.infer<typeof interfaceRow>): SwisInterface {
  return {
    interfaceId: r.InterfaceID,
    nodeId: r.NodeID,
    name: s(r.Name),
    caption: s(r.Caption),
    fullName: s(r.FullName),
    alias: s(r.Alias),
    typeDescription: s(r.TypeDescription),
    status: n(r.Status),
    operStatus: n(r.OperStatus),
    adminStatus: n(r.AdminStatus),
    inPercentUtil: nonNegative(r.InPercentUtil),
    outPercentUtil: nonNegative(r.OutPercentUtil),
    inBps: nonNegative(r.InBps),
    outBps: nonNegative(r.OutBps),
    speedBps: nonNegative(r.Speed),
    inErrorsHour: nonNegative(r.InErrorsThisHour),
    outErrorsHour: nonNegative(r.OutErrorsThisHour),
    inDiscardsHour: nonNegative(r.InDiscardsThisHour),
    outDiscardsHour: nonNegative(r.OutDiscardsThisHour),
    unmanaged: !!r.Unmanaged,
    uri: s(r.Uri),
  };
}

// --- Q4–Q8, Q11 -------------------------------------------------------------------------------

export const topologyRow = z.object({
  SrcNodeID: reqInt,
  SrcInterfaceID: optInt,
  DestNodeID: reqInt,
  DestInterfaceID: optInt,
  LayerType: optStr,
});
export interface SwisTopologyConnection {
  srcNodeId: number;
  srcInterfaceId: number | null;
  destNodeId: number;
  destInterfaceId: number | null;
  layerType: string | null;
}
export const mapTopology = (r: z.infer<typeof topologyRow>): SwisTopologyConnection => ({
  srcNodeId: r.SrcNodeID,
  srcInterfaceId: n(r.SrcInterfaceID) || null,
  destNodeId: r.DestNodeID,
  destInterfaceId: n(r.DestInterfaceID) || null,
  layerType: s(r.LayerType),
});

export const dependencyRow = z.object({
  DependencyId: reqInt,
  Name: optStr,
  ParentUri: reqStr,
  ChildUri: reqStr,
  AutoManaged: optBool,
  ParentEntityType: optStr,
  ChildEntityType: optStr,
});
export interface SwisDependency {
  dependencyId: number;
  name: string | null;
  parentUri: string;
  childUri: string;
  autoManaged: boolean;
  parentEntityType: string | null;
  childEntityType: string | null;
}
export const mapDependency = (r: z.infer<typeof dependencyRow>): SwisDependency => ({
  dependencyId: r.DependencyId,
  name: s(r.Name),
  parentUri: r.ParentUri,
  childUri: r.ChildUri,
  autoManaged: !!r.AutoManaged,
  parentEntityType: s(r.ParentEntityType),
  childEntityType: s(r.ChildEntityType),
});

export const groupRow = z.object({
  ContainerID: reqInt,
  Name: reqStr,
  Status: optInt,
  Description: optStr,
  Uri: optStr,
});
export interface SwisGroup {
  containerId: number;
  name: string;
  status: number | null;
  description: string | null;
  uri: string | null;
}
export const mapGroup = (r: z.infer<typeof groupRow>): SwisGroup => ({
  containerId: r.ContainerID,
  name: r.Name,
  status: n(r.Status),
  description: s(r.Description),
  uri: s(r.Uri),
});

export const groupMemberRow = z.object({
  ContainerID: reqInt,
  MemberUri: reqStr,
  MemberPrimaryID: optInt,
  MemberEntityType: optStr,
  Name: optStr,
  Status: optInt,
});
export interface SwisGroupMember {
  containerId: number;
  memberUri: string;
  memberPrimaryId: number | null;
  memberEntityType: string | null;
  name: string | null;
  status: number | null;
}
export const mapGroupMember = (r: z.infer<typeof groupMemberRow>): SwisGroupMember => ({
  containerId: r.ContainerID,
  memberUri: r.MemberUri,
  memberPrimaryId: n(r.MemberPrimaryID),
  memberEntityType: s(r.MemberEntityType),
  name: s(r.Name),
  status: n(r.Status),
});

export const alertConfigRow = z.object({
  AlertID: reqInt,
  AlertRefID: optStr,
  Name: reqStr,
  Description: optStr,
  Enabled: optBool,
  Severity: optInt,
  ObjectType: optStr,
});
export interface SwisAlertConfig {
  alertId: number;
  alertRefId: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  severity: number;
  objectType: string | null;
}
export const mapAlertConfig = (r: z.infer<typeof alertConfigRow>): SwisAlertConfig => ({
  alertId: r.AlertID,
  alertRefId: s(r.AlertRefID),
  name: r.Name,
  description: s(r.Description),
  enabled: r.Enabled ?? true,
  severity: r.Severity ?? 0,
  objectType: s(r.ObjectType),
});

export const statusInfoRow = z.object({ StatusId: reqInt, StatusName: reqStr });
export interface SwisStatusInfo {
  statusId: number;
  statusName: string;
}
export const mapStatusInfo = (r: z.infer<typeof statusInfoRow>): SwisStatusInfo => ({
  statusId: r.StatusId,
  statusName: r.StatusName,
});

// --- Q9 / Q10 ---------------------------------------------------------------------------------

export const eventRow = z.object({
  EventID: reqInt,
  EventTime: dateish,
  EventType: reqInt,
  EventTypeName: optStr,
  Message: optStr,
  NetworkNode: optInt,
  NetObjectID: optStr,
  NetObjectType: optStr,
  Acknowledged: optBool,
});
export interface SwisEvent {
  eventId: number;
  eventTime: Date | null;
  eventType: number;
  eventTypeName: string | null;
  message: string | null;
  nodeId: number | null;
  netObjectId: string | null;
  netObjectType: string | null;
  acknowledged: boolean;
}
export const mapEvent = (r: z.infer<typeof eventRow>, ctx: ParseContext): SwisEvent => ({
  eventId: r.EventID,
  eventTime: parseSwisDate(r.EventTime, ctx.naiveTimeZone),
  eventType: r.EventType,
  eventTypeName: s(r.EventTypeName),
  message: s(r.Message),
  nodeId: n(r.NetworkNode) || null,
  netObjectId: s(r.NetObjectID),
  netObjectType: s(r.NetObjectType),
  acknowledged: !!r.Acknowledged,
});

export const alertHistoryRow = z.object({
  AlertHistoryID: reqInt,
  EventType: reqInt,
  TimeStamp: dateish,
  Message: optStr,
  AccountID: optStr,
  AlertActiveID: optInt,
  AlertObjectID: optInt,
  AlertID: optInt,
  EntityUri: optStr,
  RelatedNodeId: optInt,
});
export interface SwisAlertHistory {
  alertHistoryId: number;
  eventType: number;
  at: Date | null;
  message: string | null;
  accountId: string | null;
  alertActiveId: number | null;
  alertObjectId: number | null;
  alertId: number | null;
  entityUri: string | null;
  relatedNodeId: number | null;
}
export const mapAlertHistory = (
  r: z.infer<typeof alertHistoryRow>,
  ctx: ParseContext,
): SwisAlertHistory => ({
  alertHistoryId: r.AlertHistoryID,
  eventType: r.EventType,
  at: parseSwisDate(r.TimeStamp, ctx.naiveTimeZone),
  message: s(r.Message),
  accountId: s(r.AccountID),
  alertActiveId: n(r.AlertActiveID),
  alertObjectId: n(r.AlertObjectID),
  alertId: n(r.AlertID),
  entityUri: s(r.EntityUri),
  relatedNodeId: n(r.RelatedNodeId) || null,
});
