/**
 * Storage for the AI layer: the call log and budget, which incidents need a summary, the
 * read-only context a summary is written from, the guarded write-back, and digest facts.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import {
  addZonedDays,
  describeHours,
  isHarvest,
  localDateTime,
  type AiPriorityDecision,
  type DailyFacts,
  type DigestContent,
  type DigestFacts,
  type DigestIncident,
  type IncidentContext,
  type IncidentKind,
  type NoiseFacts,
  type PreviousSummary,
  type Priority,
  type SiteProfile,
  type StoredAiSummary,
  type WeeklyFacts,
  readStoredAiSummary,
} from '@mercer/core';
import {
  aiCalls,
  alertRecords,
  digests,
  divisions,
  entityTransitions,
  incidentEvents,
  incidentMembers,
  incidents,
  interfaceMetrics5m,
  notifications,
  orionInterfaces,
  orionNodes,
  sites,
} from '../schema';
import type { Db, DbOrTx } from '../client';
import { listSeasons } from './calendar';
import { publishEvent } from './events-bus';
import { lockCorrelation } from './locks';

export type AiCallRow = typeof aiCalls.$inferSelect;
export type AiCallInsert = typeof aiCalls.$inferInsert;
export type DigestRow = typeof digests.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Call log and budget
// ---------------------------------------------------------------------------------------------

export async function recordAiCall(db: DbOrTx, row: AiCallInsert): Promise<number> {
  const [r] = await db
    .insert(aiCalls)
    .values({ ...row, error: row.error?.slice(0, 1000) ?? null })
    .returning({ id: aiCalls.id });
  return r!.id;
}

/** US$ spent since `since` (the start of today in APP_TIMEZONE for the budget). */
export async function aiSpendSince(db: DbOrTx, since: Date): Promise<number> {
  const [r] = await db
    .select({ usd: sql<string>`coalesce(sum(${aiCalls.costUsd}), 0)` })
    .from(aiCalls)
    .where(gte(aiCalls.at, since));
  return Number(r?.usd ?? 0);
}

export interface AiUsageRow {
  purpose: string;
  model: string;
  calls: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

export async function aiUsageSince(db: DbOrTx, since: Date): Promise<AiUsageRow[]> {
  const rows = await db
    .select({
      purpose: aiCalls.purpose,
      model: aiCalls.model,
      calls: sql<number>`count(*)::int`,
      ok: sql<number>`count(*) filter (where ${aiCalls.status} in ('ok','retried'))::int`,
      failed: sql<number>`count(*) filter (where ${aiCalls.status} not in ('ok','retried','budget_blocked'))::int`,
      inputTokens: sql<number>`coalesce(sum(${aiCalls.inputTokens}),0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiCalls.outputTokens}),0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum(${aiCalls.cacheReadTokens}),0)::int`,
      cacheWriteTokens: sql<number>`coalesce(sum(${aiCalls.cacheWriteTokens}),0)::int`,
      costUsd: sql<string>`coalesce(sum(${aiCalls.costUsd}),0)`,
      avgLatencyMs: sql<number>`coalesce(avg(${aiCalls.latencyMs}) filter (where ${aiCalls.status} <> 'budget_blocked'),0)::int`,
    })
    .from(aiCalls)
    .where(gte(aiCalls.at, since))
    .groupBy(aiCalls.purpose, aiCalls.model)
    .orderBy(aiCalls.purpose, aiCalls.model);
  return rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) }));
}

export async function recentAiCalls(db: DbOrTx, limit = 50): Promise<AiCallRow[]> {
  return db.select().from(aiCalls).orderBy(desc(aiCalls.id)).limit(limit);
}

export async function aiCallsForIncident(db: DbOrTx, incidentId: number): Promise<AiCallRow[]> {
  return db
    .select()
    .from(aiCalls)
    .where(eq(aiCalls.incidentId, incidentId))
    .orderBy(desc(aiCalls.id))
    .limit(50);
}

// ---------------------------------------------------------------------------------------------
// Which incidents need the AI
// ---------------------------------------------------------------------------------------------

/**
 * Incidents whose latest material change has not been summarized yet: real (not pre-existing),
 * recent, still open or resolved within the last 6 hours, and not waiting out a backoff.
 */
