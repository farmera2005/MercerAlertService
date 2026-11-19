/**
 * The read-only tools behind "Ask the network". Each takes an input already validated against
 * `CHAT_TOOL_INPUTS` and returns compact JSON. Every incident, device and site carries a `ref`
 * (INC-42, NODE-1234, SITE-ROCK) that the answer must cite. No addresses, phone numbers or
 * secrets are returned; alert text is passed through (the runner redacts it before sending).
 */
import { and, asc, desc, eq, gte, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  buildTimeline,
  CHAT_TOOL_INPUTS,
  clampToolOutput,
  displayTitle,
  localDateTime,
  readStoredAiSummary,
  refOf,
  siteHealth,
  type ChatToolName,
  type DeviceRole,
  type IncidentKind,
  type IncidentStatus,
  type Priority,
  type StatusNorm,
} from '@mercer/core';
import { entityTransitions, nodeMetrics5m, orionNodes, pollerState, sites } from '../schema';
import type { DbOrTx } from '../client';
import {
  getIncidentDetail,
  getNodeDetail,
  getSiteDetail,
  loadOverview,
  searchIncidents,
} from './dashboard';
import { flappingNodes, topInterfaces } from './trends';
import { siteGroupInfo } from './site-groups';

export interface ChatToolContext {
  now: Date;
  timeZone: string;
}

type Json = Record<string, unknown>;

const OPEN = new Set(['open', 'acknowledged']);

function incidentBrief(
  i: {
    id: number;
    title: string;
    aiTitle: string | null;
    priority: Priority;
    status: string;
    kind: string;
    openedAt: Date;
    resolvedAt: Date | null;
    acknowledgedBy: string | null;
    alertCount: number;
  },
  site: string | null,
  tz: string,
): Json {
  return {
    ref: refOf('incident', i.id),
    title: displayTitle(i),
    priority: i.priority,
    status: i.status,
    kind: i.kind,
    site,
    opened: localDateTime(i.openedAt, tz),
    resolved: i.resolvedAt ? localDateTime(i.resolvedAt, tz) : null,
    duration_min: i.resolvedAt
      ? Math.round((i.resolvedAt.getTime() - i.openedAt.getTime()) / 60_000)
      : null,
    acknowledged_by: i.acknowledgedBy,
    alerts: i.alertCount,
  };
}

/** A site by code (exact) or name/city (contains), for tools that take free text. */
async function resolveSite(db: DbOrTx, text: string) {
  const t = text.trim();
  const [exact] = await db
    .select()
    .from(sites)
    .where(eq(sql`lower(${sites.code})`, t.toLowerCase()));
  if (exact) return exact;
  const [fuzzy] = await db
    .select()
    .from(sites)
    .where(or(ilike(sites.name, `%${t}%`), ilike(sites.city, `%${t}%`)))
    .orderBy(asc(sites.name))
    .limit(1);
  return fuzzy ?? null;
}

async function networkStatus(db: DbOrTx, division: string | null, tz: string): Promise<Json> {
  const o = await loadOverview(db);
  const siteList = division ? o.sites.filter((s) => s.divisionCodes.includes(division)) : o.sites;
  const siteIds = new Set(siteList.map((s) => s.id));
  const open = o.openIncidents.filter(
    (i) => !division || (i.primarySiteId !== null && siteIds.has(i.primarySiteId)),
  );
  const unhealthy = siteList
    .map((s) => {
      const h = siteHealth(
        o.nodes
          .filter((n) => n.siteId === s.id)
          .map((n) => ({
            statusNorm: n.statusNorm as StatusNorm,
            role: n.role as DeviceRole,
            unmanaged: n.unmanaged,
          })),
        o.openIncidents
          .filter((i) => i.primarySiteId === s.id || i.affectedSiteIds.includes(s.id))
          .map((i) => ({
            priority: i.priority,
            kind: i.kind as IncidentKind,
            status: i.status as IncidentStatus,
            inMaintenance: i.inMaintenance,
            title: displayTitle(i),
          })),
      );
      return { s, h };
    })
    .filter(({ h }) => h.level === 'bad' || h.level === 'warn' || h.level === 'maintenance')
    .map(({ s, h }) => ({
      ref: refOf('site', s.code.toUpperCase()),
      site: s.name,
      division: s.divisionName,
      health: h.level,
      reason: h.reason,
    }));
  const pollers = await db.select().from(pollerState);
  const counts = { P1: 0, P2: 0, P3: 0, P4: 0 } as Record<Priority, number>;
  for (const i of open) counts[i.priority]++;
  return {
    division,
    open_incidents_by_priority: counts,
    open_incidents: open.slice(0, 20).map((i) => incidentBrief(i, i.siteName, tz)),
    sites_total: siteList.length,
    sites_not_healthy: unhealthy,
    monitoring: pollers.map((p) => ({
      poller: p.poller,
      last_success: p.lastSuccessAt ? localDateTime(p.lastSuccessAt, tz) : null,
      failures_in_a_row: p.consecutiveFailures,
    })),
  };
}

