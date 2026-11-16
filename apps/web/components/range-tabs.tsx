import Link from 'next/link';
import { cx } from './ui';

export const RANGE_OPTIONS = [
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
] as const;
export type RangeKey = (typeof RANGE_OPTIONS)[number][0];

export function parseRange(v: string | undefined): RangeKey {
  return RANGE_OPTIONS.some(([k]) => k === v) ? (v as RangeKey) : '24h';
}

/** One row above the charts; every chart on the page follows it. */
export function RangeTabs({ base, current }: { base: string; current: RangeKey }) {
  return (
    <nav className="flex gap-1 text-sm" aria-label="Time range">
      {RANGE_OPTIONS.map(([k, label]) => (
        <Link
          key={k}
          href={`${base}?range=${k}`}
          aria-current={k === current ? 'page' : undefined}
          className={cx(
            'rounded-md px-3 py-1.5',
            k === current ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white',
          )}
        >
          {k === current ? '✓ ' : ''}
          {label}
        </Link>
      ))}
    </nav>
  );
}
