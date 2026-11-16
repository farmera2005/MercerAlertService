import 'server-only';
import {
  displayTitle,
  maintenanceFor,
  shortSummary,
  siteHealth,
  worstLevel,
  type DeviceRole,
  type HealthLevel,
  type MaintenanceWindow,
  type Priority,
  type SiteHealth,
  type StatusNorm,
} from '@mercer/core';
import { listMaintenance, loadOverview, type OverviewIncident } from '@mercer/db';
import { server } from './server';
import { effectiveConfig } from './settings';

export interface SiteTile {
  id: number;
  code: string;
  name: string;
  city: string | null;
  divisionCode: string | null;
  divisionName: string;
  tier: string;
  harvestCritical: boolean;
  lat: number | null;
  lon: number | null;
  mapX: number | null;
  mapY: number | null;
  health: SiteHealth;
  incidents: Array<{ id: number; priority: Priority; title: string; summary: string }>;
}

export interface DivisionGroup {
  code: string | null;
  name: string;
  isAffiliate: boolean;
  level: HealthLevel;
  sites: SiteTile[];
}

export interface OverviewModel {
  groups: DivisionGroup[];
  tiles: SiteTile[];
  openIncidents: OverviewIncident[];
  counts: Record<Priority, number>;
  unmappedNodes: number;
}

/**
 * Site tiles for the overview, the sites list and the wall: every Site Profile with its health,
 * grouped by division (affiliates last). Sites without monitored devices are dropped unless they
 * have an open incident, so placeholders do not clutter the wall.
 */
export async function overviewModel(now = new Date()): Promise<OverviewModel> {
  const { db } = server();
  const cfg = await effectiveConfig();
  const [data, maint] = await Promise.all([loadOverview(db.db), listMaintenance(db.db)]);
  const windows = maint as unknown as MaintenanceWindow[];

  const nodesBySite = new Map<number, typeof data.nodes>();
  let unmappedNodes = 0;
  for (const n of data.nodes) {
    if (n.siteId === null) {
      if (!n.unmanaged) unmappedNodes++;
      continue;
    }
    const list = nodesBySite.get(n.siteId) ?? [];
    list.push(n);
    nodesBySite.set(n.siteId, list);
  }

  const tiles: Array<SiteTile & { affiliate: boolean; sort: number }> = [];
  for (const s of data.sites) {
    const nodes = nodesBySite.get(s.id) ?? [];
    const incidents = data.openIncidents.filter(
      (i) => i.primarySiteId === s.id || i.affectedSiteIds.includes(s.id),
    );
    if (nodes.length === 0 && incidents.length === 0) continue;
    const health = siteHealth(
      nodes.map((n) => ({
        statusNorm: n.statusNorm as StatusNorm,
        role: n.role as DeviceRole,
        unmanaged: n.unmanaged,
      })),
      incidents,
      {
        inMaintenance: !!maintenanceFor(windows, { nodeId: null, siteId: s.id }, now, cfg.timezone),
      },
    );
    tiles.push({
      id: s.id,
      code: s.code,
      name: s.name,
      city: s.city,
      divisionCode: s.divisionCode,
      divisionName: s.divisionName ?? 'No division',
      tier: s.tier,
      harvestCritical: s.harvestCritical,
      lat: s.lat,
      lon: s.lon,
      mapX: s.mapX,
      mapY: s.mapY,
      health,
      incidents: incidents.map((i) => ({
        id: i.id,
        priority: i.priority,
        title: displayTitle(i),
        summary: shortSummary(i),
      })),
      affiliate: s.isAffiliate,
      sort: s.divisionSort,
    });
  }

  const groups = new Map<string, DivisionGroup & { sort: number }>();
  for (const t of tiles) {
    const key = t.divisionCode ?? '';
    const g = groups.get(key) ?? {
      code: t.divisionCode,
      name: t.divisionName,
      isAffiliate: t.affiliate,
      level: 'unknown' as HealthLevel,
      sites: [],
      sort: t.sort,
    };
    g.sites.push(t);
    groups.set(key, g);
  }
  const ordered = [...groups.values()]
    .map((g) => ({ ...g, level: worstLevel(g.sites.map((s) => s.health.level)) }))
    .sort((a, b) => Number(a.isAffiliate) - Number(b.isAffiliate) || a.sort - b.sort);

  const counts: Record<Priority, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
  for (const i of data.openIncidents) counts[i.priority]++;
  return {
    groups: ordered.map(({ sort: _s, ...g }) => g),
    tiles,
    openIncidents: data.openIncidents,
    counts,
    unmappedNodes,
  };
}
