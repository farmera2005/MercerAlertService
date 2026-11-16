/**
 * Status vocabulary shared by the dashboard and the wall. Colours are the fixed status palette
 * (good / warning / serious / critical) and always come with an icon and a text label, never
 * colour alone. No server-only imports: usable from client components too.
 */
import type { ReactNode } from 'react';

export type Level = 'ok' | 'warn' | 'bad' | 'maintenance' | 'unknown';

export const LEVEL: Record<Level, { color: string; ink: string; icon: string; label: string }> = {
  ok: { color: '#0ca30c', ink: '#ffffff', icon: '✓', label: 'OK' },
  warn: { color: '#fab219', ink: '#0b0b0b', icon: '!', label: 'Degraded' },
  bad: { color: '#d03b3b', ink: '#ffffff', icon: '✕', label: 'Down' },
  maintenance: { color: '#3987e5', ink: '#ffffff', icon: '⏸', label: 'Maintenance' },
  unknown: { color: '#898781', ink: '#0b0b0b', icon: '?', label: 'Unknown' },
};

export function LevelIcon({ level, size = 18 }: { level: Level; size?: number }) {
  const l = LEVEL[level];
  return (
    <span
      role="img"
      aria-label={l.label}
      title={l.label}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none"
      style={{
        width: size,
        height: size,
        background: l.color,
        color: l.ink,
        fontSize: Math.round(size * 0.62),
      }}
    >
      {l.icon}
    </span>
  );
}

// White on the serious orange is 2.6:1; near-black keeps P2/P3 badges at WCAG AA.
export const PRIORITY: Record<string, { bg: string; ink: string; label: string }> = {
  P1: { bg: '#d03b3b', ink: '#ffffff', label: 'P1 critical' },
  P2: { bg: '#ec835a', ink: '#0b0b0b', label: 'P2 high' },
  P3: { bg: '#fab219', ink: '#0b0b0b', label: 'P3 medium' },
  P4: { bg: '#475569', ink: '#ffffff', label: 'P4 low' },
};

export function PriorityBadge({ p, size = 'sm' }: { p: string; size?: 'sm' | 'lg' | 'wall' }) {
  const s = PRIORITY[p] ?? PRIORITY.P4!;
  const cls =
    size === 'wall'
      ? 'px-4 py-1 text-[32px] rounded-lg'
      : size === 'lg'
        ? 'px-3 py-1 text-base rounded-md'
        : 'px-2 py-0.5 text-xs rounded';
  return (
    <span
      className={`inline-block shrink-0 font-bold tabular-nums ${cls}`}
      style={{ background: s.bg, color: s.ink }}
      title={s.label}
    >
      {p}
    </span>
  );
}

const INCIDENT_STATUS: Record<string, { cls: string; label: string }> = {
  open: { cls: 'bg-red-500/15 text-red-200 ring-red-400/40', label: 'Open' },
  acknowledged: { cls: 'bg-sky-500/15 text-sky-200 ring-sky-400/40', label: 'Acknowledged' },
  resolved: { cls: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/40', label: 'Resolved' },
  closed: { cls: 'bg-white/5 text-slate-300 ring-white/15', label: 'Closed' },
};

export function IncidentStatusBadge({ status }: { status: string }) {
  const s = INCIDENT_STATUS[status] ?? INCIDENT_STATUS.closed!;
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

const NODE_LEVEL: Record<string, Level> = {
  up: 'ok',
  down: 'bad',
  critical: 'bad',
  unreachable: 'bad',
  warning: 'warn',
  shutdown: 'warn',
  unplugged: 'warn',
  unmanaged: 'maintenance',
  unknown: 'unknown',
  other: 'unknown',
};

export function nodeLevel(statusNorm: string): Level {
  return NODE_LEVEL[statusNorm] ?? 'unknown';
}

export function NodeStatus({ status, label }: { status: string; label?: ReactNode }) {
  const level = nodeLevel(status);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <LevelIcon level={level} size={14} />
      <span className="capitalize">{label ?? status}</span>
    </span>
  );
}

export const ROLE_LABEL: Record<string, string> = {
  firewall: 'Firewall',
  core_switch: 'Core switch',
  switch: 'Switch',
  router: 'Router',
  access_point: 'Access point',
  server: 'Server',
  scale_system: 'Scale system',
  ups: 'UPS',
  other: 'Other',
};

export const KIND_LABEL: Record<string, string> = {
  site_outage: 'Site outage',
  device_down: 'Device down',
  flapping: 'Flapping',
  interface: 'Interface',
  ups_power: 'UPS / power',
  service: 'Service',
  monitoring_source_down: 'Monitoring down',
  generic: 'Other',
};

export function fmtTime(d: Date | string | null | undefined, tz: string, withDate = true): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('en-US', {
    timeZone: tz,
    ...(withDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function pct(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`;
}

export function bps(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let i = 0;
  let x = v;
  while (x >= 1000 && i < units.length - 1) {
    x /= 1000;
    i++;
  }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
}

/** Orion's interface Caption often repeats the node name; the ifName alone reads better after it. */
export function ifaceLabel(i: {
  name: string | null;
  caption: string | null;
  interfaceId: number;
}): string {
  return i.name ?? i.caption ?? `Interface ${i.interfaceId}`;
}
