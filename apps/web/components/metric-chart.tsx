'use client';

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface ChartSeries {
  key: string;
  label: string;
  /** Categorical slot colour (dark steps): series 1 #3987e5, series 2 #d95926. */
  color: string;
}

export type ChartPoint = { t: number } & Record<string, number | null>;

const SURFACE = '#12161b';
const GRID = '#2c2c2a';
const MUTED = '#898781';
const SECONDARY = '#c3c2b7';
export const SERIES_COLORS = ['#3987e5', '#d95926'] as const;

function fmtValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const n = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return unit === '%' ? `${n}%` : `${n}${unit ? ` ${unit}` : ''}`;
}

/** Axis ticks: compact numbers; the unit is in the chart title ("Response time (ms)"). */
function fmtTick(v: number, unit: string): string {
  const n = Math.abs(v) >= 10 || Number.isInteger(v) ? Math.round(v).toString() : v.toFixed(1);
  return unit === '%' ? `${n}%` : n;
}

function timeFmt(tz: string, long: boolean) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    ...(long ? { month: 'short', day: 'numeric' } : { hour: 'numeric', minute: '2-digit' }),
  });
  return (t: number) => f.format(new Date(t));
}

/**
 * One measure per chart (never two y-scales). A single series is named by the title and gets an
 * area wash; two or more get a legend and end labels. Every value is also in the table view.
 */
export function MetricChart({
  title,
  data,
  series,
  unit,
  tz,
  longRange,
  yMax,
  height = 220,
}: {
  title: string;
  data: ChartPoint[];
  series: ChartSeries[];
  unit: string;
  tz: string;
  longRange: boolean;
  yMax?: number;
  height?: number;
}) {
  const tick = timeFmt(tz, longRange);
  const full = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const multi = series.length > 1;
  const hasData = data.some((d) => series.some((s) => d[s.key] !== null && d[s.key] !== undefined));

  const lastIndex = (key: string) => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i]![key] !== null) return i;
    return -1;
  };

  const TooltipBody = ({ active, label }: { active?: boolean; label?: unknown }) => {
    if (!active || label === undefined) return null;
    const t = Number(label);
    const point = data.find((d) => d.t === t);
    if (!point) return null;
    return (
      <div className="rounded-md border border-white/15 bg-[#0b0f14] px-3 py-2 text-xs shadow-lg">
        <div className="mb-1 text-slate-400">{full.format(new Date(t))}</div>
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-2">
            <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
            <span className="font-semibold text-slate-100">{fmtValue(point[s.key], unit)}</span>
            <span className="text-slate-400">{s.label}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <figure>
      <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-200">
          {title}
          {unit && unit !== '%' ? ` (${unit})` : ''}
        </span>
        {multi && (
          <span className="flex gap-4 text-xs text-slate-300" aria-hidden>
            {series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      {hasData ? (
        <div style={{ height }} role="img" aria-label={`${title} chart`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data}
              margin={{ top: 8, right: multi ? 56 : 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={tick}
                stroke={MUTED}
                tick={{ fill: MUTED, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: '#383835' }}
                minTickGap={40}
              />
              <YAxis
                width={48}
                domain={[0, yMax ?? 'auto']}
                tickFormatter={(v: number) => fmtTick(v, unit)}
                stroke={MUTED}
                tick={{ fill: MUTED, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip
                content={TooltipBody}
                cursor={{ stroke: MUTED, strokeWidth: 1 }}
                isAnimationActive={false}
              />
              {!multi && (
                <Area
                  type="monotone"
                  dataKey={series[0]!.key}
                  stroke="none"
                  fill={series[0]!.color}
                  fillOpacity={0.1}
                  isAnimationActive={false}
                  connectNulls={false}
                  activeDot={false}
                />
              )}
              {series.map((s) => {
                const last = lastIndex(s.key);
                return (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={false}
                    activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2, fill: s.color }}
                    connectNulls={false}
                    isAnimationActive={false}
                    label={
                      multi
                        ? (p: { index?: number; x?: number | string; y?: number | string }) =>
                            p.index === last ? (
                              <text
                                x={Number(p.x) + 6}
                                y={Number(p.y) + 4}
                                fill={SECONDARY}
                                fontSize={11}
                              >
                                {s.label}
                              </text>
                            ) : (
                              <g />
                            )
                        : undefined
                    }
                  />
                );
              })}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p
          className="flex items-center justify-center rounded-lg border border-dashed border-white/10 text-sm text-slate-500"
          style={{ height }}
        >
          No samples in this range yet.
        </p>
      )}
      {hasData && (
        <details className="mt-2 text-xs text-slate-400">
          <summary className="cursor-pointer">Data table</summary>
          <div className="mt-2 max-h-56 overflow-auto">
            <table className="w-full text-left tabular-nums">
              <thead className="sticky top-0 bg-[#12161b]">
                <tr>
                  <th className="py-1 pr-4">Time</th>
                  {series.map((s) => (
                    <th key={s.key} className="pr-4 text-right">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...data].reverse().map((d) => (
                  <tr key={d.t} className="border-t border-white/5">
                    <td className="py-0.5 pr-4">{full.format(new Date(d.t))}</td>
                    {series.map((s) => (
                      <td key={s.key} className="pr-4 text-right text-slate-300">
                        {fmtValue(d[s.key], unit)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
