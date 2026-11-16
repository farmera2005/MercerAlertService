/**
 * Site tile colour for the overview and the wall. Deterministic and explainable: the reason is
 * shown under the tile, so "why is Rockford red?" is answered on the screen.
 */
import type { DeviceRole } from '../mapping';
import { isDownLike, type StatusNorm } from '../orion';
import type { IncidentKind, IncidentStatus, Priority } from '../correlation/types';

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'maintenance' | 'unknown';

export interface SiteHealthNode {
  statusNorm: StatusNorm;
  role: DeviceRole;
  unmanaged: boolean;
}

export interface SiteHealthIncident {
  priority: Priority;
  kind: IncidentKind;
  status: IncidentStatus;
  inMaintenance: boolean;
  title: string;
}

export interface SiteHealth {
  level: HealthLevel;
  reason: string;
  nodesTotal: number;
  nodesDown: number;
  nodesWarning: number;
  openIncidents: number;
  worstPriority: Priority | null;
}

const OPEN: ReadonlySet<IncidentStatus> = new Set(['open', 'acknowledged']);
const PRIORITY_RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function siteHealth(
  nodes: readonly SiteHealthNode[],
  incidents: readonly SiteHealthIncident[],
  opts: { inMaintenance?: boolean } = {},
): SiteHealth {
  const managed = nodes.filter((n) => !n.unmanaged && n.statusNorm !== 'unmanaged');
  const down = managed.filter((n) => isDownLike(n.statusNorm));
  const warning = managed.filter((n) => n.statusNorm === 'warning');
  const open = incidents.filter((i) => OPEN.has(i.status));
  const live = open
    .filter((i) => !i.inMaintenance)
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const worst = live[0] ?? null;
  const base = {
    nodesTotal: managed.length,
    nodesDown: down.length,
    nodesWarning: warning.length,
    openIncidents: open.length,
    worstPriority: worst?.priority ?? null,
  };

  if (managed.length === 0 && open.length === 0)
    return { ...base, level: 'unknown', reason: 'No monitored devices' };

  const firewallDown = down.some((n) => n.role === 'firewall');
  const allDown = managed.length > 0 && down.length === managed.length;
  const outage = live.find((i) => i.kind === 'site_outage');
  if (outage) return { ...base, level: 'bad', reason: `${outage.priority} · ${outage.title}` };
  if (worst && (worst.priority === 'P1' || worst.priority === 'P2'))
    return { ...base, level: 'bad', reason: `${worst.priority} · ${worst.title}` };
  // Before correlation has caught up, the raw status still tells the truth.
  if (!opts.inMaintenance && allDown)
    return { ...base, level: 'bad', reason: 'Every device is down or unreachable' };
  if (!opts.inMaintenance && firewallDown)
    return { ...base, level: 'bad', reason: 'WAN edge firewall down' };

  if (worst) return { ...base, level: 'warn', reason: `${worst.priority} · ${worst.title}` };
  if (opts.inMaintenance || open.length > 0)
    return {
      ...base,
      level: 'maintenance',
      reason: open.length
        ? `In maintenance · ${plural(open.length, 'open incident')}`
        : 'In maintenance',
    };
  if (down.length > 0)
    return { ...base, level: 'warn', reason: `${plural(down.length, 'device')} down` };
  if (warning.length > 0)
    return { ...base, level: 'warn', reason: `${plural(warning.length, 'device')} in warning` };
  return { ...base, level: 'ok', reason: `All ${plural(managed.length, 'device')} up` };
}

/** Overall roll-up for a division or the whole estate: the worst level wins. */
export function worstLevel(levels: readonly HealthLevel[]): HealthLevel {
  const order: HealthLevel[] = ['bad', 'warn', 'maintenance', 'ok', 'unknown'];
  for (const l of order) if (levels.includes(l)) return l;
  return 'unknown';
}
