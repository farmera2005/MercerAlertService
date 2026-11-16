import Link from 'next/link';
import { INCIDENT_KINDS, PRIORITIES, type IncidentKind, type Priority } from '@mercer/core';
import {
  INCIDENT_STATUS_FILTERS,
  listDivisions,
  listSites,
  searchIncidents,
  type IncidentStatusFilter,
} from '@mercer/db';
import { IncidentRows } from '@/components/incident-rows';
import { Shell } from '@/components/shell';
import { KIND_LABEL } from '@/components/status';
import { Button, Card, Input, Select } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { server } from '@/lib/server';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

const RANGES: Record<string, { label: string; ms: number | null }> = {
  '': { label: 'Any time', ms: null },
  '24h': { label: 'Last 24 hours', ms: 86_400_000 },
  '7d': { label: 'Last 7 days', ms: 7 * 86_400_000 },
  '30d': { label: 'Last 30 days', ms: 30 * 86_400_000 },
  '90d': { label: 'Last 90 days', ms: 90 * 86_400_000 },
};
const STATUS_LABEL: Record<IncidentStatusFilter, string> = {
  active: 'Open & acknowledged',
  resolved: 'Resolved',
  closed: 'Closed',
  all: 'All',
};

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireUser('/incidents');
  const sp = await searchParams;
  const status = (INCIDENT_STATUS_FILTERS as readonly string[]).includes(one(sp.status))
    ? (one(sp.status) as IncidentStatusFilter)
    : 'active';
  const priorities = many(sp.priority).filter((p): p is Priority =>
    (PRIORITIES as readonly string[]).includes(p),
  );
  const kind = (INCIDENT_KINDS as readonly string[]).includes(one(sp.kind))
    ? (one(sp.kind) as IncidentKind)
    : undefined;
  const range = one(sp.range) in RANGES ? one(sp.range) : '';
  const siteId = Number(one(sp.site)) || undefined;
  const division = one(sp.division) || undefined;
  const q = one(sp.q).slice(0, 100);
  const beforeId = Number(one(sp.before)) || undefined;
  const ms = RANGES[range]!.ms;

  const { db } = server();
  const [result, sites, divisions] = await Promise.all([
    searchIncidents(db.db, {
      status,
      priorities,
      kind,
      siteId,
      division,
      q,
      since: ms ? new Date(Date.now() - ms) : undefined,
      beforeId,
      limit: 50,
    }),
    listSites(db.db),
    listDivisions(db.db),
  ]);

  const older = new URLSearchParams();
  for (const [k, v] of Object.entries(sp))
    for (const x of many(v)) if (k !== 'before') older.append(k, x);
  if (result.nextBeforeId) older.set('before', String(result.nextBeforeId));

  return (
    <Shell user={user} wide>
      <h1 className="text-2xl font-semibold">Incidents</h1>
      <form
        method="get"
        className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4"
        aria-label="Filter incidents"
      >
        <label className="text-xs text-slate-400">
          Status
          <Select name="status" defaultValue={status} className="mt-1 w-44">
            {INCIDENT_STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-slate-400">
          Opened
          <Select name="range" defaultValue={range} className="mt-1 w-40">
            {Object.entries(RANGES).map(([k, r]) => (
              <option key={k} value={k}>
                {r.label}
              </option>
            ))}
          </Select>
        </label>
        <fieldset className="text-xs text-slate-400">
          <legend>Priority</legend>
          <div className="mt-1 flex gap-1">
            {PRIORITIES.map((p) => (
              <label
                key={p}
                className="flex cursor-pointer items-center gap-1 rounded-md border border-white/15 px-2 py-2 text-sm text-slate-200 has-[:checked]:border-sky-400 has-[:checked]:bg-sky-500/10"
              >
                <input
                  type="checkbox"
                  name="priority"
                  value={p}
                  defaultChecked={priorities.includes(p)}
                  className="accent-sky-400"
                />
                {p}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-xs text-slate-400">
          Division
          <Select name="division" defaultValue={division ?? ''} className="mt-1 w-40">
            <option value="">All divisions</option>
            {divisions.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-slate-400">
          Site
          <Select name="site" defaultValue={siteId ? String(siteId) : ''} className="mt-1 w-48">
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-slate-400">
          Kind
          <Select name="kind" defaultValue={kind ?? ''} className="mt-1 w-40">
            <option value="">Any kind</option>
            {INCIDENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k] ?? k}
              </option>
            ))}
          </Select>
        </label>
        <label className="min-w-48 flex-1 text-xs text-slate-400">
          Search
          <Input name="q" defaultValue={q} placeholder="Title or INC-1234" className="mt-1" />
        </label>
        <div className="flex gap-2">
          <Button type="submit">Apply</Button>
          <Link
            href="/incidents"
            className="rounded-md px-3 py-2 text-sm text-slate-400 hover:text-white"
          >
            Reset
          </Link>
        </div>
      </form>

      <Card
        className="mt-6"
        title={`${result.rows.length}${result.nextBeforeId ? '+' : ''} incident${result.rows.length === 1 ? '' : 's'}`}
      >
        <IncidentRows rows={result.rows} empty="No incidents match these filters." />
        {result.nextBeforeId && (
          <div className="mt-4 text-right">
            <Link href={`/incidents?${older}`} className="text-sm text-sky-300 hover:underline">
              Older incidents →
            </Link>
          </div>
        )}
      </Card>
    </Shell>
  );
}
