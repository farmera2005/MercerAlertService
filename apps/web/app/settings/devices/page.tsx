import Link from 'next/link';
import { DEVICE_ROLES } from '@mercer/core';
import { deviceCounts, listDevicesForAdmin, listSites, type DeviceFilter } from '@mercer/db';
import { DeviceOverrideForm } from '@/components/admin-panels';
import { NodeStatus, ROLE_LABEL } from '@/components/status';
import { Badge, Button, Card, Input } from '@/components/ui';
import { server } from '@/lib/server';

export const dynamic = 'force-dynamic';

const SOURCE: Record<string, { label: string; tone: 'ok' | 'info' | 'warn' | 'bad' }> = {
  override: { label: 'override', tone: 'info' },
  custom_property: { label: 'Orion property', tone: 'ok' },
  caption: { label: 'from hostname', tone: 'warn' },
  none: { label: 'no site', tone: 'bad' },
};

const FILTERS: Array<[DeviceFilter, string]> = [
  ['unmapped', 'No site'],
  ['overridden', 'Overridden'],
  ['all', 'All devices'],
];

export default async function DevicesSettings({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const db = server().db.db;
  const counts = await deviceCounts(db);
  const filter: DeviceFilter = FILTERS.some(([k]) => k === sp.filter)
    ? (sp.filter as DeviceFilter)
    : counts.unmapped > 0
      ? 'unmapped'
      : 'all';
  const q = (sp.q ?? '').slice(0, 80);
  const [rows, sites] = await Promise.all([
    listDevicesForAdmin(db, { filter, q, limit: 200 }),
    listSites(db),
  ]);
  const siteOptions = sites.map((s) => ({ id: s.id, name: s.name }));
  const roles = DEVICE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }));
  const link = (f: DeviceFilter) =>
    `/settings/devices?filter=${f}${q ? `&q=${encodeURIComponent(q)}` : ''}`;

  return (
    <div className="space-y-6">
      <Card
        title="Devices"
        description="Each Orion node is placed at a site from its custom properties, or failing that its hostname. Pin a node to the right site or role here when Orion's data is missing or wrong. Changes apply at the next node poll."
      >
        <dl className="grid gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-slate-400">Monitored devices</dt>
            <dd className="text-2xl font-semibold tabular-nums">{counts.total}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Without a site</dt>
            <dd className="text-2xl font-semibold tabular-nums" data-testid="unmapped-count">
              {counts.unmapped}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Role “other”</dt>
            <dd className="text-2xl font-semibold tabular-nums">{counts.roleOther}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Overrides</dt>
            <dd className="text-2xl font-semibold tabular-nums">{counts.overridden}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-slate-400">
          Devices without a site never make a site outage and are not on the map. If many are
          missing, check the property names in{' '}
          <Link href="/settings/mapping" className="underline">
            Mapping
          </Link>{' '}
          first.
        </p>
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <nav className="flex gap-1 text-sm" aria-label="Device filter">
          {FILTERS.map(([k, label]) => (
            <Link
              key={k}
              href={link(k)}
              aria-current={k === filter ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 ${k === filter ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form method="get" className="flex gap-2">
          <input type="hidden" name="filter" value={filter} />
          <Input name="q" defaultValue={q} placeholder="Hostname or site" aria-label="Search" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">No devices match.</p>
      ) : (
        <ul
          className="divide-y divide-white/10 rounded-xl border border-white/10"
          data-testid="devices"
        >
          {rows.map((r) => {
            const src = SOURCE[r.siteSource] ?? SOURCE.none!;
            const ov = r.override ?? {
              siteId: null,
              deviceRole: null,
              reason: null,
              updatedBy: null,
            };
            const pending =
              (ov.siteId !== null && ov.siteId !== r.siteId) ||
              (ov.deviceRole !== null && ov.deviceRole !== r.role);
            return (
              <li key={r.nodeId} className="space-y-3 p-4" data-testid={`device-${r.caption}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link
                    href={`/nodes/${r.nodeId}`}
                    className="font-medium text-sky-300 hover:underline"
                  >
                    {r.caption}
                  </Link>
                  <NodeStatus status={r.status} />
                  <span className="text-slate-300">{r.siteName ?? 'No site'}</span>
                  <Badge tone={src.tone}>{src.label}</Badge>
                  <span className="text-slate-400">{ROLE_LABEL[r.role] ?? r.role}</span>
                  {pending && <Badge tone="warn">applies at next poll</Badge>}
                </div>
                <details className="rounded-lg border border-white/10 p-3 open:bg-white/[0.02]">
                  <summary className="cursor-pointer text-sm text-slate-300">
                    {ov.siteId !== null || ov.deviceRole !== null
                      ? `Override (by ${ov.updatedBy ?? 'someone'})`
                      : 'Override'}
                  </summary>
                  <div className="mt-3">
                    <DeviceOverrideForm
                      o={{
                        nodeId: r.nodeId,
                        siteId: ov.siteId,
                        role: ov.deviceRole,
                        reason: ov.reason,
                      }}
                      sites={siteOptions}
                      roles={roles}
                    />
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
