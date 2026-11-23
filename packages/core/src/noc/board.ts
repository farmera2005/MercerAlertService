/**
 * NOC boards: a 12 × 8 grid of widgets shown on the NOC TVs (wall links) and on the /noc page.
 * Four boards are built in; admins compose their own in Settings → NOC boards. Browser-safe
 * (zod only): the board builder imports it as `@mercer/core/noc`.
 */
import { z } from 'zod';

export const BOARD_COLS = 12;
export const BOARD_ROWS = 8;

export const WIDGET_TYPES = [
  'status_bar',
  'priority_counts',
  'incidents',
  'map',
  'division_health',
  'ticker',
  'site_matrix',
  'wan',
  'kpis',
  'alerts_chart',
  'flapping',
  'top_interfaces',
  'notify_summary',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export interface WidgetInfo {
  label: string;
  description: string;
  /** Size when added in the builder. */
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export const WIDGETS: Record<WidgetType, WidgetInfo> = {
  status_bar: {
    label: 'Status bar',
    description: 'Clock, SolarWinds feed, harvest season, who is on call, live indicator.',
    w: 12,
    h: 1,
    minW: 6,
    minH: 1,
  },
  priority_counts: {
    label: 'Priority counts',
    description: 'Open incidents by priority, P1 to P4.',
    w: 3,
    h: 1,
    minW: 2,
    minH: 1,
  },
  incidents: {
    label: 'Open incidents',
    description:
      'Worst first, with site, age, acknowledgement and time left to the recovery target.',
    w: 4,
    h: 5,
    minW: 3,
    minH: 1,
  },
  map: {
    label: 'Map',
    description: 'Sites coloured by health; problem sites are labelled.',
    w: 6,
    h: 5,
    minW: 3,
    minH: 3,
  },
  division_health: {
    label: 'Division health',
    description: 'One row per division: its worst site and how many sites are not OK.',
    w: 3,
    h: 4,
    minW: 2,
    minH: 2,
  },
  ticker: {
    label: 'Activity',
    description: 'What just happened: incidents opened, acknowledged, resolved, people paged.',
    w: 12,
    h: 1,
    minW: 4,
    minH: 1,
  },
  site_matrix: {
    label: 'Site matrix',
    description: 'Every site as a tile by division, with markers for each kind of device.',
    w: 12,
    h: 6,
    minW: 4,
    minH: 2,
  },
  wan: {
    label: 'WAN & circuits',
    description: 'Per site, worst first: firewall, latency, packet loss and WAN utilization.',
    w: 12,
    h: 6,
    minW: 6,
    minH: 2,
  },
  kpis: {
    label: 'Key figures',
    description:
      'Noise ratio, incidents opened and resolved, median time to acknowledge and to fix.',
    w: 12,
    h: 2,
    minW: 3,
    minH: 1,
  },
  alerts_chart: {
    label: 'Alerts vs incidents',
    description: 'Raw alerts and incidents per hour.',
    w: 12,
    h: 2,
    minW: 4,
    minH: 2,
  },
  flapping: {
    label: 'Flapping devices',
    description: 'Devices that changed state most often.',
    w: 6,
    h: 2,
    minW: 3,
    minH: 2,
  },
  top_interfaces: {
    label: 'Busiest interfaces',
    description: 'Highest utilization right now.',
    w: 6,
    h: 2,
    minW: 3,
    minH: 2,
  },
  notify_summary: {
    label: 'Notifications',
    description: 'People paged, escalations, messages held back by maintenance or quiet hours.',
    w: 12,
    h: 1,
    minW: 3,
    minH: 1,
  },
};

const placement = {
  col: z.number().int().min(1).max(BOARD_COLS),
  row: z.number().int().min(1).max(BOARD_ROWS),
  w: z.number().int().min(1).max(BOARD_COLS),
  h: z.number().int().min(1).max(BOARD_ROWS),
};

export const widgetSchema = z.object({
  type: z.enum(WIDGET_TYPES),
  ...placement,
  /** Replaces the widget's own heading. */
  title: z.string().trim().max(60).optional(),
});
export type BoardWidget = z.infer<typeof widgetSchema>;

export const boardFiltersSchema = z.object({
  /** Sites with any of these divisions (empty: all). */
  divisions: z.array(z.string().max(40)).max(20).default([]),
  harvestCriticalOnly: z.boolean().default(false),
  /** Only these sites (empty: all). */
  siteIds: z.array(z.number().int().positive()).max(500).default([]),
});
export type BoardFilters = z.infer<typeof boardFiltersSchema>;

export const boardDefinitionSchema = z.object({
  widgets: z.array(widgetSchema).min(1).max(16),
  filters: boardFiltersSchema.default({ divisions: [], harvestCriticalOnly: false, siteIds: [] }),
});
export type BoardDefinition = z.infer<typeof boardDefinitionSchema>;

export const NO_FILTERS: BoardFilters = { divisions: [], harvestCriticalOnly: false, siteIds: [] };

export function hasFilters(f: BoardFilters): boolean {
  return f.divisions.length > 0 || f.harvestCriticalOnly || f.siteIds.length > 0;
}

/** Layout problems, in words: off the grid, overlapping, or smaller than the widget allows. */
export function layoutProblems(widgets: readonly BoardWidget[]): string[] {
  const out: string[] = [];
  const cells = new Map<string, number>();
  widgets.forEach((w, i) => {
    const name = `${WIDGETS[w.type].label} (#${i + 1})`;
    const info = WIDGETS[w.type];
    if (w.col + w.w - 1 > BOARD_COLS)
      out.push(`${name} runs past the right edge (columns ${w.col}–${w.col + w.w - 1} of 12).`);
    if (w.row + w.h - 1 > BOARD_ROWS)
      out.push(`${name} runs past the bottom (rows ${w.row}–${w.row + w.h - 1} of 8).`);
    if (w.w < info.minW || w.h < info.minH)
      out.push(`${name} needs at least ${info.minW} columns × ${info.minH} rows.`);
    for (let r = w.row; r < Math.min(w.row + w.h, BOARD_ROWS + 1); r++)
      for (let c = w.col; c < Math.min(w.col + w.w, BOARD_COLS + 1); c++) {
        const k = `${r}:${c}`;
        const other = cells.get(k);
        if (other !== undefined) {
          const msg = `${name} overlaps ${WIDGETS[widgets[other]!.type].label} (#${other + 1}).`;
          if (!out.includes(msg)) out.push(msg);
        } else cells.set(k, i);
      }
  });
  return out;
}

/** The first free spot for a widget of this size, or null when it doesn't fit. */
export function freeSpot(
  widgets: readonly BoardWidget[],
  w: number,
  h: number,
): { col: number; row: number } | null {
  const used = new Set<string>();
  for (const x of widgets)
    for (let r = x.row; r < x.row + x.h; r++)
      for (let c = x.col; c < x.col + x.w; c++) used.add(`${r}:${c}`);
  for (let row = 1; row + h - 1 <= BOARD_ROWS; row++)
    for (let col = 1; col + w - 1 <= BOARD_COLS; col++) {
      let ok = true;
      for (let r = row; r < row + h && ok; r++)
        for (let c = col; c < col + w && ok; c++) if (used.has(`${r}:${c}`)) ok = false;
      if (ok) return { col, row };
    }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Built-in boards
// ---------------------------------------------------------------------------------------------

export const BUILTIN_BOARD_KEYS = ['mission', 'matrix', 'wan', 'shift'] as const;
export type BuiltinBoardKey = (typeof BUILTIN_BOARD_KEYS)[number];

export interface BuiltinBoard extends BoardDefinition {
  key: BuiltinBoardKey;
  name: string;
  description: string;
}

const W = (type: WidgetType, col: number, row: number, w: number, h: number): BoardWidget => ({
  type,
  col,
  row,
  w,
  h,
});

export const BUILTIN_BOARDS: Record<BuiltinBoardKey, BuiltinBoard> = {
  mission: {
    key: 'mission',
    name: 'Mission control',
    description: 'Everything at once: incidents, the map, divisions and what just happened.',
    widgets: [
      W('status_bar', 1, 1, 12, 1),
      W('priority_counts', 1, 2, 3, 1),
      W('incidents', 1, 3, 3, 5),
      W('map', 4, 2, 6, 6),
      W('division_health', 10, 2, 3, 4),
      W('kpis', 10, 6, 3, 2),
      W('ticker', 1, 8, 12, 1),
    ],
    filters: NO_FILTERS,
  },
  matrix: {
    key: 'matrix',
    name: 'Site matrix',
    description: 'Every site at a glance, grouped by division.',
    widgets: [
      W('status_bar', 1, 1, 12, 1),
      W('site_matrix', 1, 2, 12, 6),
      W('incidents', 1, 8, 12, 1),
    ],
    filters: NO_FILTERS,
  },
  wan: {
    key: 'wan',
    name: 'WAN & circuits',
    description: 'Firewalls, latency, loss and WAN utilization per site, worst first.',
    widgets: [W('status_bar', 1, 1, 12, 1), W('wan', 1, 2, 12, 7)],
    filters: NO_FILTERS,
  },
  shift: {
    key: 'shift',
    name: 'Shift overview',
    description: 'The last 24 hours: noise, response times, flapping devices, busy interfaces.',
    widgets: [
      W('status_bar', 1, 1, 12, 1),
      W('kpis', 1, 2, 12, 2),
      W('alerts_chart', 1, 4, 12, 2),
      W('flapping', 1, 6, 6, 2),
      W('top_interfaces', 7, 6, 6, 2),
      W('notify_summary', 1, 8, 12, 1),
    ],
    filters: NO_FILTERS,
  },
};

/** How a wall link or a page names a board: a built-in key, or `custom:<id>`. */
export const boardRefSchema = z.union([
  z.enum(BUILTIN_BOARD_KEYS),
  z.string().regex(/^custom:[1-9]\d{0,9}$/),
]);
export type BoardRef = z.infer<typeof boardRefSchema>;

export function customBoardRef(id: number): BoardRef {
  return `custom:${id}`;
}

export function customBoardId(ref: string): number | null {
  const m = /^custom:([1-9]\d{0,9})$/.exec(ref);
  return m ? Number(m[1]) : null;
}

export function isBuiltinBoard(ref: string): ref is BuiltinBoardKey {
  return (BUILTIN_BOARD_KEYS as readonly string[]).includes(ref);
}
