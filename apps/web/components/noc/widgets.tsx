'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { durationText, type BoardWidget } from '@mercer/core/noc';
import { SERIES_COLORS } from '@/lib/chart-colors';
import { LiveDot } from '../live';
import { SiteMap } from '../site-map';
import { LEVEL, LevelIcon, PRIORITY, PriorityBadge, type Level } from '../status';
import { AutoFit, HourBars, Sparkline, UtilBar, clockTime, useBoxHeight } from './parts';
import type { NocData, NocMode } from './types';

export interface WidgetProps {
  data: NocData;
  mode: NocMode;
  widget: BoardWidget;
  /** Server time now (ticks with the live clock). */
  now: number;
  boardName: string;
}

/** A link on desktops, plain text on TVs (the wall has no links). */
function To({ href, mode, children }: { href: string; mode: NocMode; children: ReactNode }) {
  return mode === 'desktop' ? (
    <Link href={href} className="hover:underline">
      {children}
    </Link>
  ) : (
    <>{children}</>
  );
}

const iconSize = (mode: NocMode) => (mode === 'tv' ? 26 : 16);

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center gap-[0.4em] text-slate-300">
      <LevelIcon level="ok" size={22} />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function StatusBar({ data, mode, now, boardName }: WidgetProps) {
  const s = data.status;
  const p1 = data.counts.P1;
  return (
    <div className="flex h-full flex-wrap items-center gap-x-[1em] gap-y-[0.2em] overflow-hidden">
      <span className="font-semibold tracking-tight">{boardName}</span>
      <span className="tabular-nums text-[1.1em] font-semibold" suppressHydrationWarning>
        {clockTime(now, data.tz)}
      </span>
      <span className="inline-flex items-center gap-[0.3em]" data-testid="noc-feed">
        <LevelIcon
          level={s.swis === 'up' ? 'ok' : s.swis === 'down' ? 'bad' : 'unknown'}
          size={iconSize(mode)}
        />
        {s.swis === 'up'
          ? 'SolarWinds live'
          : s.swis === 'down'
            ? 'SolarWinds unreachable'
            : 'SolarWinds unknown'}
      </span>
      {p1 > 0 && (
        <span
          className="rounded-md px-[0.4em] font-bold"
          style={{ background: PRIORITY.P1!.bg, color: PRIORITY.P1!.ink }}
        >
          ✕ {p1} P1 open
        </span>
      )}
      {s.harvest && (
        <span className="rounded-md bg-amber-400/15 px-[0.4em] text-amber-100">🌾 {s.harvest}</span>
      )}
      {s.maintenance > 0 && (
        <span className="inline-flex items-center gap-[0.3em] text-sky-100">
          <LevelIcon level="maintenance" size={iconSize(mode)} />
          {s.maintenance} in maintenance
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-[0.8em]">
        {s.oncall?.primary && (
          <span>
            On call: <span className="font-semibold">{s.oncall.primary}</span>
            {s.oncall.secondary && mode === 'desktop' ? ` · backup ${s.oncall.secondary}` : ''}
          </span>
        )}
        <span className={mode === 'tv' ? 'origin-right scale-150' : ''}>
          <LiveDot />
        </span>
      </span>
    </div>
  );
}

export function PriorityCounts({ data, mode }: WidgetProps) {
  return (
    <div className="grid h-full grid-cols-4 gap-[0.3em]">
      {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => {
        const n = data.counts[p];
        const cell = (
          <div
            className={`flex h-full items-center justify-center gap-[0.35em] rounded-lg ${n ? 'bg-white/[0.06]' : ''}`}
            data-testid={`noc-count-${p}`}
          >
            <PriorityBadge p={p} size={mode === 'tv' ? 'lg' : 'sm'} />
            <span
              className={`tabular-nums text-[1.4em] font-semibold ${n ? '' : 'text-slate-500'}`}
            >
              {n}
            </span>
          </div>
        );
        return mode === 'desktop' ? (
          <Link key={p} href={`/incidents?priority=${p}`} className="hover:opacity-90">
            {cell}
          </Link>
        ) : (
          <div key={p}>{cell}</div>
        );
      })}
    </div>
  );
}

function recoveryText(dueAt: number, now: number) {
  const left = dueAt - now;
  return left >= 0
    ? { text: `${durationText(left)} left`, late: false }
    : { text: `${durationText(left)} over target`, late: true };
}

export function Incidents({ data, mode, widget, now }: WidgetProps) {
  const list = data.incidents;
  if (!list.length) return <Empty>No open incidents</Empty>;
  if (widget.h === 1) {
    const top = list[0]!;
    return (
      <div className="flex h-full items-center gap-[0.5em] overflow-hidden whitespace-nowrap">
        <PriorityBadge p={top.priority} size={mode === 'tv' ? 'lg' : 'sm'} />
        <span className="truncate font-semibold">
          <To href={`/incidents/${top.id}`} mode={mode}>
            {top.title}
          </To>
        </span>
        <span className="text-slate-300">
          · {durationText(now - top.openedAt)} ·{' '}
          {top.acknowledged ? 'acknowledged' : 'not acknowledged'}
        </span>
        {list.length > 1 && (
          <span className="ml-auto shrink-0 text-slate-400">+{list.length - 1} more</span>
        )}
      </div>
    );
  }
  return (
    <AutoFit deps={list} min={0.65}>
      <ul className="space-y-[0.45em]" data-testid="noc-incidents">
        {list.map((i) => {
          const r = recoveryText(i.recoveryDueAt, now);
          return (
            <li key={i.id} className="border-b border-white/5 pb-[0.35em] last:border-0">
              <div className="flex items-start gap-[0.4em]">
                <PriorityBadge p={i.priority} size={mode === 'tv' ? 'lg' : 'sm'} />
                <span className="min-w-0 font-semibold leading-tight">
                  <To href={`/incidents/${i.id}`} mode={mode}>
                    {i.title}
                  </To>
                </span>
              </div>
              <div className="mt-[0.15em] text-[0.8em] leading-snug text-slate-300">
                {i.site ?? 'No site'} · {durationText(now - i.openedAt)} ·{' '}
                {i.acknowledged ? (
                  <span>acknowledged{i.acknowledgedBy ? ` by ${i.acknowledgedBy}` : ''}</span>
                ) : (
                  <span className="font-semibold text-amber-200">! not acknowledged</span>
                )}
                {i.inMaintenance ? ' · in maintenance' : ''}
              </div>
              <div
                className={`text-[0.8em] ${r.late ? 'font-semibold text-red-300' : 'text-slate-400'}`}
              >
                {r.late ? '✕ ' : '⏱ '}
                {r.text}
              </div>
            </li>
          );
        })}
      </ul>
    </AutoFit>
  );
}

export function MapWidget({ data, mode }: WidgetProps) {
  const [ref, h] = useBoxHeight<HTMLDivElement>();
  if (!data.map) return null;
  return (
    <div ref={ref} className="h-full min-h-0">
      {h > 0 && (
        <SiteMap
          sites={data.map.sites}
          config={data.map.config}
          height={h}
          variant={mode === 'tv' ? 'wall' : 'dashboard'}
        />
      )}
    </div>
  );
}

export function DivisionHealth({ data, mode }: WidgetProps) {
  if (!data.divisions.length) return <Empty>No sites on this board</Empty>;
  return (
    <AutoFit deps={data.divisions} min={0.65}>
      <ul className="space-y-[0.35em]" data-testid="noc-divisions">
        {data.divisions.map((d) => (
          <li key={d.code ?? d.name} className="flex items-start gap-[0.4em]">
            <LevelIcon level={d.level} size={iconSize(mode)} />
            <div className="min-w-0">
              <div className="font-semibold leading-tight">{d.name}</div>
              <div className="text-[0.75em] text-slate-300">
                {d.notOk
                  ? `${d.notOk} of ${d.sites} not OK${d.worst ? ` · ${d.worst}` : ''}`
                  : `all ${d.sites} OK`}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </AutoFit>
  );
}

export function Ticker({ data, mode, widget }: WidgetProps) {
  const items = data.activity;
  if (!items.length) return <Empty>Nothing new in the last 24 hours</Empty>;
  if (widget.h === 1)
    return (
      <div
        className="flex h-full items-center gap-[1em] overflow-hidden whitespace-nowrap"
        data-testid="noc-activity"
      >
        {items.slice(0, 4).map((a, i) => (
          <span key={i} className="shrink-0">
            <span className="tabular-nums text-slate-400">{clockTime(a.at, data.tz)}</span> {a.text}
          </span>
        ))}
      </div>
    );
  return (
    <AutoFit deps={items} min={0.65}>
      <ul className="space-y-[0.25em]" data-testid="noc-activity">
        {items.map((a, i) => (
          <li key={i} className="leading-snug">
            <span className="tabular-nums text-slate-400">{clockTime(a.at, data.tz)}</span>{' '}
            {a.incidentId && mode === 'desktop' ? (
              <Link href={`/incidents/${a.incidentId}`} className="hover:underline">
                {a.text}
              </Link>
            ) : (
              a.text
            )}
          </li>
        ))}
      </ul>
    </AutoFit>
  );
}

const ROLE_INK: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'border-white/15 text-slate-300',
  warn: 'border-amber-400/60 bg-amber-400/15 text-amber-100',
  bad: 'border-red-400/70 bg-red-500/25 text-red-100',
};

export function SiteMatrix({ data, mode }: WidgetProps) {
  if (!data.matrix.length) return <Empty>No sites on this board</Empty>;
  return (
    <AutoFit deps={data.matrix} min={0.5}>
      <div className="space-y-[0.5em]" data-testid="noc-matrix">
        {data.matrix.map((g) => (
          <section key={g.name}>
            <h3 className="mb-[0.2em] flex items-center gap-[0.35em] text-[0.75em] font-bold uppercase tracking-wide text-slate-300">
              <LevelIcon level={g.level} size={mode === 'tv' ? 20 : 14} />
              {g.name}
              {g.isAffiliate && <span className="font-normal normal-case">affiliate</span>}
            </h3>
            <div className="flex flex-wrap gap-[0.3em]">
              {g.sites.map((s) => {
                const problem = s.level === 'bad' || s.level === 'warn';
                const tile = (
                  <div
                    className={`rounded-lg border px-[0.4em] py-[0.2em] ${problem ? 'min-w-[9em]' : ''}`}
                    style={{
                      borderColor: problem ? LEVEL[s.level].color : 'rgba(255,255,255,0.12)',
                      background: problem ? `${LEVEL[s.level].color}22` : 'rgba(255,255,255,0.03)',
                    }}
                    data-site={s.name}
                    data-level={s.level}
                  >
                    <div className="flex items-center gap-[0.3em] whitespace-nowrap">
                      <LevelIcon level={s.level} size={mode === 'tv' ? 20 : 14} />
                      <span className={problem ? 'font-semibold' : 'text-[0.85em]'}>{s.name}</span>
                    </div>
                    {problem && (
                      <>
                        <div className="max-w-[16em] text-[0.7em] leading-snug text-slate-200">
                          {s.reason}
                        </div>
                        <div className="mt-[0.15em] flex flex-wrap gap-[0.2em]">
                          {s.roles.map((r) => (
                            <span
                              key={r.role}
                              className={`rounded border px-[0.25em] text-[0.6em] font-semibold ${ROLE_INK[r.level]}`}
                              title={`${r.role.replace(/_/g, ' ')}: ${r.down} of ${r.total} down`}
                            >
                              {r.level === 'bad' ? '✕ ' : r.level === 'warn' ? '! ' : ''}
                              {r.short}
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
                return mode === 'desktop' ? (
                  <Link key={s.id} href={`/sites/${s.code}`} className="hover:brightness-125">
                    {tile}
                  </Link>
                ) : (
                  <div key={s.id}>{tile}</div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </AutoFit>
  );
}

const FW: Record<string, { level: Level; text: string }> = {
  down: { level: 'bad', text: 'down' },
  unreachable: { level: 'bad', text: 'unreachable' },
  warning: { level: 'warn', text: 'warning' },
  up: { level: 'ok', text: 'up' },
  unknown: { level: 'unknown', text: 'unknown' },
  none: { level: 'unknown', text: 'none' },
};

export function Wan({ data, mode }: WidgetProps) {
  if (!data.wan.length) return <Empty>No firewalls at the sites on this board</Empty>;
  return (
    <AutoFit deps={data.wan} min={0.55}>
      <table className="w-full border-collapse text-left" data-testid="noc-wan">
        <thead className="text-[0.7em] uppercase tracking-wide text-slate-400">
          <tr>
            <th className="pb-[0.2em] pr-[0.6em] font-semibold">Site</th>
            <th className="pb-[0.2em] pr-[0.6em] font-semibold">Firewall</th>
            <th className="pb-[0.2em] pr-[0.6em] font-semibold">Latency · 24 h</th>
            <th className="pb-[0.2em] pr-[0.6em] font-semibold">Loss</th>
            <th className="pb-[0.2em] pr-[0.6em] font-semibold">WAN in</th>
            <th className="pb-[0.2em] pr-[0.6em] font-semibold">WAN out</th>
            <th className="pb-[0.2em] font-semibold">Busiest · 24 h</th>
          </tr>
        </thead>
        <tbody>
          {data.wan.map((r) => {
            const fw = FW[r.firewall] ?? FW.unknown!;
            const lossBad = (r.lossPct ?? 0) >= 5;
            return (
              <tr key={r.siteId} className="border-t border-white/5" data-site={r.siteName}>
                <td className="py-[0.12em] pr-[0.6em] font-semibold">
                  <To href={`/sites/${r.siteCode}`} mode={mode}>
                    {r.siteName}
                  </To>
                </td>
                <td className="py-[0.12em] pr-[0.6em] whitespace-nowrap">
                  <span className="inline-flex items-center gap-[0.3em]">
                    <LevelIcon level={fw.level} size={mode === 'tv' ? 20 : 14} />
                    {fw.text}
                    {mode === 'desktop' && r.firewallCaption && (
                      <span className="text-[0.8em] text-slate-400">{r.firewallCaption}</span>
                    )}
                  </span>
                </td>
                <td className="py-[0.12em] pr-[0.6em] whitespace-nowrap tabular-nums">
                  {r.latencyMs !== null ? `${r.latencyMs} ms ` : '— '}
                  <Sparkline
                    values={r.latencySeries}
                    label={`${r.siteName} latency, last 24 hours`}
                  />
                </td>
                <td
                  className={`py-[0.12em] pr-[0.6em] whitespace-nowrap tabular-nums ${lossBad ? 'font-semibold text-red-300' : ''}`}
                >
                  {r.lossPct !== null ? `${lossBad ? '✕ ' : ''}${r.lossPct}%` : '—'}
                </td>
                <td className="py-[0.12em] pr-[0.6em]">
                  <UtilBar pct={r.utilInPct} label={`${r.siteName} WAN in`} />
                </td>
                <td className="py-[0.12em] pr-[0.6em]">
                  <UtilBar pct={r.utilOutPct} label={`${r.siteName} WAN out`} />
                </td>
                <td className="py-[0.12em] whitespace-nowrap">
                  <Sparkline
                    values={r.utilSeries}
                    max={100}
                    label={`${r.siteName} WAN utilization, last 24 hours`}
                  />
                  {mode === 'desktop' && r.wanName && (
                    <span className="ml-[0.3em] text-[0.75em] text-slate-400">
                      {r.wanName}
                      {r.guessed ? ' (busiest)' : ''}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </AutoFit>
  );
}

function minutes(m: number | null): string {
  return m === null ? '—' : durationText(m * 60_000);
}

export function Kpis({ data, widget }: WidgetProps) {
  const k = data.kpis;
  if (!k) return null;
  const tiles: Array<{ label: string; value: string; sub: string; id: string }> = [
    {
      id: 'noise',
      label: 'Noise reduction',
      value: k.noiseRatio !== null ? `${k.noiseRatio} : 1` : '—',
      sub: `${k.alerts} alerts → ${k.opened} incidents`,
    },
    { id: 'opened', label: 'Opened', value: String(k.opened), sub: `${k.resolved} resolved` },
    { id: 'mtta', label: 'Time to acknowledge', value: minutes(k.mttaMin), sub: 'median' },
    { id: 'mttr', label: 'Time to fix', value: minutes(k.mttrMin), sub: 'median' },
  ];
  const compact = widget.w <= 4;
  const shown = compact ? tiles.filter((t) => t.id !== 'opened') : tiles;
  return (
    <AutoFit deps={k} min={0.6}>
      <div
        className={compact ? 'space-y-[0.3em]' : 'grid grid-cols-4 gap-[0.6em]'}
        data-testid="noc-kpis"
      >
        {shown.map((t) => (
          <div
            key={t.id}
            className={compact ? 'flex items-baseline justify-between gap-[0.5em]' : ''}
          >
            <div className="text-[0.75em] text-slate-300">{t.label}</div>
            <div
              className={`font-semibold tabular-nums ${compact ? '' : 'text-[1.8em] leading-tight'}`}
            >
              {t.value}
            </div>
            {!compact && <div className="text-[0.7em] text-slate-400">{t.sub} · 24 h</div>}
          </div>
        ))}
      </div>
    </AutoFit>
  );
}

export function AlertsChart({ data }: WidgetProps) {
  if (!data.chart.length) return null;
  return (
    <div className="flex h-full min-h-0 gap-[1em]" data-testid="noc-chart">
      <HourBars
        rows={data.chart}
        pick={(r) => r.alerts}
        name="Orion alerts"
        color={SERIES_COLORS[0]}
      />
      <HourBars
        rows={data.chart}
        pick={(r) => r.incidents}
        name="Incidents"
        color={SERIES_COLORS[1]}
      />
    </div>
  );
}

/** Rows a list widget shows: fewer rows rather than unreadably small text. */
const listRows = (h: number) => Math.max(2, h * 3 - 1);

export function Flapping({ data, mode, widget }: WidgetProps) {
  if (!data.flapping.length) return <Empty>No device changed state 3 or more times</Empty>;
  return (
    <AutoFit deps={data.flapping} min={0.8}>
      <ul className="space-y-[0.2em]" data-testid="noc-flapping">
        {data.flapping.slice(0, listRows(widget.h)).map((f) => (
          <li key={f.key} className="flex items-baseline justify-between gap-[0.6em]">
            <span className="truncate">
              {f.nodeId && mode === 'desktop' ? (
                <Link href={`/nodes/${f.nodeId}`} className="hover:underline">
                  {f.label}
                </Link>
              ) : (
                f.label
              )}
              {mode === 'desktop' && f.site && <span className="text-slate-400"> · {f.site}</span>}
            </span>
            <span className="shrink-0 tabular-nums">{f.changes} changes</span>
          </li>
        ))}
      </ul>
    </AutoFit>
  );
}

export function TopInterfaces({ data, mode, widget }: WidgetProps) {
  if (!data.interfaces.length) return <Empty>No interface traffic in the last hour</Empty>;
  return (
    <AutoFit deps={data.interfaces} min={0.8}>
      <ul className="space-y-[0.2em]" data-testid="noc-interfaces">
        {data.interfaces.slice(0, listRows(widget.h)).map((i) => (
          <li key={i.key} className="flex items-center justify-between gap-[0.6em]">
            <span className="truncate">
              {i.interfaceId && mode === 'desktop' ? (
                <Link href={`/interfaces/${i.interfaceId}`} className="hover:underline">
                  {i.label}
                </Link>
              ) : (
                i.label
              )}
              {mode === 'desktop' && i.site && <span className="text-slate-400"> · {i.site}</span>}
            </span>
            <UtilBar pct={i.util} label={i.label} />
          </li>
        ))}
      </ul>
    </AutoFit>
  );
}

export function NotifySummary({ data }: WidgetProps) {
  const n = data.notify;
  if (!n) return null;
  return (
    <div
      className="flex h-full flex-wrap items-center gap-x-[1.2em] gap-y-[0.2em]"
      data-testid="noc-notify"
    >
      <span>
        <span className="font-semibold tabular-nums">{n.pages}</span> page{n.pages === 1 ? '' : 's'}{' '}
        sent
      </span>
      <span>
        <span className="font-semibold tabular-nums">{n.escalations}</span> escalation
        {n.escalations === 1 ? '' : 's'}
      </span>
      <span>
        <span className="font-semibold tabular-nums">{n.suppressed}</span> held back
        {n.suppressedTop ? ` (mostly ${n.suppressedTop.replace(/_/g, ' ')})` : ''}
      </span>
      <span className="text-slate-400">last 24 h</span>
    </div>
  );
}

export const WIDGET_COMPONENTS: Record<BoardWidget['type'], (p: WidgetProps) => ReactNode> = {
  status_bar: StatusBar,
  priority_counts: PriorityCounts,
  incidents: Incidents,
  map: MapWidget,
  division_health: DivisionHealth,
  ticker: Ticker,
  site_matrix: SiteMatrix,
  wan: Wan,
  kpis: Kpis,
  alerts_chart: AlertsChart,
  flapping: Flapping,
  top_interfaces: TopInterfaces,
  notify_summary: NotifySummary,
};