async function findIncidents(
  db: DbOrTx,
  input: (typeof CHAT_TOOL_INPUTS)['search_incidents']['_output'],
  ctx: ChatToolContext,
): Promise<Json> {
  const site = input.site ? await resolveSite(db, input.site) : null;
  if (input.site && !site) return { error: `No site matches "${input.site}".` };
  const { rows } = await searchIncidents(db, {
    status: input.status,
    priorities: input.priorities,
    siteId: site?.id,
    q: input.text ?? undefined,
    since: input.since_hours
      ? new Date(ctx.now.getTime() - input.since_hours * 3_600_000)
      : undefined,
    limit: input.limit,
  });
  return {
    count: rows.length,
    incidents: rows.map((r) => incidentBrief(r, r.siteName, ctx.timeZone)),
  };
}

async function incidentDetail(db: DbOrTx, id: number, ctx: ChatToolContext): Promise<Json> {
  const d = await getIncidentDetail(db, id, ctx.now);
  if (!d) return { error: `INC-${id} does not exist.` };
  const i = d.incident;
  const ai = readStoredAiSummary(i.aiSummary);
  const timeline = buildTimeline(d.timelineInput, 60).slice(-25);
  return {
    ...incidentBrief(i, d.site?.name ?? null, ctx.timeZone),
    site_ref: d.site ? refOf('site', d.site.code.toUpperCase()) : null,
    division: d.divisionName,
    base_priority: i.basePriority,
    priority_explanation: i.priorityFactors.explanation,
    ai_priority_note: i.aiPriorityReason,
    summary: ai
      ? {
          what_is_affected: ai.whatIsAffected,
          likely_cause: ai.likelyCause,
          confidence: ai.confidence,
          first_steps: ai.firstSteps,
        }
      : i.templateSummary,
    recovery_target_min: i.recoveryTargetMin,
    snoozed_until: i.snoozedUntil ? localDateTime(i.snoozedUntil, ctx.timeZone) : null,
    in_maintenance: i.inMaintenance,
    affected_devices: d.affectedNodes.slice(0, 30).map(({ node }) => ({
      ref: refOf('node', node.nodeId),
      hostname: node.caption,
      role: node.deviceRole,
      status: node.statusNorm,
    })),
    alerts: d.members.slice(0, 25).map((m) => ({
      alert: m.record.alertName,
      entity: m.record.entityCaption,
      node_ref: m.record.nodeId ? refOf('node', m.record.nodeId) : null,
      state: m.record.state,
      severity: m.record.severity,
      message: m.record.lastMessage?.slice(0, 300) ?? null,
      raised: localDateTime(m.record.lastRaisedAt, ctx.timeZone),
    })),
    alerts_total: d.members.length,
    timeline: timeline.map((t) => ({
      at: localDateTime(t.at, ctx.timeZone),
      what: t.text.slice(0, 200),
    })),
  };
}

