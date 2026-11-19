'use client';

import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_GRID, CHART_MUTED, CHART_SECONDARY, CHART_SURFACE } from '@/lib/chart-colors';

const SURFACE = CHART_SURFACE;
const GRID = CHART_GRID;
const MUTED = CHART_MUTED;
const SECONDARY = CHART_SECONDARY;

export interface CountPoint {
  label: string;
  value: number;
}

/**
 * Counts per hour or day as thin bars: one series (named by the title, so no legend), a hover
 * tooltip per bar, a recessive grid, and the same numbers as a table one click away.
 */
export function CountBars({
  title,
  data,
  color,
  hourly,
  testId,
}: {
  title: string;
  data: CountPoint[];
  color: string;
  hourly: boolean;
  testId?: string;
}) {
  const [table, setTable] = useState(false);
  const tick = (l: string) => (hourly ? l.slice(11, 16) : l.slice(5));
  const total = data.reduce((s, p) => s + p.value, 0);
  return (
    <figure className="rounded-xl border border-white/10 bg-[#12161b] p-4" data-testid={testId}>
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-slate-100">{title}</span>
        <span className="flex items-baseline gap-3">
          <span className="text-xs text-slate-400">{total.toLocaleString('en-US')} in total</span>
          <button
            type="button"
            onClick={() => setTable((t) => !t)}
            className="text-xs text-sky-300 hover:underline"
          >
            {table ? 'Show chart' : 'Show table'}
          </button>
        </span>
      </figcaption>
      {table ? (
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-400">
              <tr>
                <th className="py-1 font-medium">{hourly ? 'Hour' : 'Day'}</th>
                <th className="py-1 text-right font-medium">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.map((p) => (
                <tr key={p.label}>
                  <td className="py-1 text-slate-300">{p.label}</td>
                  <td className="py-1 text-right tabular-nums text-slate-100">{p.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              barCategoryGap={2}
              margin={{ top: 8, right: 4, bottom: 0, left: -12 }}
            >
              <CartesianGrid stroke={GRID} strokeDasharray="0" vertical={false} />
              <XAxis
                dataKey="label"
                tickFormatter={tick}
                tick={{ fill: MUTED, fontSize: 11 }}
                axisLine={{ stroke: GRID }}
                tickLine={false}
                minTickGap={16}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: MUTED, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={44}
              />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                contentStyle={{
                  background: SURFACE,
                  border: `1px solid ${GRID}`,
                  borderRadius: 8,
                  fontSize: 12,
                  color: SECONDARY,
                }}
                labelStyle={{ color: '#f1f0ea' }}
                formatter={(v: unknown) => [String(v), title]}
              />
              <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}
