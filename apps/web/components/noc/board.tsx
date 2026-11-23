'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { WIDGETS } from '@mercer/core/noc';
import { StaleBanner, useLive } from '../live';
import { cx } from '../ui';
import type { NocBoardView, NocData, NocMode } from './types';
import { WIDGET_COMPONENTS } from './widgets';

/** Widgets one row high carry no heading; neither does the map. */
const untitled = (type: string, h: number) => h === 1 || type === 'map' || type === 'status_bar';

/**
 * A NOC board: its widgets on a 12 × 8 grid. TV mode fills the screen at wall text sizes; desktop
 * mode fills the space it is given on large screens and stacks the widgets on small ones.
 */
export function NocBoard({
  board,
  data,
  mode,
  className,
}: {
  board: NocBoardView;
  data: NocData;
  mode: NocMode;
  className?: string;
}) {
  const live = useLive();
  const now = live?.now ?? data.now;
  const tv = mode === 'tv';
  return (
    <div
      className={cx(
        'grid gap-[0.3em]',
        tv
          ? 'h-full grid-cols-12 grid-rows-8 p-[0.35em] text-[28px]'
          : 'grid-cols-1 text-[15px] lg:h-full lg:grid-cols-12 lg:grid-rows-8',
        className,
      )}
      data-testid="noc-board"
      data-board={board.ref}
    >
      {board.definition.widgets.map((w, i) => {
        const C = WIDGET_COMPONENTS[w.type];
        const style = {
          '--gc': `${w.col} / span ${w.w}`,
          '--gr': `${w.row} / span ${w.h}`,
          '--h': w.h,
        } as CSSProperties;
        return (
          <section
            key={`${w.type}-${i}`}
            style={style}
            className={cx(
              'flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] px-[0.5em] py-[0.35em]',
              tv
                ? '[grid-column:var(--gc)] [grid-row:var(--gr)]'
                : 'min-h-[calc(var(--h)*4.5rem)] lg:min-h-0 lg:[grid-column:var(--gc)] lg:[grid-row:var(--gr)]',
            )}
            data-widget={w.type}
            aria-label={w.title || WIDGETS[w.type].label}
          >
            {!untitled(w.type, w.h) && (
              <h2 className="mb-[0.2em] shrink-0 text-[0.7em] font-bold uppercase tracking-wide text-slate-400">
                {w.title || WIDGETS[w.type].label}
              </h2>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              <C data={data} mode={mode} widget={w} now={now} boardName={board.name} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

const RELOAD_AFTER_MS = 6 * 3600_000;

/**
 * A wall screen showing NOC boards in turn. While a P1 is open (and the wall settings say so) it
 * stays on the first board with an incident list.
 */
export function NocWall({
  boards,
  rotateSec,
  pinP1,
}: {
  boards: Array<{ view: NocBoardView; data: NocData }>;
  rotateSec: number;
  pinP1: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const p1 = boards.some((b) => b.data.counts.P1 > 0);
  const pinned =
    pinP1 && p1
      ? boards.findIndex((b) => b.view.definition.widgets.some((w) => w.type === 'incidents'))
      : -1;
  const n = boards.length;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (n < 2 || pinned >= 0) return;
    timer.current = setInterval(() => setIdx((i) => (i + 1) % n), rotateSec * 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [n, rotateSec, pinned]);

  // Kiosk browsers run for weeks: a periodic full reload picks up new releases and frees memory.
  useEffect(() => {
    const id = setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
    return () => clearTimeout(id);
  }, []);

  const cur = boards[pinned >= 0 ? pinned : idx % n]!;
  return (
    <div className="flex h-screen cursor-none flex-col bg-[#0a0e13] text-slate-100">
      <StaleBanner variant="wall" />
      <div className="min-h-0 flex-1" data-testid="wall-view" data-view={`board:${cur.view.ref}`}>
        <NocBoard board={cur.view} data={cur.data} mode="tv" />
      </div>
      {n > 1 && (
        <footer className="flex justify-center gap-3 pb-2" aria-hidden>
          {boards.map((b) => (
            <span
              key={b.view.ref}
              className={`h-2 w-10 rounded-full ${b === cur ? 'bg-slate-200' : 'bg-slate-700'}`}
            />
          ))}
        </footer>
      )}
    </div>
  );
}
