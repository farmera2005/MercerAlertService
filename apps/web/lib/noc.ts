import 'server-only';
import {
  activeSeasons,
  activityItems,
  BUILTIN_BOARDS,
  BUILTIN_BOARD_KEYS,
  boardScope,
  customBoardId,
  customBoardRef,
  incidentInScope,
  incidentKpis,
  isBuiltinBoard,
  isMaintenanceActive,
  localDateTime,
  onCallAt,
  pickWanInterfaces,
  rotationWeekStart,
  roleLevels,
  ROLE_SHORT,
  stripAddresses,
  wanRows,
  type BoardDefinition,
  type MaintenanceWindow,
  type Person,
  type SeasonPeriod,
  type WanSiteIn,
  type WidgetType,
} from '@mercer/core';
import {
  flappingNodes,
  getNocBoard,
  interfaceHourly,
  listMaintenance,
  listNocBoards,
  listOncallWeeks,
  listOverrides,
  listPeople,
  listSeasons,
  nocActivity,
  nocAlertHourly,
  nocKpiIncidents,
  nocNotifySummary,
  nocWanSources,
  nodeHourly,
  topInterfaces,
} from '@mercer/db';
import type { NocBoardView, NocData, NocMode } from '@/components/noc/types';
import { getHealth } from './health';
import { mapConfig } from './map';
import { overviewModel } from './overview';
import { server } from './server';
import { effectiveConfig } from './settings';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Every board people can open: the built-in ones, then the custom ones by name. */
export async function listBoardViews(): Promise<NocBoardView[]> {
  const custom = await listNocBoards(server().db.db);
  return [
    ...BUILTIN_BOARD_KEYS.map((k) => ({
      ref: k,
      name: BUILTIN_BOARDS[k].name,
      definition: BUILTIN_BOARDS[k],
    })),
    ...custom.map((b) => ({ ref: customBoardRef(b.id), name: b.name, definition: b.definition })),
  ];
}

export async function boardView(ref: string): Promise<NocBoardView | null> {
  if (isBuiltinBoard(ref))
    return { ref, name: BUILTIN_BOARDS[ref].name, definition: BUILTIN_BOARDS[ref] };
  const id = customBoardId(ref);
  const row = id ? await getNocBoard(server().db.db, id) : null;
  return row ? { ref, name: row.name, definition: row.definition } : null;
}

/** Hourly buckets over the last 24 h, labelled "14:00" in the app's time zone, oldest first. */
function hourBuckets(now: number, tz: string): Array<{ start: number; label: string }> {
  const first = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  return Array.from({ length: 24 }, (_, i) => {
    const start = first + i * HOUR;
    return { start, label: localDateTime(new Date(start), tz).slice(11, 16) };
  });
}

/**
 * The data a board's widgets show, loaded only for the widgets on it and limited to its sites.
 * TV mode (wall links) gets titles, summaries and site names only: no addresses, no device names.
 */
