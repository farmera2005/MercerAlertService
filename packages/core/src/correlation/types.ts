/**
 * Correlation domain types. The engine (`runCorrelation`) is a pure function over these: the worker
 * loads a snapshot from Postgres, runs the engine, and persists the returned changes.
 */
import type { DeviceRole } from '../mapping';
import type { OrionSeverity, StatusNorm } from '../orion';

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_KINDS = [
  'site_outage',
  'device_down',
  'flapping',
  'interface',
  'ups_power',
  'service',
  'monitoring_source_down',
  'generic',
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const MEMBER_ROLES = ['root', 'symptom', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Where an alert record came from: an Orion alert, a node status change, or MAS itself. */
export type RecordSource = 'orion' | 'status' | 'internal';
export type RecordSeverity = OrionSeverity | 'none';

/** A deduplicated alert: one per (alert rule, entity) — or per node for status-derived records. */
export interface AlertRecord {
  key: string;
  id?: number;
  source: RecordSource;
  alertId: number | null;
  alertName: string;
  entityUri: string | null;
  entityType: string | null;
  entityCaption: string | null;
  nodeId: number | null;
  interfaceId: number | null;
  siteId: number | null;
  severity: RecordSeverity;
  state: 'active' | 'cleared';
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastRaisedAt: Date;
  clearedAt: Date | null;
  triggerCount: number;
  currentAlertObjectId: number | null;
  currentAlertActiveId: number | null;
  lastMessage: string | null;
  acknowledgedInOrion: boolean;
  /** Incident ref ("id:12" or "new:3"), null if not attached. */
  incidentRef: string | null;
  /** Active, but held back by a maintenance window that suppresses incidents. */
  suppressed: boolean;
  /** Already active when MAS first saw it (initial sync / reconcile). */
  seeded: boolean;
}

export interface IncidentState {
  ref: string;
  id?: number;
  status: IncidentStatus;
  kind: IncidentKind;
  correlationKey: string;
  title: string;
  templateSummary: string;
  priority: Priority;
  basePriority: Priority;
  baseScore: number;
  priorityFactors: PriorityFactors;
  primarySiteId: number | null;
  /** The primary site's divisions. */
  divisionCodes: string[];
  affectedSiteIds: number[];
  rootNodeId: number | null;
  rootEntityUri: string | null;
  recoveryTargetMin: number;
  openedAt: Date;
  lastActivityAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvePendingSince: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  closedAt: Date | null;
  snoozedUntil: Date | null;
  alertCount: number;
  memberCount: number;
  materialRev: number;
  inMaintenance: boolean;
  seeded: boolean;
  /**
   * The applied AI adjustment (±1, already guarded) and the `kind/basePriority` it was made for.
   * Written only by the AI job; the engine re-applies it while the basis still holds.
   */
  aiPriorityAdjust: number | null;
  aiPriorityBasis: string | null;
  members: Map<string, MemberRole>;
}

export interface NodeInfo {
  nodeId: number;
  caption: string;
  siteId: number | null;
  role: DeviceRole;
  statusNorm: StatusNorm;
  unmanaged: boolean;
}

export interface BusinessHours {
  days: number[];
  start: string;
  end: string;
}

export interface SiteInfo {
  id: number;
  name: string;
  divisionCodes: string[];
  divisionNames: string[];
  tier: 'critical' | 'high' | 'standard';
  harvestCritical: boolean;
  businessHours: BusinessHours;
  harvestHours: BusinessHours | null;
}

export interface SeasonPeriod {
  id: number;
  name: string;
  kind: 'harvest' | 'high_risk';
  startMd: string;
  endMd: string;
  year: number | null;
  multiplier: number;
  divisions: string[] | null;
  harvestCriticalOnly: boolean;
  enabled: boolean;
}

export interface MaintenanceWindow {
  id: number;
  scope: 'global' | 'site' | 'node';
  siteId: number | null;
  nodeId: number | null;
  startsAt: Date;
  endsAt: Date | null;
  /** Weekly recurrence in APP_TIMEZONE; when set, startsAt/endsAt bound the period it applies. */
  recurrence: { weekdays: number[]; start: string; durationMin: number } | null;
  suppress: 'notifications' | 'incidents';
  reason: string | null;
}

export interface StateChange {
  at: Date;
  /** true = went bad (raised / down), false = recovered. */
  bad: boolean;
}

/** Upstream relations: child node → parent node IDs (dependencies + oriented topology links). */
export interface TopologyGraph {
  parents: Map<number, Set<number>>;
}

export interface TransitionIn {
  id: number | null;
  kind: 'alert' | 'node' | 'interface' | 'source';
  change: string;
  entityKey: string;
  nodeId: number | null;
  interfaceId: number | null;
  siteId: number | null;
  alertObjectId: number | null;
  alertActiveId: number | null;
  fromState: string | null;
  toState: string;
  observedAt: Date;
  sourceAt: Date | null;
  details: Record<string, unknown>;
}

export interface CorrelationConfig {
  windowSec: number;
  holddownSec: number;
  reopenWindowSec: number;
  flapCount: number;
  flapWindowMin: number;
  maxAgeSec: number;
  upsAlertRegex: string;
  timezone: string;
  scoring: ScoringConfig;
}

export interface ScoringConfig {
  p1Min: number;
  p2Min: number;
  p3Min: number;
  tierCritical: number;
  tierHigh: number;
  harvestGrainMult: number;
  afterHoursMult: number;
  recoveryHarvestMin: number;
  recoveryDefaultMin: number;
}

export type ImpactClass =
  | 'site_outage'
  | 'core_device'
  | 'multi_device'
  | 'single_device'
  | 'ups_power'
  | 'core_interface'
  | 'interface'
  | 'service'
  | 'informational';

export interface PriorityFactors {
  fixed?: string;
  impact: ImpactClass;
  impactPoints: number;
  severity: RecordSeverity;
  severityWeight: number;
  tier: SiteInfo['tier'] | null;
  tierMult: number;
  season: string | null;
  seasonMult: number;
  businessHours: boolean;
  timeMult: number;
  score: number;
  explanation: string[];
  /** Guardrail context for AI suggestions (absent on rows scored before M5). */
  firewallDown?: boolean;
  harvestCriticalInHarvest?: boolean;
}

export interface IncidentEventOut {
  incidentRef: string;
  at: Date;
  type:
    | 'opened'
    | 'member_added'
    | 'priority_changed'
    | 'kind_changed'
    | 'reopened'
    | 'resolve_pending'
    | 'resolved'
    | 'closed'
    | 'snooze_expired'
    | 'merged';
  actor: 'system';
  message: string;
  details?: Record<string, unknown>;
}

export interface CorrelationInput {
  now: Date;
  config: CorrelationConfig;
  transitions: TransitionIn[];
  nodes: Map<number, NodeInfo>;
  sites: Map<number, SiteInfo>;
  graph: TopologyGraph;
  seasons: SeasonPeriod[];
  maintenance: MaintenanceWindow[];
  /** Records that may be touched: active ones, members of loaded incidents, keys of pending transitions. */
  records: Map<string, AlertRecord>;
  /** Open, acknowledged, and recently resolved incidents (within the reopen window). */
  incidents: IncidentState[];
  /** Flap key (node:N / iface:N / rec:key) → recent state changes (within the flap window). */
  recentChanges: Map<string, StateChange[]>;
  /** Next number to use for new incident refs ("new:N"). */
  nextRef?: number;
}

export interface CorrelationOutput {
  records: AlertRecord[];
  incidents: IncidentState[];
  events: IncidentEventOut[];
  processedTransitionIds: number[];
  /** Incidents whose priority/kind/root/sites changed (M4 notifies, M5 re-summarises). */
  materialChanges: string[];
}
