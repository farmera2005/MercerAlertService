/** What a NOC board receives from the server: plain, serializable data (no server imports). */
import type { BoardDefinition, Kpis, WanRow } from '@mercer/core/noc';
import type { MapConfig, MapSite } from '../site-map';
import type { Level } from '../status';

/** TV: wall links (large text, no links, no device names). Desktop: the signed-in /noc page. */
export type NocMode = 'tv' | 'desktop';

export interface NocIncident {
  id: number;
  priority: string;
  title: string;
  summary: string;
  site: string | null;
  siteCode: string | null;
  openedAt: number;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  /** When the recovery target passes. */
  recoveryDueAt: number;
  inMaintenance: boolean;
}

export interface NocDivision {
  code: string | null;
  name: string;
  level: Level;
  sites: number;
  notOk: number;
  /** The worst site, when not all are OK. */
  worst: string | null;
}

export interface NocMatrixSite {
  id: number;
  code: string;
  name: string;
  level: Level;
  reason: string;
  harvestCritical: boolean;
  roles: Array<{
    role: string;
    short: string;
    level: 'ok' | 'warn' | 'bad';
    down: number;
    total: number;
  }>;
}

export interface NocMatrixGroup {
  name: string;
  isAffiliate: boolean;
  level: Level;
  sites: NocMatrixSite[];
}

export interface NocData {
  now: number;
  tz: string;
  status: {
    swis: 'up' | 'down' | 'unknown';
    alertsPolledAt: string | null;
    /** Name of the active harvest season, if any. */
    harvest: string | null;
    oncall: { primary: string | null; secondary: string | null } | null;
    maintenance: number;
  };
  counts: Record<'P1' | 'P2' | 'P3' | 'P4', number>;
  incidents: NocIncident[];
  map: { config: MapConfig; sites: MapSite[] } | null;
  divisions: NocDivision[];
  matrix: NocMatrixGroup[];
  wan: WanRow[];
  kpis: Kpis | null;
  /** Hourly, oldest first, labelled in APP_TIMEZONE. */
  chart: Array<{ label: string; alerts: number; incidents: number }>;
  flapping: Array<{
    key: string;
    label: string;
    site: string | null;
    siteCode: string | null;
    nodeId: number | null;
    changes: number;
  }>;
  interfaces: Array<{
    key: string;
    label: string;
    site: string | null;
    siteCode: string | null;
    interfaceId: number | null;
    util: number;
  }>;
  notify: {
    pages: number;
    escalations: number;
    suppressed: number;
    suppressedTop: string | null;
  } | null;
  activity: Array<{ at: number; text: string; incidentId: number | null; kind: string }>;
}

export interface NocBoardView {
  ref: string;
  name: string;
  definition: BoardDefinition;
}
