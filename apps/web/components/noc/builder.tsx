'use client';

import Link from 'next/link';
import { useActionState, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  BOARD_COLS,
  BOARD_ROWS,
  BUILTIN_BOARDS,
  BUILTIN_BOARD_KEYS,
  WIDGETS,
  WIDGET_TYPES,
  freeSpot,
  layoutProblems,
  type BoardDefinition,
  type BoardWidget,
  type WidgetType,
} from '@mercer/core/noc';
import {
  deleteNocBoardAction,
  saveNocBoardAction,
  type NocBoardFormState,
} from '@/app/actions/noc';
import { Alert, Badge, Button, Card, FieldShell, Input, Select, cx } from '../ui';

export interface CustomBoardView {
  id: number;
  name: string;
  definition: BoardDefinition;
  updatedBy: string;
  updatedAt: string;
}

interface Options {
  divisions: Array<{ code: string; name: string }>;
  sites: Array<{ id: number; name: string }>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep a widget on the grid and at least its minimum size. */
function fit(w: BoardWidget): BoardWidget {
  const info = WIDGETS[w.type];
  const width = clamp(w.w, info.minW, BOARD_COLS);
  const height = clamp(w.h, info.minH, BOARD_ROWS);
  return {
    ...w,
    w: width,
    h: height,
    col: clamp(w.col, 1, BOARD_COLS - width + 1),
    row: clamp(w.row, 1, BOARD_ROWS - height + 1),
  };
}

function filtersText(d: BoardDefinition, o: Options): string {
  const f = d.filters;
  const parts: string[] = [];
  if (f.divisions.length)
    parts.push(f.divisions.map((c) => o.divisions.find((x) => x.code === c)?.name ?? c).join(', '));
  if (f.harvestCriticalOnly) parts.push('harvest-critical sites');
  if (f.siteIds.length)
    parts.push(`${f.siteIds.length} chosen site${f.siteIds.length === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'all sites';
}

/** The board editor: a 12 × 8 preview to drag widgets on, and fields for the selected one. */
function Builder({
  initial,
  options,
  onDone,
}: {
  initial: { id?: number; name: string; definition: BoardDefinition };
  options: Options;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<NocBoardFormState, FormData>(
    saveNocBoardAction,
    {},
  );
  const [name, setName] = useState(initial.name);
  const [widgets, setWidgets] = useState<BoardWidget[]>(initial.definition.widgets);
  const [filters, setFilters] = useState(initial.definition.filters);
  const [sel, setSel] = useState<number | null>(widgets.length ? 0 : null);
  const [adding, setAdding] = useState<WidgetType>('incidents');
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{ i: number; kind: 'move' | 'size'; dx: number; dy: number } | null>(null);
  const problems = useMemo(() => layoutProblems(widgets), [widgets]);
  const id = state.id ?? initial.id;

  const update = (i: number, patch: Partial<BoardWidget>) =>
    setWidgets((ws) => ws.map((w, j) => (j === i ? fit({ ...w, ...patch }) : w)));

  const cellAt = (e: PointerEvent) => {
    const r = grid.current!.getBoundingClientRect();
    return {
      col: clamp(Math.floor(((e.clientX - r.left) / r.width) * BOARD_COLS) + 1, 1, BOARD_COLS),
      row: clamp(Math.floor(((e.clientY - r.top) / r.height) * BOARD_ROWS) + 1, 1, BOARD_ROWS),
    };
  };
  const onDown = (e: PointerEvent, i: number, kind: 'move' | 'size') => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const c = cellAt(e);
    const w = widgets[i]!;
    drag.current = { i, kind, dx: c.col - w.col, dy: c.row - w.row };
    setSel(i);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const c = cellAt(e);
    const w = widgets[d.i]!;
    if (d.kind === 'move') {
      if (c.col - d.dx !== w.col || c.row - d.dy !== w.row)
        update(d.i, { col: c.col - d.dx, row: c.row - d.dy });
    } else if (c.col - w.col + 1 !== w.w || c.row - w.row + 1 !== w.h)
      update(d.i, { w: c.col - w.col + 1, h: c.row - w.row + 1 });
  };
  const onUp = () => {
    drag.current = null;
  };

  const add = () => {
    const info = WIDGETS[adding];
    let w = info.w;
    let h = info.h;
    let spot = freeSpot(widgets, w, h);
    // No room at the default size: try the smallest size the widget allows.
    if (!spot) {
      w = info.minW;
      h = info.minH;
      spot = freeSpot(widgets, w, h);
    }
    const next = fit({ type: adding, col: spot?.col ?? 1, row: spot?.row ?? 1, w, h });
    setWidgets((ws) => [...ws, next]);
    setSel(widgets.length);
  };

  const selected = sel !== null ? widgets[sel] : undefined;
  const definition: BoardDefinition = { widgets, filters };

  return (
    <form action={action} className="space-y-5" data-testid="noc-builder">
      {id && <input type="hidden" name="id" value={id} />}
      <input type="hidden" name="definition" value={JSON.stringify(definition)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell id="nb-name" label="Board name">
          <Input
            id="nb-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Grain harvest"
            maxLength={80}
          />
        </FieldShell>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-white/10 p-4">
        <legend className="px-1 text-sm font-medium text-slate-200">Sites on this board</legend>
        <p className="text-xs text-slate-400">
          Nothing chosen: every site. Incidents show when their site, or a site they affect, is on
          the board.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {options.divisions.map((d) => (
            <label
              key={d.code}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/15 px-2 py-1 text-sm text-slate-200 has-[:checked]:border-sky-400 has-[:checked]:bg-sky-500/10"
            >
              <input
                type="checkbox"
                checked={filters.divisions.includes(d.code)}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    divisions: e.target.checked
                      ? [...f.divisions, d.code]
                      : f.divisions.filter((c) => c !== d.code),
                  }))
                }
                className="accent-sky-400"
                aria-label={`Division ${d.name}`}
              />
              {d.name}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.harvestCriticalOnly}
            onChange={(e) => setFilters((f) => ({ ...f, harvestCriticalOnly: e.target.checked }))}
            className="accent-sky-400"
          />
          Only harvest-critical sites
        </label>
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-300">
            Only these sites ({filters.siteIds.length ? `${filters.siteIds.length} chosen` : 'any'})
          </summary>
          <div className="mt-2 flex max-h-48 flex-wrap gap-1.5 overflow-auto">
            {options.sites.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/15 px-2 py-1 text-slate-200 has-[:checked]:border-sky-400 has-[:checked]:bg-sky-500/10"
              >
                <input
                  type="checkbox"
                  checked={filters.siteIds.includes(s.id)}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      siteIds: e.target.checked
                        ? [...f.siteIds, s.id]
                        : f.siteIds.filter((x) => x !== s.id),
                    }))
                  }
                  className="accent-sky-400"
                />
                {s.name}
              </label>
            ))}
          </div>
        </details>
      </fieldset>

      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <FieldShell id="nb-add" label="Add a widget">
            <Select
              id="nb-add"
              value={adding}
              onChange={(e) => setAdding(e.target.value as WidgetType)}
              className="w-60"
            >
              {WIDGET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {WIDGETS[t].label}
                </option>
              ))}
            </Select>
          </FieldShell>
          <Button type="button" variant="secondary" onClick={add}>
            Add
          </Button>
          <span className="pb-2 text-xs text-slate-400">{WIDGETS[adding].description}</span>
        </div>
        <p className="text-xs text-slate-400">
          Drag a widget to move it; drag its corner to resize. The preview is the TV screen: 12
          columns × 8 rows.
        </p>
        <div
          ref={grid}
          className="relative grid aspect-video w-full touch-none select-none gap-1 rounded-lg border border-white/10 bg-black/30 p-1"
          style={{
            gridTemplateColumns: `repeat(${BOARD_COLS}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${BOARD_ROWS}, minmax(0, 1fr))`,
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          data-testid="noc-builder-grid"
        >
          {widgets.map((w, i) => (
            <div
              key={i}
              role="button"
              tabIndex={0}
              aria-label={`${WIDGETS[w.type].label}: columns ${w.col}–${w.col + w.w - 1}, rows ${w.row}–${w.row + w.h - 1}`}
              onPointerDown={(e) => onDown(e, i, 'move')}
              onKeyDown={(e) => {
                const k: Record<string, Partial<BoardWidget>> = {
                  ArrowLeft: { col: w.col - 1 },
                  ArrowRight: { col: w.col + 1 },
                  ArrowUp: { row: w.row - 1 },
                  ArrowDown: { row: w.row + 1 },
                };
                if (k[e.key]) {
                  e.preventDefault();
                  update(i, k[e.key]!);
                }
              }}
              onFocus={() => setSel(i)}
              className={cx(
                'relative flex cursor-move items-center justify-center overflow-hidden rounded-md border p-1 text-center text-xs font-medium',
                sel === i
                  ? 'border-sky-400 bg-sky-500/25 text-white'
                  : 'border-white/20 bg-white/[0.07] text-slate-200',
              )}
              style={{ gridColumn: `${w.col} / span ${w.w}`, gridRow: `${w.row} / span ${w.h}` }}
            >
              {w.title || WIDGETS[w.type].label}
              <span
                aria-hidden
                onPointerDown={(e) => onDown(e, i, 'size')}
                className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize rounded-tl bg-white/40"
              />
            </div>
          ))}
        </div>
        {problems.length > 0 && (
          <Alert tone="warning" title="Fix the layout before saving">
            {problems.join(' ')}
          </Alert>
        )}
      </div>

      {selected && sel !== null && (
        <fieldset
          className="grid gap-3 rounded-lg border border-white/10 p-4 sm:grid-cols-6"
          data-testid="noc-builder-selected"
        >
          <legend className="px-1 text-sm font-medium text-slate-200">
            {WIDGETS[selected.type].label}
          </legend>
          {(
            [
              ['col', 'Column', BOARD_COLS],
              ['row', 'Row', BOARD_ROWS],
              ['w', 'Width', BOARD_COLS],
              ['h', 'Height', BOARD_ROWS],
            ] as const
          ).map(([k, label, max]) => (
            <FieldShell key={k} id={`nb-${k}`} label={label}>
              <Input
                id={`nb-${k}`}
                type="number"
                min={1}
                max={max}
                value={selected[k]}
                onChange={(e) => update(sel, { [k]: Number(e.target.value) || 1 })}
              />
            </FieldShell>
          ))}
          <div className="sm:col-span-2">
            <FieldShell id="nb-title" label="Heading (optional)">
              <Input
                id="nb-title"
                value={selected.title ?? ''}
                maxLength={60}
                placeholder={WIDGETS[selected.type].label}
                onChange={(e) =>
                  setWidgets((ws) =>
                    ws.map((w, j) =>
                      j === sel ? { ...w, title: e.target.value || undefined } : w,
                    ),
                  )
                }
              />
            </FieldShell>
          </div>
          <div className="sm:col-span-6">
            <Button
              type="button"
              variant="ghost"
              className="text-red-300"
              onClick={() => {
                setWidgets((ws) => ws.filter((_, j) => j !== sel));
                setSel(null);
              }}
            >
              Remove widget
            </Button>
          </div>
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || problems.length > 0 || !widgets.length}>
          {pending ? 'Saving…' : 'Save board'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Close
        </Button>
        {id && state.ok && (
          <Link href={`/noc?board=custom:${id}`} className="text-sm underline">
            Open it
          </Link>
        )}
      </div>
      {state.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
    </form>
  );
}

/** Settings → NOC boards: the built-in boards, the custom ones, and the builder. */
export function NocBoardsPanel({
  boards,
  options,
}: {
  boards: CustomBoardView[];
  options: Options;
}) {
  const [editing, setEditing] = useState<{
    key: string;
    id?: number;
    name: string;
    definition: BoardDefinition;
  } | null>(null);
  const [template, setTemplate] = useState<string>('blank');

  const start = () => {
    const t = template === 'blank' ? null : BUILTIN_BOARDS[template as keyof typeof BUILTIN_BOARDS];
    setEditing({
      key: `new-${Date.now()}`,
      name: t ? `${t.name} (copy)` : '',
      definition: t
        ? { widgets: t.widgets.map((w) => ({ ...w })), filters: { ...t.filters } }
        : {
            widgets: [{ type: 'status_bar', col: 1, row: 1, w: 12, h: 1 }],
            filters: { divisions: [], harvestCriticalOnly: false, siteIds: [] },
          },
    });
  };

  return (
    <div className="space-y-6">
      <Card
        title="Boards"
        description="The four built-in boards are always available. Compose your own from the same widgets, for example one per division or for harvest. Show any of them on a TV under Map & wall → a wall link → What it shows."
      >
        <ul className="divide-y divide-white/10" data-testid="noc-boards">
          {BUILTIN_BOARD_KEYS.map((k) => (
            <li key={k} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <span className="font-medium text-slate-100">{BUILTIN_BOARDS[k].name}</span>
              <Badge tone="neutral">built in</Badge>
              <span className="text-slate-400">{BUILTIN_BOARDS[k].description}</span>
              <Link href={`/noc?board=${k}`} className="ml-auto text-slate-300 underline">
                View
              </Link>
            </li>
          ))}
          {boards.map((b) => (
            <li
              key={b.id}
              className="flex flex-wrap items-center gap-3 py-3 text-sm"
              data-board={b.name}
            >
              <span className="font-medium text-slate-100">{b.name}</span>
              <span className="text-slate-400">
                {b.definition.widgets.length} widgets · {filtersText(b.definition, options)}
              </span>
              <span className="ml-auto flex items-center gap-3">
                <Link href={`/noc?board=custom:${b.id}`} className="text-slate-300 underline">
                  View
                </Link>
                <Button
                  type="button"
                  variant="secondary"
                  className="px-3 py-1 text-xs"
                  onClick={() =>
                    setEditing({
                      key: `e${b.id}`,
                      id: b.id,
                      name: b.name,
                      definition: b.definition,
                    })
                  }
                >
                  Edit
                </Button>
                <form action={deleteNocBoardAction}>
                  <input type="hidden" name="id" value={b.id} />
                  <Button
                    type="submit"
                    variant="ghost"
                    className="px-3 py-1 text-xs text-red-300"
                    onClick={(e) => {
                      if (
                        !window.confirm(`Delete “${b.name}”? Screens showing it stop showing it.`)
                      )
                        e.preventDefault();
                    }}
                  >
                    Delete
                  </Button>
                </form>
              </span>
            </li>
          ))}
        </ul>
        {!editing && (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <FieldShell id="nb-template" label="New board, starting from">
              <Select
                id="nb-template"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="w-56"
              >
                <option value="blank">A blank board</option>
                {BUILTIN_BOARD_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {BUILTIN_BOARDS[k].name}
                  </option>
                ))}
              </Select>
            </FieldShell>
            <Button type="button" onClick={start}>
              New board
            </Button>
          </div>
        )}
      </Card>
      {editing && (
        <Card title={editing.id ? `Edit “${editing.name}”` : 'New board'}>
          <Builder
            key={editing.key}
            initial={editing}
            options={options}
            onDone={() => setEditing(null)}
          />
        </Card>
      )}
    </div>
  );
}