async function findSites(db: DbOrTx, text: string | null, division: string | null): Promise<Json> {
  const o = await loadOverview(db);
  const t = text?.toLowerCase();
  const list = o.sites.filter(
    (s) =>
      (!division || s.divisionCodes.includes(division)) &&
      (!t ||
        s.code.toLowerCase().includes(t) ||
        s.name.toLowerCase().includes(t) ||
        (s.city ?? '').toLowerCase().includes(t)),
  );
  return {
    count: list.length,
    sites: list.slice(0, 40).map((s) => {
      const open = o.openIncidents.filter(
        (i) => i.primarySiteId === s.id || i.affectedSiteIds.includes(s.id),
      );
      const h = siteHealth(
        o.nodes
          .filter((n) => n.siteId === s.id)
          .map((n) => ({
            statusNorm: n.statusNorm as StatusNorm,
            role: n.role as DeviceRole,
            unmanaged: n.unmanaged,
          })),
        open.map((i) => ({
          priority: i.priority,
          kind: i.kind as IncidentKind,
          status: i.status as IncidentStatus,
          inMaintenance: i.inMaintenance,
          title: displayTitle(i),
        })),
      );
      return {
        ref: refOf('site', s.code.toUpperCase()),
        code: s.code,
        name: s.name,
        division: s.divisionName,
        city: s.city,
        tier: s.tier,
        harvest_critical: s.harvestCritical,
        health: h.level,
        health_reason: h.reason,
        open_incident_refs: open.map((i) => refOf('incident', i.id)),
      };
    }),
  };
}

async function siteDetail(db: DbOrTx, text: string, ctx: ChatToolContext): Promise<Json> {
  const s = await resolveSite(db, text);
  if (!s) return { error: `No site matches "${text}".` };
  const d = await getSiteDetail(db, s.code, ctx.now);
  if (!d) return { error: `No site matches "${text}".` };
  const group = (await siteGroupInfo(db, [d.site.id])).get(d.site.id);
  return {
    ref: refOf('site', d.site.code.toUpperCase()),
    code: d.site.code,
    name: d.site.name,
    division: d.divisionName,
    city: d.site.city,
    tier: d.site.tier,
    harvest_critical: d.site.harvestCritical,
    business_hours: d.site.businessHours,
    owner_group: d.site.ownerGroup,
    // Linked to a SolarWinds group: the group description is the site's notes.
    notes: (group ? group.description : d.site.contactNotes)?.slice(0, 300) ?? null,
    active_orion_alerts: d.activeAlertCount,
    devices: d.nodes.slice(0, 60).map((n) => ({
      ref: refOf('node', n.nodeId),
      hostname: n.caption,
      role: n.deviceRole,
      status: n.statusNorm,
      model: n.machineType,
    })),
    devices_total: d.nodes.length,
    incidents_30d: d.incidents.slice(0, 20).map((i) => incidentBrief(i, d.site.name, ctx.timeZone)),
  };
}

async function findNodes(
  db: DbOrTx,
  input: (typeof CHAT_TOOL_INPUTS)['find_nodes']['_output'],
): Promise<Json> {
  const where: SQL[] = [isNull(orionNodes.removedAt)];
  if (input.text) {
    const t = `%${input.text}%`;
    where.push(
      or(
        ilike(orionNodes.caption, t),
        ilike(orionNodes.dns, t),
        ilike(orionNodes.sysName, t),
        // Matching by address is allowed; the address itself is never returned.
        ilike(orionNodes.ipAddress, t),
      )!,
    );
  }
  if (input.site) {
    const s = await resolveSite(db, input.site);
    if (!s) return { error: `No site matches "${input.site}".` };
    where.push(eq(orionNodes.siteId, s.id));
  }
  if (input.role) where.push(eq(orionNodes.deviceRole, input.role));
  if (input.status) where.push(eq(orionNodes.statusNorm, input.status));
  const rows = await db
    .select({ node: orionNodes, siteCode: sites.code, siteName: sites.name })
    .from(orionNodes)
    .leftJoin(sites, eq(sites.id, orionNodes.siteId))
    .where(and(...where))
    .orderBy(asc(orionNodes.caption))
    .limit(input.limit);
  return {
    count: rows.length,
    devices: rows.map(({ node: n, siteCode, siteName }) => ({
      ref: refOf('node', n.nodeId),
      hostname: n.caption,
      role: n.deviceRole,
      status: n.statusNorm,
      site: siteName,
      site_ref: siteCode ? refOf('site', siteCode.toUpperCase()) : null,
      vendor: n.vendor,
      model: n.machineType,
    })),
  };
}

