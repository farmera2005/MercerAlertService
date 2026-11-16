import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getInterfaceDetail, interfaceMetricSeries } from '@mercer/db';
import { MetricChart, SERIES_COLORS } from '@/components/metric-chart';
import { RangeTabs, parseRange } from '@/components/range-tabs';
import { Shell } from '@/components/shell';
import { NodeStatus, bps, fmtTime, pct, ifaceLabel } from '@/components/status';
import { Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export default async function InterfacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await requireUser('/sites');
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const range = parseRange((await searchParams).range);
  const tz = (await effectiveConfig()).timezone;
  const { db } = server();
  const [d, series] = await Promise.all([
    getInterfaceDetail(db.db, id),
    interfaceMetricSeries(db.db, id, range),
  ]);
  if (!d) notFound();
  const i = d.iface;
  const points = series.map((p) => ({
    t: p.t.getTime(),
    in: p.inAvg,
    out: p.outAvg,
    errors: p.errors,
    discards: p.discards,
  }));
  const long = range !== '24h';
  return (
    <Shell user={user} wide>
      <nav className="text-sm text-slate-400">
        {d.site && (
          <>
            <Link href={`/sites/${encodeURIComponent(d.site.code)}`} className="hover:text-white">
              {d.site.name}
            </Link>
            {' / '}
          </>
        )}
        <Link href={`/nodes/${d.node.nodeId}`} className="hover:text-white">
          {d.node.caption}
        </Link>{' '}
        / {ifaceLabel(i)}
      </nav>
      <header className="mt-3 flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-semibold">
          {d.node.caption} · {ifaceLabel(i)}
        </h1>
        <NodeStatus status={i.statusNorm} />
      </header>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Traffic</h2>
            <RangeTabs base={`/interfaces/${id}`} current={range} />
          </div>
          <Card>
            <MetricChart
              title="Utilisation"
              unit="%"
              tz={tz}
              longRange={long}
              yMax={100}
              height={260}
              data={points}
              series={[
                { key: 'in', label: 'In', color: SERIES_COLORS[0] },
                { key: 'out', label: 'Out', color: SERIES_COLORS[1] },
              ]}
            />
            <div className="mt-8">
              <MetricChart
                title="Errors and discards (per hour)"
                unit=""
                tz={tz}
                longRange={long}
                data={points}
                series={[
                  { key: 'errors', label: 'Errors', color: SERIES_COLORS[0] },
                  { key: 'discards', label: 'Discards', color: SERIES_COLORS[1] },
                ]}
              />
            </div>
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
        <Card title="Interface">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-400">Name</dt>
            <dd>{i.fullName ?? i.name ?? '—'}</dd>
            <dt className="text-slate-400">Alias</dt>
            <dd>{i.alias ?? '—'}</dd>
            <dt className="text-slate-400">Type</dt>
            <dd>{i.typeDescription ?? '—'}</dd>
            <dt className="text-slate-400">Speed</dt>
            <dd>{bps(i.speedBps)}</dd>
            <dt className="text-slate-400">Now</dt>
            <dd>
              in {pct(i.inPercentUtil)} ({bps(i.inBps)}) · out {pct(i.outPercentUtil)} (
              {bps(i.outBps)})
            </dd>
            <dt className="text-slate-400">Errors / h</dt>
            <dd>
              {i.inErrorsHour ?? '—'} in · {i.outErrorsHour ?? '—'} out
            </dd>
            <dt className="text-slate-400">Discards / h</dt>
            <dd>
              {i.inDiscardsHour ?? '—'} in · {i.outDiscardsHour ?? '—'} out
            </dd>
            <dt className="text-slate-400">Last change</dt>
            <dd>{fmtTime(i.lastStatusChangeAt, tz)}</dd>
          </dl>
        </Card>
      </div>
    </Shell>
  );
}
