import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BOARDS,
  BUILTIN_BOARD_KEYS,
  boardDefinitionSchema,
  boardRefSchema,
  customBoardId,
  freeSpot,
  layoutProblems,
  type BoardWidget,
} from './board';
import {
  activityItems,
  boardScope,
  DEFAULT_WAN_PATTERN,
  durationText,
  incidentInScope,
  incidentKpis,
  pickWanInterfaces,
  recoveryLeftMs,
  wanRows,
  type WanInterfaceIn,
  type WanSiteIn,
} from './compute';

const w = (type: BoardWidget['type'], col: number, row: number, cw: number, h: number) =>
  ({ type, col, row, w: cw, h }) as BoardWidget;

describe('boards', () => {
  it('ships four valid built-in boards with no layout problems', () => {
    expect(BUILTIN_BOARD_KEYS).toEqual(['mission', 'matrix', 'wan', 'shift']);
    for (const b of Object.values(BUILTIN_BOARDS)) {
      expect(boardDefinitionSchema.safeParse(b).success, b.key).toBe(true);
      expect(layoutProblems(b.widgets), b.key).toEqual([]);
    }
  });

  it('reports widgets off the grid, overlapping or too small', () => {
    const problems = layoutProblems([
      w('map', 8, 1, 6, 3),
      w('incidents', 1, 7, 3, 3),
      w('kpis', 9, 2, 3, 1),
      w('wan', 1, 1, 2, 2),
    ]);
    expect(problems).toEqual([
      'Map (#1) runs past the right edge (columns 8–13 of 12).',
      'Open incidents (#2) runs past the bottom (rows 7–9 of 8).',
      'Key figures (#3) overlaps Map (#1).',
      'WAN & circuits (#4) needs at least 6 columns × 2 rows.',
    ]);
  });

  it('finds a free spot for a new widget', () => {
    const board = [w('status_bar', 1, 1, 12, 1), w('map', 1, 2, 6, 7)];
    expect(freeSpot(board, 6, 2)).toEqual({ col: 7, row: 2 });
    expect(freeSpot([w('wan', 1, 1, 12, 8)], 1, 1)).toBeNull();
  });

  it('names boards by key or custom id', () => {
    expect(boardRefSchema.safeParse('mission').success).toBe(true);
    expect(boardRefSchema.safeParse('custom:12').success).toBe(true);
    expect(boardRefSchema.safeParse('custom:0').success).toBe(false);
    expect(boardRefSchema.safeParse('../etc').success).toBe(false);
    expect(customBoardId('custom:12')).toBe(12);
    expect(customBoardId('mission')).toBeNull();
  });
});

describe('scope', () => {
  const sites = [
    { id: 1, divisionCodes: ['grain'], harvestCritical: true },
    { id: 2, divisionCodes: ['grain', 'agronomy'], harvestCritical: false },
    { id: 3, divisionCodes: ['feed'], harvestCritical: false },
  ];
  const none = { divisions: [], harvestCriticalOnly: false, siteIds: [] };
  it('limits a board to divisions, harvest-critical sites or listed sites', () => {
    expect(boardScope(none, sites)).toBeNull();
    expect([...boardScope({ ...none, divisions: ['agronomy'] }, sites)!]).toEqual([2]);
    expect([
      ...boardScope({ ...none, divisions: ['grain'], harvestCriticalOnly: true }, sites)!,
    ]).toEqual([1]);
    expect([...boardScope({ ...none, siteIds: [3] }, sites)!]).toEqual([3]);
  });
  it('keeps incidents that touch a site in scope', () => {
    const scope = new Set([2]);
    expect(incidentInScope({ primarySiteId: 2, affectedSiteIds: [] }, scope)).toBe(true);
    expect(incidentInScope({ primarySiteId: 9, affectedSiteIds: [2] }, scope)).toBe(true);
    expect(incidentInScope({ primarySiteId: null, affectedSiteIds: [] }, scope)).toBe(false);
    expect(incidentInScope({ primarySiteId: null, affectedSiteIds: [] }, null)).toBe(true);
  });
});

describe('time', () => {
  it('counts down to the recovery target', () => {
    const openedAt = new Date('2026-11-23T10:00:00Z');
    expect(
      recoveryLeftMs({ openedAt, recoveryTargetMin: 240 }, new Date('2026-11-23T10:14:00Z')),
    ).toBe(226 * 60_000);
    expect(
      recoveryLeftMs({ openedAt, recoveryTargetMin: 60 }, new Date('2026-11-23T11:30:00Z')),
    ).toBe(-30 * 60_000);
  });
  it('writes durations', () => {
    expect(durationText(14 * 60_000)).toBe('14 min');
    expect(durationText(-226 * 60_000)).toBe('3 h 46 min');
    expect(durationText(120 * 60_000)).toBe('2 h');
    expect(durationText(53 * 3600_000)).toBe('2 d 5 h');
  });
});