async function nodeHistory(
  db: DbOrTx,
  nodeId: number,
  hours: number,
  ctx: ChatToolContext,
): Promise<Json> {
  const d = await getNodeDetail(db, nodeId, ctx.now);
  if (!d) return { error: `NODE-${nodeId} does not exist.` };
  const since = new Date(ctx.now.getTime() - hours * 3_600_000);
  const [m] = await db
    .select({
      rtAvg: sql<number | null>`round(avg(${nodeMetrics5m.rtAvg})::numeric, 1)::float`,
      rtMax: sql<number | null>`round(max(${nodeMetrics5m.rtMax})::numeric, 1)::float`,
      lossAvg: sql<number | null>`round(avg(${nodeMetrics5m.lossAvg})::numeric, 1)::float`,
      lossMax: sql<number | null>`round(max(${nodeMetrics5m.lossMax})::numeric, 1)::float`,
      cpuAvg: sql<number | null>`round(avg(${nodeMetrics5m.cpuAvg})::numeric)::int`,
      cpuMax: sql<number | null>`round(max(${nodeMetrics5m.cpuMax})::numeric)::int`,
      memAvg: sql<number | null>`round(avg(${nodeMetrics5m.memAvg})::numeric)::int`,
      memMax: sql<number | null>`round(max(${nodeMetrics5m.memMax})::numeric)::int`,
    })
    .from(nodeMetrics5m)
    .where(and(eq(nodeMetrics5m.nodeId, nodeId), gte(nodeMetrics5m.bucket, since)));
  const changes = await db
    .select()
    .from(entityTransitions)
    .where(
      and(
        eq(entityTransitions.kind, 'node'),
        eq(entityTransitions.nodeId, nodeId),
        gte(entityTransitions.observedAt, since),
      ),
    )
    .orderBy(desc(entityTransitions.observedAt))
    .limit(40);
  const n = d.node;
  return {
    ref: refOf('node', n.nodeId),
    hostname: n.caption,
    role: n.deviceRole,
    status: n.statusNorm,
    status_since: n.lastStatusChangeAt ? localDateTime(n.lastStatusChangeAt, ctx.timeZone) : null,
    site: d.site?.name ?? null,
    site_ref: d.site ? refOf('site', d.site.code.toUpperCase()) : null,
    vendor: n.vendor,
    model: n.machineType,
    last_boot: n.lastBoot ? localDateTime(n.lastBoot, ctx.timeZone) : null,
    period_hours: hours,
    metrics: {
      response_ms: { avg: m?.rtAvg ?? null, max: m?.rtMax ?? null },
      packet_loss_pct: { avg: m?.lossAvg ?? null, max: m?.lossMax ?? null },
      cpu_pct: { avg: m?.cpuAvg ?? null, max: m?.cpuMax ?? null },
      memory_pct: { avg: m?.memAvg ?? null, max: m?.memMax ?? null },
    },
    status_changes: changes.map((c) => ({
      at: localDateTime(c.observedAt, ctx.timeZone),
      from: c.fromState,
      to: c.toState,
    })),
    active_orion_alerts: d.activeAlerts.slice(0, 15).map((a) => ({
      alert: a.alertName,
      message: a.message?.slice(0, 200) ?? null,
      since: a.triggeredAt ? localDateTime(a.triggeredAt, ctx.timeZone) : null,
      acknowledged: a.acknowledged,
    })),
    incidents_30d: d.incidents.slice(0, 15).map((i) => ({
      ref: refOf('incident', i.id),
      title: displayTitle(i),
      priority: i.priority,
      status: i.status,
      opened: localDateTime(i.openedAt, ctx.timeZone),
      open: OPEN.has(i.status),
    })),
  };
}

