import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getNodeDetail, nodeMetricSeries } from '@mercer/db';
import { MetricChart, SERIES_COLORS } from '@/components/metric-chart';
import { RangeTabs, parseRange } from '@/components/range-tabs';
import { Shell } from '@/components/shell';
import {
  NodeStatus,
  PriorityBadge,
  ROLE_LABEL,
  bps,
  fmtTime,
  pct,
  ifaceLabel,
} from '@/components/status';
import { Badge, Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function NodePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await requireUser('/sites');
  const nodeId = Number((await params).id);
  if (!Number.isInteger(nodeId)) notFound();
  const range = parseRange((await searchParams).range);
  const cfg = await effectiveConfig();
  const tz = cfg.timezone;
  const { db } = server();
  const [d, series] = await Promise.all([
    getNodeDetail(db.db, nodeId),
    nodeMetricSeries(db.db, nodeId, range),
  ]);
  if (!d) notFound();
  const n = d.node;
  const points = series.map((p) => ({
    t: p.t.getTime(),
    rt: p.rtAvg,
    loss: p.lossAvg,
    cpu: p.cpuAvg,
    mem: p.memAvg,
  }));
  const long = range !== '24h';

  return (
    <Shell user={user} wide>
      <nav className="text-sm text-slate-400">
        <Link href="/sites" className="hover:text-white">
          Sites
        </Link>
        {d.site && (
          <>
            {' / '}
            <Link href={`/sites/${encodeURIComponent(d.site.code)}`} className="hover:text-white">
              {d.site.name}
            </Link>
          </>
        )}{' '}
        / {n.caption}
      </nav>
      <header className="mt-3 flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-semibold">{n.caption}</h1>
        <NodeStatus
          status={n.unmanaged ? 'unmanaged' : n.statusNorm}
          label={n.statusDescription ?? undefined}
        />
        {n.removedAt && <Badge tone="warn">no longer in Orion</Badge>}
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Performance</h2>
            <RangeTabs base={`/nodes/${nodeId}`} current={range} />
          </div>
          <Card>
            <div className="grid gap-8 md:grid-cols-2">
              <MetricChart
                title="Response time"
                unit="ms"
                tz={tz}
                longRange={long}
                data={points}
                series={[{ key: 'rt', label: 'Response time', color: SERIES_COLORS[0] }]}
              />
              <MetricChart
                title="Packet loss"
                unit="%"
                tz={tz}
                longRange={long}
                yMax={100}
                data={points}
                series={[{ key: 'loss', label: 'Packet loss', color: SERIES_COLORS[0] }]}
              />
            </div>
            <div className="mt-8">
              <MetricChart
                title="CPU and memory"
                unit="%"
                tz={tz}
                longRange={long}
                yMax={100}
                data={points}
                series={[
                  { key: 'cpu', label: 'CPU', color: SERIES_COLORS[0] },
                  { key: 'mem', label: 'Memory', color: SERIES_COLORS[1] },
                ]}
              />
            </div>
          </Card>

          <Card title={`Interfaces (${d.interfaces.length})`}>
            {d.interfaces.length === 0 ? (
              <p className="text-sm text-slate-400">No interfaces monitored on this device.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-400">
                  <tr>
                    <th className="py-2">Interface</th>
                    <th>Status</th>
                    <th className="text-right">In</th>
                    <th className="text-right">Out</th>
                    <th className="text-right">Speed</th>
                  </tr>
                </thead>
                <tbody>
                  {d.interfaces.map((i) => (
                    <tr key={i.interfaceId} className="border-t border-white/5">
                      <td className="py-1.5">
                        <Link
                          href={`/interfaces/${i.interfaceId}`}
                          className="text-sky-300 hover:underline"
                        >
                          {ifaceLabel(i)}
                        </Link>
                        {i.alias && <span className="ml-2 text-xs text-slate-500">{i.alias}</span>}
                      </td>
                      <td>
                        <NodeStatus status={i.statusNorm} />
                      </td>
                      <td className="text-right tabular-nums">{pct(i.inPercentUtil)}</td>
                      <td className="text-right tabular-nums">{pct(i.outPercentUtil)}</td>
                      <td className="text-right tabular-nums text-slate-400">{bps(i.speedBps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Status history (30 days)">
            {d.history.length === 0 ? (
              <p className="text-sm text-slate-400">No status changes recorded.</p>
            ) : (
              <ol className="space-y-1 text-sm">
                {d.history.map((h) => (
                  <li key={h.id} className="flex gap-3">
                    <span className="w-32 shrink-0 font-mono text-xs tabular-nums text-slate-500">
                      {fmtTime(h.observedAt, tz)}
                    </span>
                    <span>
                      {h.fromState ?? 'unknown'} → <NodeStatus status={h.toState} />
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Device">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-400">Role</dt>
              <dd>{ROLE_LABEL[n.deviceRole] ?? n.deviceRole}</dd>
              <dt className="text-slate-400">IP address</dt>
              <dd className="font-mono">{n.ipAddress ?? '—'}</dd>
              <dt className="text-slate-400">Vendor</dt>
              <dd>{n.vendor ?? '—'}</dd>
              <dt className="text-slate-400">Model</dt>
              <dd>{n.machineType ?? '—'}</dd>
              <dt className="text-slate-400">Last boot</dt>
              <dd>{fmtTime(n.lastBoot, tz)}</dd>
              <dt className="text-slate-400">Response</dt>
              <dd>
                {n.responseTimeMs !== null ? `${Math.round(n.responseTimeMs)} ms` : '—'} · loss{' '}
                {pct(n.percentLoss)}
              </dd>
              <dt className="text-slate-400">CPU / memory</dt>
              <dd>
                {pct(n.cpuLoad)} / {pct(n.percentMemoryUsed)}
              </dd>
              <dt className="text-slate-400">Orion node ID</dt>
              <dd>{n.nodeId}</dd>
              <dt className="text-slate-400">Site from</dt>
              <dd className="text-slate-400">{n.siteSource}</dd>
            </dl>
          </Card>
          <Card title={`Active Orion alerts (${d.activeAlerts.length})`}>
            {d.activeAlerts.length === 0 ? (
              <p className="text-sm text-slate-400">None.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.activeAlerts.map((a) => (
                  <li key={a.alertActiveId}>
                    <div className="text-slate-200">{a.alertName}</div>
                    <div className="text-xs text-slate-400">
                      {a.entityCaption} · since {fmtTime(a.triggeredAt, tz)}
                      {a.acknowledged ? ` · acknowledged by ${a.acknowledgedBy ?? 'someone'}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Incidents (30 days)">
            {d.incidents.length === 0 ? (
              <p className="text-sm text-slate-400">None.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.incidents.map((i) => (
                  <li key={i.id} className="flex items-center gap-2">
                    <PriorityBadge p={i.priority} />
                    <Link
                      href={`/incidents/${i.id}`}
                      className="min-w-0 truncate text-sky-300 hover:underline"
                    >
                      {i.aiTitle ?? i.title}
                    </Link>
                    <span className="ml-auto shrink-0 text-xs text-slate-500">
                      {fmtTime(i.openedAt, tz)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </Shell>
  );
}
