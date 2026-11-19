import Link from 'next/link';
import { notFound } from 'next/navigation';
import { siteHealth, type DeviceRole, type StatusNorm } from '@mercer/core';
import { getSiteDetail, siteGroupInfo } from '@mercer/db';
import { IncidentRows } from '@/components/incident-rows';
import { Shell } from '@/components/shell';
import { LevelIcon, NodeStatus, ROLE_LABEL, fmtTime, pct, ifaceLabel } from '@/components/status';
import { Badge, Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hours = (h: { days: number[]; start: string; end: string } | null) =>
  h ? `${h.days.map((d) => DAY[d]).join(', ')} ${h.start}–${h.end}` : '—';

const GROUPS: Array<{ title: string; roles: DeviceRole[] }> = [
  { title: 'Network', roles: ['firewall', 'router', 'core_switch', 'switch', 'access_point'] },
  { title: 'Scale systems', roles: ['scale_system'] },
  { title: 'Servers', roles: ['server'] },
  { title: 'UPS', roles: ['ups'] },
  { title: 'Other', roles: ['other'] },
];

export default async function SitePage({ params }: { params: Promise<{ code: string }> }) {
  const user = await requireUser('/sites');
  const code = decodeURIComponent((await params).code);
  const cfg = await effectiveConfig();
  const d = await getSiteDetail(server().db.db, code);
  const group = d ? (await siteGroupInfo(server().db.db, [d.site.id])).get(d.site.id) : undefined;
  if (!d) notFound();
  const s = d.site;
  const health = siteHealth(
    d.nodes.map((n) => ({
      statusNorm: n.statusNorm as StatusNorm,
      role: n.deviceRole as DeviceRole,
      unmanaged: n.unmanaged,
    })),
    d.incidents,
  );
  const notable = d.interfaces.filter(
    ({ iface }) =>
      iface.statusNorm !== 'up' ||
      (iface.inPercentUtil ?? 0) >= 80 ||
      (iface.outPercentUtil ?? 0) >= 80,
  );
  const open = d.incidents.filter((i) => i.status === 'open' || i.status === 'acknowledged');
  const recent = d.incidents.filter((i) => !(i.status === 'open' || i.status === 'acknowledged'));
  const withSite = (rows: typeof d.incidents) => rows.map((r) => ({ ...r, siteName: s.name }));

  return (
    <Shell user={user} wide>
      <nav className="text-sm text-slate-400">
        <Link href="/sites" className="hover:text-white">
          Sites
        </Link>{' '}
        / {s.name}
      </nav>
      <header className="mt-3 flex flex-wrap items-center gap-3">
        <LevelIcon level={health.level} size={28} />
        <div>
          <h1 className="text-2xl font-semibold">{s.name}</h1>
          <p className="text-sm text-slate-400">
            {health.reason} · {d.divisionName ?? 'No division'}
            {s.city ? ` · ${s.city}` : ''}
          </p>
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title={`Open incidents (${open.length})`}>
            <IncidentRows rows={withSite(open)} empty="Nothing open at this site." />
          </Card>
          {GROUPS.map((g) => {
            const nodes = d.nodes.filter((n) => g.roles.includes(n.deviceRole as DeviceRole));
            if (!nodes.length) return null;
            return (
              <Card key={g.title} title={`${g.title} (${nodes.length})`}>
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-400">
                    <tr>
                      <th className="py-2">Device</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th className="text-right">Response</th>
                      <th className="text-right">Loss</th>
                      <th className="text-right">CPU</th>
                      <th className="text-right">Memory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodes.map((n) => (
                      <tr key={n.nodeId} className="border-t border-white/5">
                        <td className="py-1.5">
                          <Link
                            href={`/nodes/${n.nodeId}`}
                            className="text-sky-300 hover:underline"
                          >
                            {n.caption}
                          </Link>
                          {n.ipAddress && (
                            <span className="ml-2 font-mono text-xs text-slate-500">
                              {n.ipAddress}
                            </span>
                          )}
                        </td>
                        <td className="text-slate-400">
                          {ROLE_LABEL[n.deviceRole] ?? n.deviceRole}
                        </td>
                        <td>
                          <NodeStatus status={n.unmanaged ? 'unmanaged' : n.statusNorm} />
                        </td>
                        <td className="text-right tabular-nums">
                          {n.responseTimeMs !== null ? `${Math.round(n.responseTimeMs)} ms` : '—'}
                        </td>
                        <td className="text-right tabular-nums">{pct(n.percentLoss)}</td>
                        <td className="text-right tabular-nums">{pct(n.cpuLoad)}</td>
                        <td className="text-right tabular-nums">{pct(n.percentMemoryUsed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            );
          })}
          <Card
            title={`Interfaces needing attention (${notable.length})`}
            description={`Down, or above 80% utilisation. ${d.interfaces.length} interfaces monitored at this site.`}
          >
            {notable.length === 0 ? (
              <p className="text-sm text-slate-400">All interfaces up and below 80%.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-400">
                  <tr>
                    <th className="py-2">Interface</th>
                    <th>Status</th>
                    <th className="text-right">In</th>
                    <th className="text-right">Out</th>
                  </tr>
                </thead>
                <tbody>
                  {notable.map(({ iface, nodeCaption }) => (
                    <tr key={iface.interfaceId} className="border-t border-white/5">
                      <td className="py-1.5">
                        <Link
                          href={`/interfaces/${iface.interfaceId}`}
                          className="text-sky-300 hover:underline"
                        >
                          {nodeCaption} · {ifaceLabel(iface)}
                        </Link>
                      </td>
                      <td>
                        <NodeStatus status={iface.statusNorm} />
                      </td>
                      <td className="text-right tabular-nums">{pct(iface.inPercentUtil)}</td>
                      <td className="text-right tabular-nums">{pct(iface.outPercentUtil)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Recent incidents (30 days)">
            <IncidentRows
              rows={withSite(recent)}
              empty="No resolved incidents in the last 30 days."
            />
          </Card>
        </div>

        <Card title="Site Profile">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-400">Division</dt>
            <dd>{d.divisionName ?? '—'}</dd>
            <dt className="text-slate-400">Tier</dt>
            <dd className="capitalize">{s.tier}</dd>
            <dt className="text-slate-400">Harvest-critical</dt>
            <dd>{s.harvestCritical ? <Badge tone="warn">yes</Badge> : 'no'}</dd>
            <dt className="text-slate-400">Business hours</dt>
            <dd>{hours(s.businessHours)}</dd>
            {s.harvestHours && (
              <>
                <dt className="text-slate-400">Harvest hours</dt>
                <dd>{hours(s.harvestHours)}</dd>
              </>
            )}
            <dt className="text-slate-400">Owner group</dt>
            <dd>{s.ownerGroup ?? '—'}</dd>
            <dt className="text-slate-400">Active alerts</dt>
            <dd>{d.activeAlertCount}</dd>
            <dt className="text-slate-400">Profile</dt>
            <dd className="text-slate-400">
              {s.profileStatus} · updated {fmtTime(s.updatedAt, cfg.timezone)}
            </dd>
          </dl>
          {group ? (
            <div className="mt-4" data-testid="site-notes">
              <p className="whitespace-pre-wrap text-sm text-slate-300">
                {group.description?.trim() || 'No notes yet.'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                From SolarWinds: the description of the group “{group.groupName ?? 'missing'}”.
              </p>
            </div>
          ) : (
            s.contactNotes && (
              <p className="mt-4 whitespace-pre-wrap text-sm text-slate-300">{s.contactNotes}</p>
            )
          )}
          {user.isAdmin && (
            <p className="mt-4 text-sm">
              <Link href="/settings/sites" className="text-sky-300 hover:underline">
                Edit Site Profiles →
              </Link>
            </p>
          )}
        </Card>
      </div>
    </Shell>
  );
}