async function interfaceUtilization(
  db: DbOrTx,
  input: (typeof CHAT_TOOL_INPUTS)['get_interface_utilization']['_output'],
  ctx: ChatToolContext,
): Promise<Json> {
  const site = input.site ? await resolveSite(db, input.site) : null;
  if (input.site && !site) return { error: `No site matches "${input.site}".` };
  const rows = await topInterfaces(db, {
    start: new Date(ctx.now.getTime() - input.hours * 3_600_000),
    end: ctx.now,
    limit: input.limit,
    nodeId: input.node_id,
    siteId: site?.id ?? null,
  });
  return {
    period_hours: input.hours,
    note: 'Percent of interface speed; peak is the highest 5-minute value in either direction.',
    interfaces: rows.map((r) => ({
      device_ref: refOf('node', r.nodeId),
      hostname: r.node,
      interface: r.iface,
      site: r.site,
      site_ref: r.siteCode ? refOf('site', r.siteCode.toUpperCase()) : null,
      in_avg_pct: r.inAvg,
      out_avg_pct: r.outAvg,
      peak_pct: r.peak,
      p95_pct: r.p95,
    })),
  };
}

async function flapping(db: DbOrTx, hours: number, limit: number, ctx: ChatToolContext) {
  const rows = await flappingNodes(db, {
    start: new Date(ctx.now.getTime() - hours * 3_600_000),
    end: ctx.now,
    min: 3,
    limit,
  });
  return {
    period_hours: hours,
    devices: rows.map((r) => ({
      ref: refOf('node', r.nodeId),
      hostname: r.node,
      role: r.role,
      site: r.site,
      site_ref: r.siteCode ? refOf('site', r.siteCode.toUpperCase()) : null,
      state_changes: r.changes,
    })),
  };
}

export type ChatToolResult = { ok: true; output: string } | { ok: false; output: string };

/**
 * Run one tool call from the model. The input is validated here; a bad input or a missing
 * entity comes back as an error result the model can correct, never as an exception.
 */
export async function runChatTool(
  db: DbOrTx,
  name: string,
  rawInput: unknown,
  ctx: ChatToolContext,
): Promise<ChatToolResult> {
  if (!(name in CHAT_TOOL_INPUTS))
    return { ok: false, output: JSON.stringify({ error: `Unknown tool ${name}.` }) };
  const tool = name as ChatToolName;
  const parsed = CHAT_TOOL_INPUTS[tool].safeParse(rawInput);
  if (!parsed.success)
    return {
      ok: false,
      output: JSON.stringify({
        error: 'Invalid input',
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      }),
    };
  const input = parsed.data as never;
  let out: Json;
  switch (tool) {
    case 'get_network_status':
      out = await networkStatus(db, (input as { division: string | null }).division, ctx.timeZone);
      break;
    case 'search_incidents':
      out = await findIncidents(db, input, ctx);
      break;
    case 'get_incident':
      out = await incidentDetail(db, (input as { incident_id: number }).incident_id, ctx);
      break;
    case 'find_sites': {
      const i = input as { text: string | null; division: string | null };
      out = await findSites(db, i.text, i.division);
      break;
    }
    case 'get_site':
      out = await siteDetail(db, (input as { site: string }).site, ctx);
      break;
    case 'find_nodes':
      out = await findNodes(db, input);
      break;
    case 'get_node_history': {
      const i = input as { node_id: number; hours: number };
      out = await nodeHistory(db, i.node_id, i.hours, ctx);
      break;
    }
    case 'get_interface_utilization':
      out = await interfaceUtilization(db, input, ctx);
      break;
    case 'get_flapping_devices': {
      const i = input as { hours: number; limit: number };
      out = await flapping(db, i.hours, i.limit, ctx);
      break;
    }
  }
  const ok = !('error' in out);
  return { ok, output: clampToolOutput(JSON.stringify(out)) };
}
