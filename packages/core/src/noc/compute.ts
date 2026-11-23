/**
 * The figures NOC widgets show, computed from plain rows (pure; browser-safe). The web app loads
 * the rows and renders the results; nothing here reads the database or the clock.
 */
import type { BoardFilters } from './board';

// ---------------------------------------------------------------------------------------------
// Scope: which sites (and so which incidents) a board shows
// ---------------------------------------------------------------------------------------------

export interface ScopeSite {
  id: number;
  divisionCodes: readonly string[];
  harvestCritical: boolean;
}

/** The sites a board's filters allow, or null for "everything" (no filters). */
export function boardScope(f: BoardFilters, sites: readonly ScopeSite[]): Set<number> | null {
  if (!f.divisions.length && !f.harvestCriticalOnly && !f.siteIds.length) return null;
  const ids = new Set(f.siteIds);
  return new Set(
    sites
      .filter(
        (s) =>
          (!f.divisions.length || s.divisionCodes.some((d) => f.divisions.includes(d))) &&
          (!f.harvestCriticalOnly || s.harvestCritical) &&
          (!ids.size || ids.has(s.id)),
      )
      .map((s) => s.id),
  );
}

/** An incident is on a filtered board when its site, or one it affects, is in scope. */
export function incidentInScope(
  i: { primarySiteId: number | null; affectedSiteIds: readonly number[] },
  scope: Set<number> | null,
): boolean {
  if (!scope) return true;
  return (
    (i.primarySiteId !== null && scope.has(i.primarySiteId)) ||
    i.affectedSiteIds.some((id) => scope.has(id))
  );
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/** Time left to the recovery target; negative once it has passed. */
export function recoveryLeftMs(
  i: { openedAt: Date; recoveryTargetMin: number },
  now: Date,
): number {
  return i.openedAt.getTime() + i.recoveryTargetMin * 60_000 - now.getTime();
}

/** "14 min", "3 h 46 min", "2 d 5 h"; the sign is the caller's to show. */
export function durationText(ms: number): string {
  const min = Math.floor(Math.abs(ms) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

// ---------------------------------------------------------------------------------------------
// Key figures
// ---------------------------------------------------------------------------------------------

export interface KpiIncident {
  openedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  /** Found already open at startup: not counted. */
  seeded: boolean;
}

export interface Kpis {
  opened: number;
  resolved: number;
  /** Median minutes from open to acknowledged, for incidents acknowledged in the window. */
  mttaMin: number | null;
  /** Median minutes from open to resolved, for incidents resolved in the window. */
  mttrMin: number | null;
  /** Raw Orion alert raises in the window. */
  alerts: number;
  /** Alerts per incident opened (the headline metric); null without incidents. */
  noiseRatio: number | null;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function incidentKpis(
  incidents: readonly KpiIncident[],
  alerts: number,
  from: Date,
  to: Date,
): Kpis {
  const inWin = (d: Date | null): d is Date =>
    !!d && d.getTime() >= from.getTime() && d.getTime() < to.getTime();
  const real = incidents.filter((i) => !i.seeded);
  const opened = real.filter((i) => inWin(i.openedAt)).length;
  const acked = real.filter((i) => inWin(i.acknowledgedAt));
  const resolved = real.filter((i) => inWin(i.resolvedAt));
  const mins = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 60_000);
  const mtta = median(acked.map((i) => mins(i.openedAt, i.acknowledgedAt!)));
  const mttr = median(resolved.map((i) => mins(i.openedAt, i.resolvedAt!)));
  return {
    opened,
    resolved: resolved.length,
    mttaMin: mtta === null ? null : Math.round(mtta),
    mttrMin: mttr === null ? null : Math.round(mttr),
    alerts,
    noiseRatio: opened ? Math.round((alerts / opened) * 10) / 10 : null,
  };
}

// ---------------------------------------------------------------------------------------------
// WAN & circuits
// ---------------------------------------------------------------------------------------------

export interface WanInterfaceIn {
  interfaceId: number;
  nodeId: number;
  name: string | null;
  caption: string | null;
  alias: string | null;
  statusNorm: string;
  inPercentUtil: number | null;
  outPercentUtil: number | null;
  inBps: number | null;
  outBps: number | null;
}

/** Interface names that mean "WAN" on most firewalls (FortiGate wan1, SD-WAN, ISP, MPLS, LTE). */
export const DEFAULT_WAN_PATTERN = 'wan|internet|isp|mpls|lte|uplink|virtual-wan';

/**
 * A firewall's WAN interfaces: those whose name, caption or alias matches the pattern; failing
 * that, its busiest interface, marked as a guess.
 */
export function pickWanInterfaces(
  ifaces: readonly WanInterfaceIn[],
  pattern: string,
): { picked: WanInterfaceIn[]; guessed: boolean } {
  let re: RegExp | null = null;
  try {
    re = pattern ? new RegExp(pattern, 'i') : null;
  } catch {
    re = null;
  }
  const matched = re
    ? ifaces.filter((i) => re.test([i.name, i.caption, i.alias].filter(Boolean).join(' ')))
    : [];
  if (matched.length) return { picked: matched, guessed: false };
  const busiest = [...ifaces]
    .filter((i) => (i.inBps ?? 0) + (i.outBps ?? 0) > 0)
    .sort((a, b) => (b.inBps ?? 0) + (b.outBps ?? 0) - ((a.inBps ?? 0) + (a.outBps ?? 0)))[0];
  return busiest ? { picked: [busiest], guessed: true } : { picked: [], guessed: false };
}

export type FirewallState = 'down' | 'unreachable' | 'warning' | 'up' | 'unknown' | 'none';

export interface WanSiteIn {
  siteId: number;
  siteCode: string;
  siteName: string;
  firewalls: Array<{
    nodeId: number;
    caption: string;
    statusNorm: string;
    responseTimeMs: number | null;
    percentLoss: number | null;
  }>;
  wan: WanInterfaceIn[];
  guessed: boolean;
  /** Hourly averages, oldest first (may contain nulls for missing hours). */
  latencySeries: Array<number | null>;
  lossSeries: Array<number | null>;
  /** Hourly max of in/out utilization across the WAN interfaces. */
  utilSeries: Array<number | null>;
}

export interface WanRow {
  siteId: number;
  siteCode: string;
  siteName: string;
  firewall: FirewallState;
  firewallCaption: string | null;
  latencyMs: number | null;
  lossPct: number | null;
  utilInPct: number | null;
  utilOutPct: number | null;
  wanName: string | null;
  guessed: boolean;
  latencySeries: Array<number | null>;
  lossSeries: Array<number | null>;
  utilSeries: Array<number | null>;
  /** Higher is worse; rows are sorted by it. */
  score: number;
}

const FW_RANK: Record<string, number> = {
  down: 5,
  critical: 5,
  shutdown: 5,
  unplugged: 5,
  unreachable: 4,
  warning: 3,
  up: 1,
};

function firewallState(statuses: readonly string[]): FirewallState {
  if (!statuses.length) return 'none';
  const worst = Math.max(...statuses.map((s) => FW_RANK[s] ?? 2));
  return worst >= 5
    ? 'down'
    : worst === 4
      ? 'unreachable'
      : worst === 3
        ? 'warning'
        : worst === 1
          ? 'up'
          : 'unknown';
}

const maxOf = (xs: Array<number | null | undefined>) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};

/** One row per site, worst first: a down firewall, then loss, saturation and latency. */
export function wanRows(sites: readonly WanSiteIn[]): WanRow[] {
  const rows = sites.map((s): WanRow => {
    const firewall = firewallState(s.firewalls.map((f) => f.statusNorm));
    const live = s.firewalls.filter((f) => f.statusNorm === 'up' || f.statusNorm === 'warning');
    const latencyMs = maxOf(live.map((f) => f.responseTimeMs));
    const lossPct =
      firewall === 'down' || firewall === 'unreachable'
        ? 100
        : maxOf(s.firewalls.map((f) => f.percentLoss));
    // A firewall that is down reports nothing: its last utilization figures are stale.
    const dark = firewall === 'down' || firewall === 'unreachable';
    const utilInPct = dark ? null : maxOf(s.wan.map((i) => i.inPercentUtil));
    const utilOutPct = dark ? null : maxOf(s.wan.map((i) => i.outPercentUtil));
    const util = Math.max(utilInPct ?? 0, utilOutPct ?? 0);
    const score =
      (firewall === 'down' ? 10_000 : firewall === 'unreachable' ? 9_000 : 0) +
      (firewall === 'warning' ? 2_000 : 0) +
      (lossPct ?? 0) * 20 +
      (util >= 90 ? 1_000 + util : util >= 75 ? 500 + util : util) +
      Math.min(latencyMs ?? 0, 1_000) / 5 +
      (firewall === 'none' ? -1 : 0);
    return {
      siteId: s.siteId,
      siteCode: s.siteCode,
      siteName: s.siteName,
      firewall,
      firewallCaption: s.firewalls[0]?.caption ?? null,
      latencyMs: latencyMs === null ? null : Math.round(latencyMs),
      lossPct: lossPct === null ? null : Math.round(lossPct * 10) / 10,
      utilInPct: utilInPct === null ? null : Math.round(utilInPct),
      utilOutPct: utilOutPct === null ? null : Math.round(utilOutPct),
      wanName: s.wan[0] ? (s.wan[0].caption ?? s.wan[0].name) : null,
      guessed: s.guessed,
      latencySeries: s.latencySeries,
      lossSeries: s.lossSeries,
      utilSeries: s.utilSeries,
      score,
    };
  });
  return rows.sort((a, b) => b.score - a.score || a.siteName.localeCompare(b.siteName));
}

// ---------------------------------------------------------------------------------------------
// Site matrix: one marker per kind of device
// ---------------------------------------------------------------------------------------------

export const MATRIX_ROLES = [
  'firewall',
  'router',
  'core_switch',
  'switch',
  'access_point',
  'server',
  'scale_system',
  'ups',
] as const;

export const ROLE_SHORT: Record<(typeof MATRIX_ROLES)[number], string> = {
  firewall: 'FW',
  router: 'RTR',
  core_switch: 'CORE',
  switch: 'SW',
  access_point: 'AP',
  server: 'SRV',
  scale_system: 'SCALE',
  ups: 'UPS',
};

const DOWN = new Set(['down', 'critical', 'unreachable', 'shutdown', 'unplugged']);

/** Per kind of device at a site: how many, how many down, and the worst state. */
export function roleLevels(
  nodes: ReadonlyArray<{ role: string; statusNorm: string; unmanaged: boolean }>,
): Array<{
  role: (typeof MATRIX_ROLES)[number];
  level: 'ok' | 'warn' | 'bad';
  down: number;
  total: number;
}> {
  return MATRIX_ROLES.flatMap((role) => {
    const list = nodes.filter((n) => n.role === role && !n.unmanaged);
    if (!list.length) return [];
    const down = list.filter((n) => DOWN.has(n.statusNorm)).length;
    const warn = list.filter((n) => n.statusNorm === 'warning').length;
    return [{ role, level: down ? 'bad' : warn ? 'warn' : 'ok', down, total: list.length }];
  });
}

// ---------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------

export type ActivityKind =
  'opened' | 'acked' | 'resolved' | 'reopened' | 'priority_changed' | 'paged' | 'escalated';

export interface ActivityIn {
  at: Date;
  kind: ActivityKind;
  incidentId: number | null;
  priority: string | null;
  title: string | null;
  site: string | null;
  /** The person acknowledging or being paged. */
  who: string | null;
}

export interface ActivityItem {
  at: Date;
  kind: ActivityKind;
  incidentId: number | null;
  text: string;
}

const ACTIVITY_KINDS: Record<string, ActivityKind> = {
  opened: 'opened',
  acked: 'acked',
  resolved: 'resolved',
  reopened: 'reopened',
  priority_changed: 'priority_changed',
};

/** Incident event types that belong in the activity feed (others are timeline detail). */
export function activityKindOf(eventType: string): ActivityKind | null {
  return ACTIVITY_KINDS[eventType] ?? null;
}

/** Newest first, at most `limit`, in short sentences. */
export function activityItems(rows: readonly ActivityIn[], limit: number): ActivityItem[] {
  const inc = (r: ActivityIn) => (r.incidentId !== null ? `INC-${r.incidentId}` : 'An incident');
  const what = (r: ActivityIn) =>
    [r.priority, r.title].filter(Boolean).join(' ') +
    (r.site && !r.title?.includes(r.site) ? ` · ${r.site}` : '');
  const text = (r: ActivityIn): string => {
    switch (r.kind) {
      case 'opened':
        return `${inc(r)} opened: ${what(r)}`;
      case 'reopened':
        return `${inc(r)} reopened: ${what(r)}`;
      case 'acked':
        return `${inc(r)} acknowledged${r.who ? ` by ${r.who}` : ''}`;
      case 'resolved':
        return `${inc(r)} resolved${r.title ? `: ${r.title}` : ''}`;
      case 'priority_changed':
        return `${inc(r)} is now ${r.priority ?? 'a new priority'}${r.title ? `: ${r.title}` : ''}`;
      case 'paged':
        return `${r.who ?? 'On-call'} paged for ${inc(r)}`;
      case 'escalated':
        return `${inc(r)} escalated${r.who ? ` to ${r.who}` : ''}`;
    }
  };
  return [...rows]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit)
    .map((r) => ({ at: r.at, kind: r.kind, incidentId: r.incidentId, text: text(r) }));
}