export async function loadBoardData(
  def: BoardDefinition,
  mode: NocMode,
  opts: { kioskToken?: string } = {},
): Promise<NocData> {
  const { db } = server();
  const cfg = await effectiveConfig();
  const tz = cfg.timezone;
  const now = Date.now();
  const nowDate = new Date(now);
  const types = new Set<WidgetType>(def.widgets.map((w) => w.type));
  const has = (...t: WidgetType[]) => t.some((x) => types.has(x));
  const tv = mode === 'tv';
  const clean = (s: string) => (tv ? stripAddresses(s) : s);

  const model = await overviewModel(nowDate);
  const scope = boardScope(
    def.filters,
    model.tiles.map((t) => ({
      id: t.id,
      divisionCodes: t.divisionCodes,
      harvestCritical: t.harvestCritical,
    })),
  );
  const inScope = (siteId: number | null) => !scope || (siteId !== null && scope.has(siteId));
  const tiles = model.tiles.filter((t) => inScope(t.id));
  const siteIdByCode = new Map(model.tiles.map((t) => [t.code, t.id]));
  const open = model.openIncidents.filter(
    (i) => (!i.snoozedUntil || i.snoozedUntil.getTime() < now) && incidentInScope(i, scope),
  );
  const tileIncidents = new Map(model.tiles.flatMap((t) => t.incidents.map((x) => [x.id, x])));

  const data: NocData = {
    now,
    tz,
    status: { swis: 'unknown', alertsPolledAt: null, harvest: null, oncall: null, maintenance: 0 },
    counts: { P1: 0, P2: 0, P3: 0, P4: 0 },
    incidents: [],
    map: null,
    divisions: [],
    matrix: [],
    wan: [],
    kpis: null,
    chart: [],
    flapping: [],
    interfaces: [],
    notify: null,
    activity: [],
  };

  for (const i of open) data.counts[i.priority]++;

  if (has('incidents', 'ticker')) {
    data.incidents = open.map((i) => {
      const t = tileIncidents.get(i.id);
      return {
        id: i.id,
        priority: i.priority,
        title: clean(t?.title ?? i.title),
        summary: clean(t?.summary ?? i.templateSummary.slice(0, 180)),
        site: i.siteName,
        siteCode: model.tiles.find((x) => x.id === i.primarySiteId)?.code ?? null,
        openedAt: i.openedAt.getTime(),
        acknowledged: i.status === 'acknowledged',
        acknowledgedBy: tv ? null : i.acknowledgedBy,
        recoveryDueAt: i.openedAt.getTime() + i.recoveryTargetMin * 60_000,
        inMaintenance: i.inMaintenance,
      };
    });
  }

  if (has('status_bar')) {
    const [health, seasons, maint, peopleRows, overrides] = await Promise.all([
      getHealth(),
      listSeasons(db.db),
      listMaintenance(db.db, nowDate),
      listPeople(db.db),
      listOverrides(db.db, nowDate),
    ]);
    const { report } = health;
    const handoff = cfg.notify.handoff;
    const weeks = await listOncallWeeks(db.db, rotationWeekStart(nowDate, handoff, tz));
    const chain = onCallAt(nowDate, {
      people: peopleRows as Person[],
      weeks: weeks.map((w) => ({
        weekStart: w.weekStart,
        primaryPersonId: w.primaryPersonId,
        secondaryPersonId: w.secondaryPersonId,
      })),
      overrides,
      handoff,
      timezone: tz,
    });
    const harvest = activeSeasons(seasons as unknown as SeasonPeriod[], nowDate, tz).find(
      (s) => s.kind === 'harvest',
    );
    data.status = {
      swis: report.swis.status === 'up' ? 'up' : report.swis.status === 'down' ? 'down' : 'unknown',
      alertsPolledAt: report.swis.lastAlertPollSuccessAt,
      harvest: harvest?.name ?? null,
      oncall:
        chain.primary || chain.secondary
          ? { primary: chain.primary?.name ?? null, secondary: chain.secondary?.name ?? null }
          : null,
      maintenance: (maint as unknown as MaintenanceWindow[]).filter((w) =>
        isMaintenanceActive(w, nowDate, tz),
      ).length,
    };
  }

  if (has('map')) {
    const map = await mapConfig(cfg, opts.kioskToken);
    data.map = {
      config: {
        mode: map.mode,
        tileUrl: map.tileUrl,
        attribution: map.attribution,
        image: map.image,
      },
      sites: tiles.map((t) => ({
        code: t.code,
        name: t.name,
        level: t.health.level,
        reason: clean(t.health.reason),
        lat: t.lat,
        lon: t.lon,
        mapX: t.mapX,
        mapY: t.mapY,
      })),
    };
  }

  if (has('division_health', 'site_matrix')) {
    const nodesBySite = new Map<
      number,
      Array<{ role: string; statusNorm: string; unmanaged: boolean }>
    >();
    if (has('site_matrix'))
      for (const n of model.nodes) {
        if (n.siteId === null) continue;
        const l = nodesBySite.get(n.siteId) ?? [];
        l.push(n);
        nodesBySite.set(n.siteId, l);
      }
    for (const g of model.groups) {
      const sites = g.sites.filter((s) => inScope(s.id));
      if (!sites.length) continue;
      const notOk = sites.filter((s) => s.health.level === 'bad' || s.health.level === 'warn');
      const worst =
        sites.find((s) => s.health.level === 'bad') ?? sites.find((s) => s.health.level === 'warn');
      data.divisions.push({
        code: g.code,
        name: g.name,
        level: g.sites.some((s) => inScope(s.id))
          ? worstOf(sites.map((s) => s.health.level))
          : 'unknown',
        sites: sites.length,
        notOk: notOk.length,
        worst: worst?.name ?? null,
      });
      if (has('site_matrix'))
        data.matrix.push({
          name: g.name,
          isAffiliate: g.isAffiliate,
          level: worstOf(sites.map((s) => s.health.level)),
          sites: sites.map((s) => ({
            id: s.id,
            code: s.code,
            name: s.name,
            level: s.health.level,
            reason: clean(s.health.reason),
            harvestCritical: s.harvestCritical,
            roles: roleLevels(nodesBySite.get(s.id) ?? []).map((r) => ({
              ...r,
              short: ROLE_SHORT[r.role],
            })),
          })),
        });
    }
  }

  if (has('wan')) {
    const since = new Date(now - DAY);
    const src = await nocWanSources(db.db);
    const fws = src.firewalls.filter((f) => inScope(f.siteId));
    const ifacesByNode = new Map<number, typeof src.interfaces>();
    for (const i of src.interfaces) {
      const l = ifacesByNode.get(i.nodeId) ?? [];
      l.push(i);
      ifacesByNode.set(i.nodeId, l);
    }
    const bySite = new Map<number, typeof fws>();
    for (const f of fws) {
      const l = bySite.get(f.siteId) ?? [];
      l.push(f);
      bySite.set(f.siteId, l);
    }
    const picks = new Map<number, { picked: typeof src.interfaces; guessed: boolean }>();
    for (const [siteId, list] of bySite) {
      const all = list.flatMap((f) => ifacesByNode.get(f.nodeId) ?? []);
      picks.set(siteId, pickWanInterfaces(all, cfg.noc.wanPattern));
    }
    const [nodeSeries, ifSeries] = await Promise.all([
      nodeHourly(
        db.db,
        fws.map((f) => f.nodeId),
        since,
      ),
      interfaceHourly(
        db.db,
        [...picks.values()].flatMap((p) => p.picked.map((i) => i.interfaceId)),
        since,
      ),
    ]);
    const buckets = hourBuckets(now, tz);
    const series = <T extends { hour: Date }>(rows: T[], pick: (r: T) => number | null) =>
      buckets.map((b) => {
        const vals = rows
          .filter((r) => r.hour.getTime() === b.start)
          .map(pick)
          .filter((v): v is number => v !== null);
        return vals.length ? Math.max(...vals) : null;
      });
    const sites: WanSiteIn[] = [];
    for (const t of tiles) {
      const list = bySite.get(t.id);
      if (!list?.length) continue;
      const p = picks.get(t.id)!;
      const ids = new Set(list.map((f) => f.nodeId));
      const ifIds = new Set(p.picked.map((i) => i.interfaceId));
      sites.push({
        siteId: t.id,
        siteCode: t.code,
        siteName: t.name,
        firewalls: list.map((f) => ({ ...f, caption: tv ? 'firewall' : f.caption })),
        wan: p.picked,
        guessed: p.guessed,
        latencySeries: series(
          nodeSeries.filter((r) => ids.has(r.nodeId)),
          (r) => r.rt,
        ),
        lossSeries: series(
          nodeSeries.filter((r) => ids.has(r.nodeId)),
          (r) => r.loss,
        ),
        utilSeries: series(
          ifSeries.filter((r) => ifIds.has(r.interfaceId)),
          (r) => r.util,
        ),
      });
    }
    data.wan = wanRows(sites).map((r) => (tv ? { ...r, firewallCaption: null } : r));
  }

  if (has('kpis', 'alerts_chart')) {
    const since = new Date(now - DAY);
    const siteList = scope ? [...scope] : null;
    const [kpiRows, alertRows] = await Promise.all([
      nocKpiIncidents(db.db, since),
      nocAlertHourly(db.db, new Date(Math.floor(now / HOUR) * HOUR - 23 * HOUR), siteList),
    ]);
    const scoped = kpiRows.filter((i) => incidentInScope(i, scope));
    const alerts24 = alertRows
      .filter((r) => r.hour.getTime() >= now - DAY)
      .reduce((a, r) => a + r.n, 0);
    data.kpis = incidentKpis(scoped, alerts24, since, nowDate);
    if (has('alerts_chart'))
      data.chart = hourBuckets(now, tz).map((b) => ({
        label: b.label,
        alerts: alertRows.find((r) => r.hour.getTime() === b.start)?.n ?? 0,
        incidents: scoped.filter(
          (i) =>
            !i.seeded && i.openedAt.getTime() >= b.start && i.openedAt.getTime() < b.start + HOUR,
        ).length,
      }));
  }

  const siteOk = (code: string | null) =>
    !scope || (code !== null && scope.has(siteIdByCode.get(code) ?? -1));

  if (has('flapping')) {
    const rows = await flappingNodes(db.db, {
      start: new Date(now - DAY),
      end: nowDate,
      min: 3,
      limit: 30,
    });
    data.flapping = rows
      .filter((r) => siteOk(r.siteCode))
      .slice(0, 10)
      .map((r) => ({
        key: `n${r.nodeId}`,
        label: tv ? `${r.site ?? 'Unmapped'} · ${r.role.replace(/_/g, ' ')}` : r.node,
        site: r.site,
        siteCode: r.siteCode,
        nodeId: tv ? null : r.nodeId,
        changes: r.changes,
      }));
  }

  if (has('top_interfaces')) {
    const rows = await topInterfaces(db.db, {
      start: new Date(now - HOUR),
      end: nowDate,
      limit: 30,
    });
    data.interfaces = rows
      .filter((r) => siteOk(r.siteCode))
      .slice(0, 10)
      .map((r) => ({
        key: `i${r.interfaceId}`,
        label: tv ? `${r.site ?? 'Unmapped'} · ${r.iface}` : `${r.node} ${r.iface}`,
        site: r.site,
        siteCode: r.siteCode,
        interfaceId: tv ? null : r.interfaceId,
        util: r.avg,
      }));
  }

  if (has('notify_summary')) {
    const s = await nocNotifySummary(db.db, new Date(now - DAY));
    const held = Object.entries(s.suppressed).sort((a, b) => b[1] - a[1]);
    data.notify = {
      pages: s.pages,
      escalations: s.escalations,
      suppressed: held.reduce((a, [, n]) => a + n, 0),
      suppressedTop: held[0]?.[0] ?? null,
    };
  }

  if (has('ticker')) {
    const rows = await nocActivity(db.db, new Date(now - DAY), 80);
    const scoped = rows.filter((r) => !scope || r.siteIds.some((id) => scope.has(id)));
    data.activity = activityItems(scoped, 20).map((a) => ({
      at: a.at.getTime(),
      text: clean(a.text),
      incidentId: a.incidentId,
      kind: a.kind,
    }));
  }

  return data;
}

function worstOf(levels: string[]): NocData['divisions'][number]['level'] {
  for (const l of ['bad', 'warn', 'maintenance', 'ok'] as const) if (levels.includes(l)) return l;
  return 'unknown';
}
