import Link from 'next/link';
import { displayTitle, shortSummary } from '@mercer/core';
import type { IncidentListItem, OverviewIncident } from '@mercer/db';
import { Ago } from './live';
import { IncidentStatusBadge, KIND_LABEL, PriorityBadge } from './status';
import { Badge } from './ui';

type Row = (IncidentListItem | OverviewIncident) & { divisionName?: string | null };

/** Compact incident rows (overview, incident list, site page). */
export function IncidentRows({ rows, empty }: { rows: Row[]; empty: string }) {
  if (rows.length === 0) return <p className="py-2 text-sm text-slate-400">{empty}</p>;
  const now = Date.now();
  return (
    <ul className="divide-y divide-white/5" data-testid="incident-rows">
      {rows.map((i) => {
        const open = i.status === 'open' || i.status === 'acknowledged';
        const title = displayTitle(i);
        const snoozed = i.snoozedUntil && i.snoozedUntil.getTime() > now;
        return (
          <li key={i.id}>
            <Link
              href={`/incidents/${i.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2.5 hover:bg-white/[0.04]"
            >
              <PriorityBadge p={i.priority} />
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate ${open ? 'font-medium text-slate-100' : 'text-slate-400'}`}
                >
                  {title}
                </span>
                <span className="block truncate text-xs text-slate-400">
                  {shortSummary(i, 140)}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs">
                <IncidentStatusBadge status={i.status} />
                {snoozed && <Badge tone="info">snoozed</Badge>}
                {i.inMaintenance && <Badge tone="info">maintenance</Badge>}
                {i.seeded && <Badge>pre-existing</Badge>}
                <span className="text-slate-500">{KIND_LABEL[i.kind] ?? i.kind}</span>
                <span className="text-slate-500">
                  INC-{i.id} · {i.alertCount} alert{i.alertCount === 1 ? '' : 's'} ·{' '}
                  <Ago at={i.openedAt.getTime()} />
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