export async function dueAiIncidents(db: DbOrTx, now: Date, limit = 20): Promise<number[]> {
  const rows = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(
      and(
        eq(incidents.seeded, false),
        sql`${incidents.materialRev} > coalesce(${incidents.aiSummaryMaterialRev}, -1)`,
        or(isNull(incidents.aiNextAttemptAt), lte(incidents.aiNextAttemptAt, now)),
        gte(incidents.openedAt, new Date(now.getTime() - 7 * 86_400_000)),
        or(
          inArray(incidents.status, ['open', 'acknowledged']),
          gte(incidents.resolvedAt, new Date(now.getTime() - 6 * 3_600_000)),
        ),
      ),
    )
    .orderBy(asc(incidents.priority), desc(incidents.lastActivityAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------
// Context for prompts
// ---------------------------------------------------------------------------------------------

/** Site profiles for the cached prompt prefix. */
export async function loadSiteProfiles(db: DbOrTx): Promise<SiteProfile[]> {
  const rows = await db
    .select({ site: sites, division: divisions.name })
    .from(sites)
    .leftJoin(divisions, eq(divisions.code, sites.divisionCode))
    .orderBy(asc(sites.code));
  return rows.map(({ site: s, division }) => ({
    code: s.code,
    name: s.name,
    division: division ?? null,
    city: s.city,
    tier: s.tier,
    harvestCritical: s.harvestCritical,
    hours: describeHours(s.businessHours),
    harvestHours: s.harvestHours ? describeHours(s.harvestHours) : null,
    ownerGroup: s.ownerGroup,
  }));
}

export interface AiIncidentSnapshot {
  id: number;
  materialRev: number;
  /** material_rev already handled by the AI (null = never). */
  handledRev: number | null;
  status: string;
  kind: IncidentKind;
  priority: Priority;
  basePriority: Priority;
  firewallDown: boolean;
  harvestCriticalInHarvest: boolean;
  seeded: boolean;
  context: IncidentContext;
  previous: PreviousSummary | null;
}

const MAX_ALERTS = 25;
const MAX_NODES = 30;

/** Everything a summary is written from, read-only. Null when the incident is gone. */
export async function loadAiIncidentSnapshot(
  db: DbOrTx,
  id: number,
  now: Date,
  timeZone: string,
): Promise<AiIncidentSnapshot | null> {
  const fmt = (d: Date | null) => (d ? localDateTime(d, timeZone) : null);
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, id));
  if (!inc) return null;
  const [siteRow] = inc.primarySiteId
    ? await db
        .select({ site: sites, division: divisions.name })
        .from(sites)
        .leftJoin(divisions, eq(divisions.code, sites.divisionCode))
        .where(eq(sites.id, inc.primarySiteId))
    : [];
  const affected = inc.affectedSiteIds.length
    ? await db
        .select({ name: sites.name })
        .from(sites)
        .where(inArray(sites.id, inc.affectedSiteIds))
        .orderBy(asc(sites.name))
    : [];

  const members = await db
    .select({ r: alertRecords })
    .from(incidentMembers)
    .innerJoin(alertRecords, eq(alertRecords.id, incidentMembers.alertRecordId))
    .where(eq(incidentMembers.incidentId, id))
    .orderBy(
      sql`CASE WHEN ${alertRecords.state} = 'active' THEN 0 ELSE 1 END`,
      desc(alertRecords.lastRaisedAt),
    );
  const nodeIds = [
    ...new Set(
      [inc.rootNodeId, ...members.map((m) => m.r.nodeId)].filter((n): n is number => n !== null),
    ),
  ];
  const nodeRows = nodeIds.length
    ? await db
        .select({
          nodeId: orionNodes.nodeId,
          caption: orionNodes.caption,
          role: orionNodes.deviceRole,
          status: orionNodes.statusNorm,
          vendor: orionNodes.vendor,
          model: orionNodes.machineType,
          site: sites.name,
        })
        .from(orionNodes)
        .leftJoin(sites, eq(sites.id, orionNodes.siteId))
        .where(inArray(orionNodes.nodeId, nodeIds))
    : [];
  const nodesById = new Map(nodeRows.map((n) => [n.nodeId, n]));
  const toNode = (n: (typeof nodeRows)[number]) => ({
    caption: n.caption,
    role: n.role,
    status: n.status,
    site: n.site,
    vendor: n.vendor,
    model: n.model,
  });
  const ifaceIds = [
    ...new Set(members.map((m) => m.r.interfaceId).filter((n): n is number => n !== null)),
  ];
  const ifaces = ifaceIds.length
    ? await db
        .select({
          nodeId: orionInterfaces.nodeId,
          name: orionInterfaces.caption,
          fallbackName: orionInterfaces.name,
          status: orionInterfaces.statusNorm,
          inUtil: orionInterfaces.inPercentUtil,
          outUtil: orionInterfaces.outPercentUtil,
        })
        .from(orionInterfaces)
        .where(inArray(orionInterfaces.interfaceId, ifaceIds.slice(0, 20)))
    : [];
  const events = await db
    .select({ at: incidentEvents.at, message: incidentEvents.message, type: incidentEvents.type })
    .from(incidentEvents)
    .where(and(eq(incidentEvents.incidentId, id), ne(incidentEvents.type, 'ai_summary')))
    .orderBy(desc(incidentEvents.at), desc(incidentEvents.id))
    .limit(15);
  const history = inc.primarySiteId
    ? await db
        .select({
          id: incidents.id,
          title: incidents.title,
          aiTitle: incidents.aiTitle,
          openedAt: incidents.openedAt,
          resolvedAt: incidents.resolvedAt,
        })
        .from(incidents)
        .where(
          and(
            eq(incidents.primarySiteId, inc.primarySiteId),
            ne(incidents.id, id),
            gte(incidents.openedAt, new Date(now.getTime() - 30 * 86_400_000)),
            lt(incidents.openedAt, inc.openedAt),
          ),
        )
        .orderBy(desc(incidents.openedAt))
        .limit(5)
    : [];

  const seasons = await listSeasons(db);
  const site = siteRow?.site ?? null;
  const harvest = isHarvest(seasons, now, timeZone);
  const factors = inc.priorityFactors;
  const root = inc.rootNodeId !== null ? nodesById.get(inc.rootNodeId) : undefined;
  const omitted: string[] = [];
  if (members.length > MAX_ALERTS)
    omitted.push(`showing ${MAX_ALERTS} of ${members.length} alerts`);
  if (nodeRows.length > MAX_NODES)
    omitted.push(`showing ${MAX_NODES} of ${nodeRows.length} devices`);
  const prev = readStoredAiSummary(inc.aiSummary);

  const context: IncidentContext = {
    id: inc.id,
    now: localDateTime(now, timeZone),
    timeZone,
    status: inc.status,
    priority: inc.priority,
    basePriority: inc.basePriority,
    kind: inc.kind,
    templateTitle: inc.title,
    templateSummary: inc.templateSummary,
    priorityExplanation: factors.explanation.join('; '),
    openedAt: fmt(inc.openedAt)!,
    acknowledgedBy: inc.acknowledgedBy,
    resolvedAt: fmt(inc.resolvedAt),
    alertCount: inc.alertCount,
    memberCount: inc.memberCount,
    site: site ? { code: site.code, name: site.name, division: siteRow?.division ?? null } : null,
    affectedSites: affected.map((a) => a.name),
    inHarvest: harvest,
    withinBusinessHours: factors.businessHours,
    recoveryTargetMin: inc.recoveryTargetMin,
    inMaintenance: inc.inMaintenance,
    rootNode: root ? toNode(root) : null,
    nodes: nodeRows
      .filter((n) => n.nodeId !== inc.rootNodeId)
      .sort((a, b) => a.caption.localeCompare(b.caption))
      .slice(0, MAX_NODES)
      .map(toNode),
    alerts: members.slice(0, MAX_ALERTS).map(({ r }) => ({
      name: r.alertName,
      entity: r.entityCaption,
      severity: r.severity,
      state: r.state,
      message: r.lastMessage?.slice(0, 400) ?? null,
      raisedAt: fmt(r.lastRaisedAt)!,
      clearedAt: fmt(r.clearedAt),
    })),
    interfaces: ifaces.map((i) => ({
      node: nodesById.get(i.nodeId)?.caption ?? `node ${i.nodeId}`,
      name: i.name ?? i.fallbackName ?? 'interface',
      status: i.status,
      inUtilPct: i.inUtil === null ? null : Math.round(i.inUtil),
      outUtilPct: i.outUtil === null ? null : Math.round(i.outUtil),
    })),
    timeline: events.reverse().map((e) => ({ at: fmt(e.at)!, event: e.message.slice(0, 300) })),
    history: history.map((h) => ({
      id: h.id,
      title: h.aiTitle ?? h.title,
      openedAt: fmt(h.openedAt)!,
      durationMin: h.resolvedAt
        ? Math.round((h.resolvedAt.getTime() - h.openedAt.getTime()) / 60_000)
        : null,
    })),
    omitted,
  };
  return {
    id: inc.id,
    materialRev: inc.materialRev,
    handledRev: inc.aiSummaryMaterialRev,
    status: inc.status,
    kind: inc.kind,
    priority: inc.priority,
    basePriority: inc.basePriority,
    firewallDown:
      factors.firewallDown ?? nodeRows.some((n) => n.role === 'firewall' && n.status === 'down'),
    harvestCriticalInHarvest:
      factors.harvestCriticalInHarvest ?? (harvest && !!site?.harvestCritical),
    seeded: inc.seeded,
    context,
    previous: prev
      ? {
          title: prev.title,
          short: prev.short,
          likelyCause: prev.likelyCause,
          generatedAt: prev.generatedAt,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Writing results back
// ---------------------------------------------------------------------------------------------

export type AiStatus = 'ok' | 'fallback' | 'error' | 'refused' | 'budget_blocked' | 'disabled';

export interface AiEnrichment {
  /** The snapshot the AI worked from. */
  materialRev: number;
  kind: IncidentKind;
  basePriority: Priority;
  /** New summary (placeholders restored), or null when the summary step produced nothing. */
  summary: StoredAiSummary | null;
  /** Priority decision, or null when it was not asked or failed. */
  priority: { decision: AiPriorityDecision; reason: string; mode: 'apply' | 'suggest' } | null;
  status: AiStatus;
}

export interface AiWriteResult {
  written: boolean;
  priorityChanged: { from: Priority; to: Priority } | null;
}

/**
 * Store a summary and priority decision. Runs under the correlation lock like a person's action,
 * so it can never interleave with a correlation cycle. The priority step is applied only if
 * nothing material changed since the snapshot; the summary is stored either way (it describes
 * the snapshot, and a newer change will be summarized next).
 */
export async function applyAiEnrichment(
  db: Db,
  incidentId: number,
  e: AiEnrichment,
  now = new Date(),
): Promise<AiWriteResult> {
  return db.transaction(async (tx) => {
    await lockCorrelation(tx);
    const [inc] = await tx
      .select()
      .from(incidents)
      .where(eq(incidents.id, incidentId))
      .for('update');
    if (!inc) return { written: false, priorityChanged: null };
    const current =
      inc.materialRev === e.materialRev &&
      inc.kind === e.kind &&
      inc.basePriority === e.basePriority;
    const patch: Partial<typeof incidents.$inferInsert> = {
      aiStatus: e.status,
      aiAttempts: 0,
      aiNextAttemptAt: null,
      updatedAt: now,
    };
    const events: Array<typeof incidentEvents.$inferInsert> = [];
    let priorityChanged: AiWriteResult['priorityChanged'] = null;
    let materialRev = inc.materialRev;

    if (e.priority && current && OPEN.has(inc.status)) {
      const { decision, reason, mode } = e.priority;
      patch.aiPrioritySuggested = decision.suggested;
      patch.aiPriorityReason = reason;
      patch.guardrailNote = decision.guardrail;
      if (mode === 'apply') {
        patch.aiPriorityAdjust = decision.applied;
        patch.aiPriorityBasis = decision.applied ? decision.basis : null;
        if (decision.priority !== inc.priority) {
          priorityChanged = { from: inc.priority, to: decision.priority };
          patch.priority = decision.priority;
          materialRev += 1;
          patch.materialRev = materialRev;
          events.push({
            incidentId,
            at: now,
            type: 'priority_changed',
            actor: 'ai',
            message: `Priority ${inc.priority} → ${decision.priority} (AI: ${reason})`,
            details: {
              from: inc.priority,
              to: decision.priority,
              suggested: decision.suggested,
              guardrail: decision.guardrail,
            },
          });
        }
      }
    }
    if (e.summary) {
      patch.aiTitle = e.summary.title;
      patch.aiSummary = e.summary;
      patch.aiSummaryAt = now;
      patch.aiSummaryRev = inc.aiSummaryRev + 1;
      events.push({
        incidentId,
        at: now,
        type: 'ai_summary',
        actor: 'ai',
        message: `AI summary: ${e.summary.short}`,
        details: {
          model: e.summary.model,
          confidence: e.summary.confidence,
          rev: inc.aiSummaryRev + 1,
        },
      });
    }
    // Handled up to the snapshot; if we just bumped material_rev ourselves, that change is ours.
    patch.aiSummaryMaterialRev = current ? materialRev : e.materialRev;
    await tx.update(incidents).set(patch).where(eq(incidents.id, incidentId));
    if (events.length) await tx.insert(incidentEvents).values(events);
    await publishEvent(tx, { t: 'incident', id: incidentId, change: 'ai' });
    return { written: true, priorityChanged };
  });
}

const OPEN = new Set(['open', 'acknowledged']);

/** Minutes to wait after the n-th transient failure (API down, timeout, rate limit). */
export const AI_RETRY_MIN = [2, 5, 15, 30, 60];

/**
 * A transient failure: try again later, and give up on this material change after the last
 * backoff step (the template stays). Budget exhaustion waits until `retryAt` (tomorrow).
 */
export async function recordAiDeferral(
  db: DbOrTx,
  incidentId: number,
  materialRev: number,
  status: AiStatus,
  now: Date,
  retryAt?: Date,
): Promise<{ gaveUp: boolean }> {
  const [inc] = await db
    .select({ attempts: incidents.aiAttempts })
    .from(incidents)
    .where(eq(incidents.id, incidentId));
  if (!inc) return { gaveUp: true };
  if (retryAt) {
    await db
      .update(incidents)
      .set({ aiStatus: status, aiNextAttemptAt: retryAt })
      .where(eq(incidents.id, incidentId));
    return { gaveUp: false };
  }
  const attempts = inc.attempts + 1;
  const gaveUp = attempts > AI_RETRY_MIN.length;
  await db
    .update(incidents)
    .set(
      gaveUp
        ? {
            aiStatus: status,
            aiAttempts: 0,
            aiNextAttemptAt: null,
            aiSummaryMaterialRev: materialRev,
          }
        : {
            aiStatus: status,
            aiAttempts: attempts,
            aiNextAttemptAt: new Date(now.getTime() + AI_RETRY_MIN[attempts - 1]! * 60_000),
          },
    )
    .where(eq(incidents.id, incidentId));
  return { gaveUp };
}

// ---------------------------------------------------------------------------------------------
// Digest facts
// ---------------------------------------------------------------------------------------------

function digestIncident(
  r: {
    id: number;
    title: string;
    aiTitle: string | null;
    priority: Priority;
    status: string;
    site: string | null;
    openedAt: Date;
    resolvedAt: Date | null;
    alertCount: number;
    acknowledgedBy: string | null;
  },
  timeZone: string,
): DigestIncident {
  return {
    id: r.id,
    title: r.aiTitle ?? r.title,
    priority: r.priority,
    status: r.status,
    site: r.site,
    openedAt: localDateTime(r.openedAt, timeZone),
    durationMin: r.resolvedAt
      ? Math.round((r.resolvedAt.getTime() - r.openedAt.getTime()) / 60_000)
      : null,
    alertCount: r.alertCount,
    acknowledgedBy: r.acknowledgedBy,
  };
}

const incidentCols = {
  id: incidents.id,
  title: incidents.title,
  aiTitle: incidents.aiTitle,
  priority: incidents.priority,
  status: incidents.status,
  site: sites.name,
  openedAt: incidents.openedAt,
  resolvedAt: incidents.resolvedAt,
  alertCount: incidents.alertCount,
  acknowledgedBy: incidents.acknowledgedBy,
};

async function noiseFacts(db: DbOrTx, start: Date, end: Date): Promise<NoiseFacts> {
  // Same definition as the dashboard's noise ratio (noiseStats), over a closed period.
  const [raw] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entityTransitions)
    .where(
      and(
        eq(entityTransitions.kind, 'alert'),
        inArray(entityTransitions.change, ['raised', 'retriggered']),
        gte(entityTransitions.observedAt, start),
        lt(entityTransitions.observedAt, end),
        sql`coalesce((${entityTransitions.details}->>'initialSync')::boolean, false) = false`,
      ),
    );
  const [inc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(incidents)
    .where(
      and(gte(incidents.openedAt, start), lt(incidents.openedAt, end), eq(incidents.seeded, false)),
    );
  const rawAlerts = raw?.n ?? 0;
  const count = inc?.n ?? 0;
  const [msgs] = await db
    .select({
      teams: sql<number>`count(*) filter (where ${notifications.kind} = 'teams' and ${notifications.status} = 'sent')::int`,
      pages: sql<number>`count(*) filter (where ${notifications.kind} in ('sms','pushover') and ${notifications.status} = 'sent')::int`,
      suppressed: sql<number>`count(*) filter (where ${notifications.status} = 'suppressed')::int`,
    })
    .from(notifications)
    .where(
      and(
        gte(notifications.createdAt, start),
        lt(notifications.createdAt, end),
        ne(notifications.purpose, 'digest'),
        ne(notifications.purpose, 'test'),
      ),
    );
  return {
    rawAlerts,
    incidents: count,
    ratio: count ? Math.round((rawAlerts / count) * 10) / 10 : null,
    teamsPosts: msgs?.teams ?? 0,
    pages: msgs?.pages ?? 0,
    suppressed: msgs?.suppressed ?? 0,
  };
}

/** Per-interface utilization stats over a period from the 5-minute rollups. */
async function interfaceUtil(db: DbOrTx, start: Date, end: Date, limit: number) {
  const util = sql<number>`greatest(coalesce(${interfaceMetrics5m.inUtilMax}, 0), coalesce(${interfaceMetrics5m.outUtilMax}, 0))`;
  const avg = sql<number>`greatest(coalesce(${interfaceMetrics5m.inUtilAvg}, 0), coalesce(${interfaceMetrics5m.outUtilAvg}, 0))`;
  return db
    .select({
      interfaceId: interfaceMetrics5m.interfaceId,
      iface: sql<string>`coalesce(max(${orionInterfaces.caption}), max(${orionInterfaces.name}), 'interface')`,
      node: sql<string>`max(${orionNodes.caption})`,
      site: sql<string | null>`max(${sites.name})`,
      peak: sql<number>`round(max(${util})::numeric)::int`,
      avg: sql<number>`round(avg(${avg})::numeric)::int`,
      p95: sql<number>`round((percentile_cont(0.95) within group (order by ${avg}))::numeric)::int`,
      daysOver80: sql<number>`count(distinct date_trunc('day', ${interfaceMetrics5m.bucket})) filter (where ${avg} >= 80)::int`,
    })
    .from(interfaceMetrics5m)
    .innerJoin(orionInterfaces, eq(orionInterfaces.interfaceId, interfaceMetrics5m.interfaceId))
    .innerJoin(orionNodes, eq(orionNodes.nodeId, orionInterfaces.nodeId))
    .leftJoin(sites, eq(sites.id, orionNodes.siteId))
    .where(and(gte(interfaceMetrics5m.bucket, start), lt(interfaceMetrics5m.bucket, end)))
    .groupBy(interfaceMetrics5m.interfaceId)
    .orderBy(desc(sql`max(${util})`))
    .limit(limit);
}

/** Node state changes per node over a period (flapping candidates). */
async function nodeChanges(db: DbOrTx, start: Date, end: Date, min: number) {
  return db
    .select({
      node: sql<string>`max(${orionNodes.caption})`,
      site: sql<string | null>`max(${sites.name})`,
      changes: sql<number>`count(*)::int`,
    })
    .from(entityTransitions)
    .innerJoin(orionNodes, eq(orionNodes.nodeId, entityTransitions.nodeId))
    .leftJoin(sites, eq(sites.id, orionNodes.siteId))
    .where(
      and(
        eq(entityTransitions.kind, 'node'),
        gte(entityTransitions.observedAt, start),
        lt(entityTransitions.observedAt, end),
      ),
    )
    .groupBy(entityTransitions.nodeId)
    .having(sql`count(*) >= ${min}`)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
}

/** Incidents grouped by root device (or site when there is no single device). */
async function incidentsBySubject(db: DbOrTx, start: Date, end: Date) {
  const subject = sql<string>`coalesce(${orionNodes.caption}, ${sites.name}, 'unknown')`;
  return db
    .select({
      subject,
      site: sql<string | null>`max(${sites.name})`,
      incidents: sql<number>`count(*)::int`,
      downMinutes: sql<number>`coalesce(sum(extract(epoch from (coalesce(${incidents.resolvedAt}, ${end}::timestamptz) - ${incidents.openedAt})) / 60), 0)::int`,
      ids: sql<number[]>`array_agg(${incidents.id} order by ${incidents.id} desc)`,
    })
    .from(incidents)
    .leftJoin(orionNodes, eq(orionNodes.nodeId, incidents.rootNodeId))
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .where(
      and(
        gte(incidents.openedAt, start),
        lt(incidents.openedAt, end),
        eq(incidents.seeded, false),
        sql`coalesce(${incidents.resolvedBy}, '') <> 'merged'`,
      ),
    )
    .groupBy(subject)
    .orderBy(desc(sql`count(*)`));
}

export async function dailyDigestFacts(
  db: DbOrTx,
  periodStart: Date,
  periodEnd: Date,
  timeZone: string,
): Promise<DailyFacts> {
  const overnight = await db
    .select(incidentCols)
    .from(incidents)
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .where(
      and(
        gte(incidents.openedAt, periodStart),
        lt(incidents.openedAt, periodEnd),
        eq(incidents.seeded, false),
      ),
    )
    .orderBy(asc(incidents.priority), asc(incidents.id))
    .limit(40);
  const stillOpen = await db
    .select(incidentCols)
    .from(incidents)
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .where(inArray(incidents.status, ['open', 'acknowledged']))
    .orderBy(asc(incidents.priority), asc(incidents.id))
    .limit(40);
  const links = await interfaceUtil(db, periodStart, periodEnd, 5);
  const weekAgo = addZonedDays(periodEnd, -7, timeZone);
  const recurring = (await incidentsBySubject(db, weekAgo, periodEnd)).filter(
    (r) => r.incidents >= 3,
  );
  const seasons = await listSeasons(db);
  return {
    kind: 'daily',
    timeZone,
    periodStart: localDateTime(periodStart, timeZone),
    periodEnd: localDateTime(periodEnd, timeZone),
    inHarvest: isHarvest(seasons, periodEnd, timeZone),
    overnight: overnight.map((r) => digestIncident(r, timeZone)),
    stillOpen: stillOpen.map((r) => digestIncident(r, timeZone)),
    flapping: (await nodeChanges(db, periodStart, periodEnd, 6)).map((r) => ({
      node: r.node,
      site: r.site,
      changes: r.changes,
    })),
    busiestLinks: links
      .filter((l) => l.peak >= 50)
      .map((l) => ({
        node: l.node,
        interface: l.iface,
        site: l.site,
        peakUtilPct: l.peak,
        avgUtilPct: l.avg,
      })),
    recurring: recurring.slice(0, 6).map((r) => ({
      subject: r.subject,
      site: r.site,
      incidents: r.incidents,
      lastId: r.ids[0]!,
    })),
    noise: await noiseFacts(db, periodStart, periodEnd),
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

export async function weeklyDigestFacts(
  db: DbOrTx,
  periodStart: Date,
  periodEnd: Date,
  timeZone: string,
): Promise<WeeklyFacts> {
  const prevStart = addZonedDays(periodStart, -7, timeZone);
  const week = await db
    .select({
      priority: incidents.priority,
      openedAt: incidents.openedAt,
      acknowledgedAt: incidents.acknowledgedAt,
      resolvedAt: incidents.resolvedAt,
    })
    .from(incidents)
    .where(
      and(
        gte(incidents.openedAt, periodStart),
        lt(incidents.openedAt, periodEnd),
        eq(incidents.seeded, false),
      ),
    );
  const mins = (a: Date, b: Date | null) => (b ? (b.getTime() - a.getTime()) / 60_000 : null);
  const ack = week.map((w) => mins(w.openedAt, w.acknowledgedAt)).filter((n) => n !== null);
  const res = week.map((w) => mins(w.openedAt, w.resolvedAt)).filter((n) => n !== null);

  const thisWeek = await incidentsBySubject(db, periodStart, periodEnd);
  const bySite = async (start: Date, end: Date) =>
    new Map(
      (
        await db
          .select({
            site: sites.name,
            incidents: sql<number>`count(*)::int`,
            downMinutes: sql<number>`coalesce(sum(extract(epoch from (coalesce(${incidents.resolvedAt}, ${end}::timestamptz) - ${incidents.openedAt})) / 60), 0)::int`,
          })
          .from(incidents)
          .innerJoin(sites, eq(sites.id, incidents.primarySiteId))
          .where(
            and(
              gte(incidents.openedAt, start),
              lt(incidents.openedAt, end),
              eq(incidents.seeded, false),
            ),
          )
          .groupBy(sites.name)
      ).map((r) => [r.site, r]),
    );
  const [nowSites, prevSites] = [
    await bySite(periodStart, periodEnd),
    await bySite(prevStart, periodStart),
  ];
  const worsening = [...nowSites.values()]
    .map((s) => {
      const p = prevSites.get(s.site);
      return {
        site: s.site,
        incidents: s.incidents,
        previousIncidents: p?.incidents ?? 0,
        downMinutes: s.downMinutes,
        previousDownMinutes: p?.downMinutes ?? 0,
      };
    })
    .filter(
      (s) =>
        s.incidents >= 2 &&
        (s.incidents >= s.previousIncidents * 2 || s.downMinutes >= s.previousDownMinutes * 2 + 30),
    )
    .sort((a, b) => b.incidents - a.incidents || b.downMinutes - a.downMinutes)
    .slice(0, 6);

  const capacity = (await interfaceUtil(db, periodStart, periodEnd, 30))
    .filter((c) => c.p95 >= 70 || c.daysOver80 >= 2)
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 6);

  // Orion alert definitions that look misconfigured: many raises, mostly clearing within
  // 5 minutes, and rarely part of an incident above P4.
  const ruleRows = await db
    .select({
      alertName: alertRecords.alertName,
      raises: sql<number>`coalesce(sum(${alertRecords.triggerCount}), 0)::int`,
      records: sql<number>`count(*)::int`,
      shortLived: sql<number>`count(*) filter (where ${alertRecords.clearedAt} is not null and ${alertRecords.clearedAt} - ${alertRecords.lastRaisedAt} < interval '5 minutes')::int`,
      medianMin: sql<
        number | null
      >`round((percentile_cont(0.5) within group (order by extract(epoch from (${alertRecords.clearedAt} - ${alertRecords.lastRaisedAt})) / 60))::numeric)::int`,
      inIncidents: sql<number>`count(distinct ${incidents.id}) filter (where ${incidents.priority} <> 'P4')::int`,
    })
    .from(alertRecords)
    .leftJoin(incidents, eq(incidents.id, alertRecords.incidentId))
    .where(
      and(gte(alertRecords.lastRaisedAt, periodStart), lt(alertRecords.lastRaisedAt, periodEnd)),
    )
    .groupBy(alertRecords.alertName)
    .having(sql`coalesce(sum(${alertRecords.triggerCount}), 0) >= 20`)
    .orderBy(desc(sql`coalesce(sum(${alertRecords.triggerCount}), 0)`))
    .limit(20);
  const noisyRules = ruleRows
    .map((r) => {
      const shortPct = r.records ? Math.round((r.shortLived / r.records) * 100) : 0;
      const reasons: string[] = [];
      if (shortPct >= 60) reasons.push(`${shortPct}% clear within 5 min`);
      if (r.inIncidents === 0) reasons.push('never part of an incident above P4');
      if (r.raises >= 100) reasons.push(`${r.raises} raises in a week`);
      return {
        alertName: r.alertName,
        raises: r.raises,
        shortLivedPct: shortPct,
        medianDurationMin: r.medianMin,
        inIncidents: r.inIncidents,
        reasons,
      };
    })
    .filter((r) => r.reasons.length >= 2)
    .slice(0, 6);

  return {
    kind: 'weekly',
    timeZone,
    periodStart: localDateTime(periodStart, timeZone).slice(0, 10),
    periodEnd: localDateTime(periodEnd, timeZone).slice(0, 10),
    totals: {
      incidents: week.length,
      p1: week.filter((w) => w.priority === 'P1').length,
      p2: week.filter((w) => w.priority === 'P2').length,
      medianAckMin: median(ack),
      medianResolveMin: median(res),
    },
    repeatOffenders: thisWeek
      .filter((r) => r.incidents >= 2)
      .slice(0, 6)
      .map((r) => ({
        subject: r.subject,
        site: r.site,
        incidents: r.incidents,
        downMinutes: r.downMinutes,
        incidentIds: r.ids.slice(0, 5),
      })),
    worseningSites: worsening,
    capacity: capacity.map((c) => ({
      node: c.node,
      interface: c.iface,
      site: c.site,
      p95UtilPct: c.p95,
      peakUtilPct: c.peak,
      daysOver80: c.daysOver80,
    })),
    noisyRules,
    noise: await noiseFacts(db, periodStart, periodEnd),
    previousNoise: await noiseFacts(db, prevStart, periodStart),
  };
}

// ---------------------------------------------------------------------------------------------
// Digest archive
// ---------------------------------------------------------------------------------------------

export async function findDigest(
  db: DbOrTx,
  kind: 'daily' | 'weekly',
  periodStart: Date,
): Promise<DigestRow | undefined> {
  const [r] = await db
    .select()
    .from(digests)
    .where(and(eq(digests.kind, kind), eq(digests.periodStart, periodStart)));
  return r;
}

/** Store a digest; returns null when one for this period already exists (cron fired twice). */
export async function saveDigest(
  db: DbOrTx,
  d: {
    kind: 'daily' | 'weekly';
    periodStart: Date;
    periodEnd: Date;
    source: 'ai' | 'template';
    content: DigestContent;
    facts: DigestFacts;
    markdown: string;
    aiCallId: number | null;
  },
): Promise<number | null> {
  const [r] = await db
    .insert(digests)
    .values(d)
    .onConflictDoNothing({ target: [digests.kind, digests.periodStart] })
    .returning({ id: digests.id });
  return r?.id ?? null;
}

export async function linkDigestNotification(
  db: DbOrTx,
  digestId: number,
  notificationId: number,
): Promise<void> {
  await db.update(digests).set({ notificationId }).where(eq(digests.id, digestId));
}

export async function listDigests(db: DbOrTx, limit = 60) {
  return db
    .select({
      id: digests.id,
      kind: digests.kind,
      periodStart: digests.periodStart,
      periodEnd: digests.periodEnd,
      source: digests.source,
      headline: sql<string>`${digests.content}->>'headline'`,
      createdAt: digests.createdAt,
      notificationStatus: notifications.status,
      suppressReason: notifications.suppressReason,
    })
    .from(digests)
    .leftJoin(notifications, eq(notifications.id, digests.notificationId))
    .orderBy(desc(digests.periodStart), desc(digests.id))
    .limit(limit);
}

export async function getDigest(db: DbOrTx, id: number): Promise<DigestRow | undefined> {
  const [r] = await db.select().from(digests).where(eq(digests.id, id));
  return r;
}