describe('incidentKpis', () => {
  const from = new Date('2026-11-22T12:00:00Z');
  const to = new Date('2026-11-23T12:00:00Z');
  const t = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 23, h, m));
  it('counts incidents and takes medians in the window', () => {
    const k = incidentKpis(
      [
        { openedAt: t(1), acknowledgedAt: t(1, 4), resolvedAt: t(2), seeded: false },
        { openedAt: t(3), acknowledgedAt: t(3, 10), resolvedAt: t(3, 30), seeded: false },
        { openedAt: t(5), acknowledgedAt: t(5, 6), resolvedAt: null, seeded: false },
        { openedAt: t(6), acknowledgedAt: null, resolvedAt: null, seeded: true },
        // Opened before the window, fixed in it: counts for time to fix only.
        {
          openedAt: new Date('2026-11-22T10:00:00Z'),
          acknowledgedAt: null,
          resolvedAt: t(0),
          seeded: false,
        },
      ],
      124,
      from,
      to,
    );
    expect(k).toEqual({
      opened: 3,
      resolved: 3,
      mttaMin: 6,
      mttrMin: 60,
      alerts: 124,
      noiseRatio: 41.3,
    });
  });
  it('has no ratio or medians without incidents', () => {
    expect(incidentKpis([], 7, from, to)).toMatchObject({
      noiseRatio: null,
      mttaMin: null,
      mttrMin: null,
    });
  });
});

describe('WAN', () => {
  const iface = (o: Partial<WanInterfaceIn>): WanInterfaceIn => ({
    interfaceId: 1,
    nodeId: 1,
    name: null,
    caption: null,
    alias: null,
    statusNorm: 'up',
    inPercentUtil: null,
    outPercentUtil: null,
    inBps: null,
    outBps: null,
    ...o,
  });
  it('picks WAN interfaces by name, else the busiest as a guess', () => {
    const wan1 = iface({ interfaceId: 1, name: 'wan1' });
    const port3 = iface({ interfaceId: 2, name: 'port3', alias: 'Spectrum ISP' });
    const lan = iface({ interfaceId: 3, name: 'internal', inBps: 9e6, outBps: 1e6 });
    expect(pickWanInterfaces([wan1, port3, lan], DEFAULT_WAN_PATTERN)).toEqual({
      picked: [wan1, port3],
      guessed: false,
    });
    expect(
      pickWanInterfaces([lan, iface({ interfaceId: 4, name: 'dmz' })], DEFAULT_WAN_PATTERN),
    ).toEqual({
      picked: [lan],
      guessed: true,
    });
    expect(pickWanInterfaces([iface({ name: 'x' })], '([bad')).toEqual({
      picked: [],
      guessed: false,
    });
  });

  it('puts a down firewall first, then loss and saturation', () => {
    const site = (id: number, o: Partial<WanSiteIn>): WanSiteIn => ({
      siteId: id,
      siteCode: `s${id}`,
      siteName: `Site ${id}`,
      firewalls: [
        {
          nodeId: id,
          caption: `S${id}-FW01`,
          statusNorm: 'up',
          responseTimeMs: 12,
          percentLoss: 0,
        },
      ],
      wan: [iface({ inPercentUtil: 20, outPercentUtil: 5, name: 'wan1' })],
      guessed: false,
      latencySeries: [],
      lossSeries: [],
      utilSeries: [],
      ...o,
    });
    const rows = wanRows([
      site(1, {}),
      site(2, { wan: [iface({ inPercentUtil: 94, outPercentUtil: 40, name: 'wan1' })] }),
      site(3, {
        firewalls: [
          {
            nodeId: 3,
            caption: 'S3-FW01',
            statusNorm: 'down',
            responseTimeMs: null,
            percentLoss: 100,
          },
        ],
      }),
      site(4, {
        firewalls: [
          { nodeId: 4, caption: 'S4-FW01', statusNorm: 'up', responseTimeMs: 48, percentLoss: 6 },
        ],
      }),
      site(5, { firewalls: [], wan: [] }),
    ]);
    expect(rows.map((r) => r.siteId)).toEqual([3, 2, 4, 1, 5]);
    expect(rows[0]).toMatchObject({
      firewall: 'down',
      lossPct: 100,
      latencyMs: null,
      utilInPct: null,
      utilOutPct: null,
    });
    expect(rows[1]).toMatchObject({ utilInPct: 94, utilOutPct: 40, wanName: 'wan1' });
    expect(rows[4]).toMatchObject({ firewall: 'none' });
  });
});

describe('activityItems', () => {
  it('writes the newest events first', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 23, 10, m));
    const items = activityItems(
      [
        {
          at: at(38),
          kind: 'opened',
          incidentId: 212,
          priority: 'P1',
          title: 'Site down — Rockford Elevator',
          site: 'Rockford Elevator',
          who: null,
        },
        {
          at: at(41),
          kind: 'paged',
          incidentId: 212,
          priority: null,
          title: null,
          site: null,
          who: 'J. Smith',
        },
        {
          at: at(44),
          kind: 'acked',
          incidentId: 212,
          priority: null,
          title: null,
          site: null,
          who: 'J. Smith',
        },
        {
          at: at(1),
          kind: 'resolved',
          incidentId: 200,
          priority: null,
          title: 'AP down — Celina HQ',
          site: null,
          who: null,
        },
      ],
      3,
    );
    expect(items.map((i) => i.text)).toEqual([
      'INC-212 acknowledged by J. Smith',
      'J. Smith paged for INC-212',
      'INC-212 opened: P1 Site down — Rockford Elevator',
    ]);
  });
});
