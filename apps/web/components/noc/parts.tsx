'use client';

/** Small building blocks for NOC widgets: auto-fit text, sparklines, bars, times. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CHART_MUTED, SERIES_COLORS } from '@/lib/chart-colors';

const useIso = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Shrinks its content's font size in steps (down to `min` × the board's size) until it fits the
 * panel, so a busy day doesn't spill off a TV. Re-measures when the content or the panel changes.
 */
export function AutoFit({
  children,
  min = 0.6,
  deps,
  className,
}: {
  children: ReactNode;
  min?: number;
  deps: unknown;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = box.current?.parentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSize(el.clientWidth * 10_000 + el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useIso(() => {
    setScale(1);
  }, [deps, size]);
  useIso(() => {
    const el = box.current;
    if (!el) return;
    const parent = el.parentElement!;
    if (el.scrollHeight > parent.clientHeight + 1 && scale > min) {
      setScale((s) => Math.max(min, Math.round((s - 0.05) * 100) / 100));
    }
  }, [scale, deps, size]);
  return (
    <div ref={box} className={className} style={{ fontSize: `${scale}em` }}>
      {children}
    </div>
  );
}

/** Reports the pixel height of the space it is given (for the map). */
export function useBoxHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  return [ref, h];
}

/** A 24-hour sparkline (2px line, gaps where hours are missing), labelled for screen readers. */
export function Sparkline({
  values,
  label,
  max,
}: {
  values: Array<number | null>;
  label: string;
  max?: number;
}) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <span className="inline-block w-[4.5em] text-slate-500">—</span>;
  const top = Math.max(max ?? 0, ...nums, 1);
  const W = 90;
  const H = 24;
  const step = W / Math.max(1, values.length - 1);
  const segments: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 1) segments.push(cur.join(' '));
      cur = [];
      return;
    }
    cur.push(`${(i * step).toFixed(1)},${(H - 2 - (v / top) * (H - 4)).toFixed(1)}`);
  });
  if (cur.length > 1) segments.push(cur.join(' '));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="inline-block h-[1em] w-[4.5em] align-[-0.1em]"
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <title>{label}</title>
      {segments.map((p, i) => (
        <polyline
          key={i}
          points={p}
          fill="none"
          stroke={SERIES_COLORS[0]}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

/** A percentage bar with its value; 90 % and up is flagged with an icon and the word "high". */
export function UtilBar({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) return <span className="text-slate-500">—</span>;
  const high = pct >= 90;
  return (
    <span
      className="inline-flex items-center gap-[0.3em] whitespace-nowrap"
      title={`${label}: ${pct}%`}
    >
      <span className="relative inline-block h-[0.5em] w-[3.5em] overflow-hidden rounded-full bg-white/10">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${Math.min(100, pct)}%`,
            background: high ? '#fab219' : SERIES_COLORS[0],
          }}
        />
      </span>
      <span className={`tabular-nums ${high ? 'font-semibold text-amber-200' : ''}`}>
        {pct}%{high ? ' ▲ high' : ''}
      </span>
    </span>
  );
}

/** Small multiples: one bar series per chart on a shared hour axis (never two y-scales). */
export function HourBars({
  rows,
  pick,
  name,
  color,
}: {
  rows: Array<{ label: string; alerts: number; incidents: number }>;
  pick: (r: { alerts: number; incidents: number }) => number;
  name: string;
  color: string;
}) {
  const max = Math.max(1, ...rows.map(pick));
  const total = rows.reduce((a, r) => a + pick(r), 0);
  return (
    <figure className="flex min-h-0 flex-1 flex-col">
      <figcaption className="flex items-baseline justify-between text-[0.8em] text-slate-300">
        <span>{name} per hour</span>
        <span className="tabular-nums text-slate-400">
          {total} in 24 h · peak {max === 1 && !rows.some((r) => pick(r)) ? 0 : max}
        </span>
      </figcaption>
      <div className="flex min-h-0 flex-1 items-end gap-[2px] border-b border-white/15 pt-[0.2em]">
        {rows.map((r) => {
          const v = pick(r);
          return (
            <div
              key={r.label}
              className="group relative flex h-full flex-1 items-end"
              title={`${r.label} · ${v} ${name.toLowerCase()}`}
            >
              <div
                className="w-full rounded-t-[3px]"
                style={{
                  height: v ? `${Math.max(3, (v / max) * 100)}%` : 0,
                  background: color,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        className="flex justify-between text-[0.65em] tabular-nums"
        style={{ color: CHART_MUTED }}
      >
        {rows
          .filter((_, i) => i % 6 === 0 || i === rows.length - 1)
          .map((r) => (
            <span key={r.label}>{r.label}</span>
          ))}
      </div>
    </figure>
  );
}

/** "14:02" in the app's time zone. */
export function clockTime(ms: number, tz: string): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
}
