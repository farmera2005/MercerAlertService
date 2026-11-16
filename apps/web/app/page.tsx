import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listIncidents, noiseStats, openIncidentCounts } from '@mercer/db';
import { Shell } from '@/components/shell';
import { Alert, Badge, Card } from '@/components/ui';
import { server } from '@/lib/server';
import { requireAdmin } from '@/lib/auth';
import { getHealth } from '@/lib/health';
import { getSettingsState } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const tone = (ok: boolean) => (ok ? 'text-emerald-400' : 'text-red-400');

const PRIORITY_STYLE: Record<string, string> = {
  P1: 'bg-red-500 text-white',
  P2: 'bg-orange-500 text-slate-950',
  P3: 'bg-amber-300 text-slate-950',
  P4: 'bg-slate-600 text-slate-100',
};

function since(d: Date): string {
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Operational status + correlated incidents. The full dashboard (sites, map, SSE) arrives in Milestone 3. */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const user = await requireAdmin('/');
  const state = await getSettingsState();
  if (!state.cfg?.setupComplete) redirect('/setup/orion');
  const { report } = await getHealth();
  const { welcome } = await searchParams;
  const { db } = server();
  const now = Date.now();
  const [noise24, noise7, counts, incidents] = await Promise.all([
    noiseStats(db.db, new Date(now - 86_400_000)),
    noiseStats(db.db, new Date(now - 7 * 86_400_000)),
    openIncidentCounts(db.db),
    listIncidents(db.db, { limit: 40 }),
  ]);
  const tz = state.cfg!.timezone;
  return (
    <Shell user={user.username}>
      {welcome && (
        <div className="mb-6">
          <Alert tone="success" title="Monitoring started">
            The worker begins polling SolarWinds within a few seconds. This page shows its progress.
          </Alert>
        </div>
      )}
      <h1 className="text-2xl font-semibold">Status</h1>
      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-sm text-slate-400">Database</div>
          <div className={`text-2xl font-semibold ${tone(report.db === 'ok')}`}>{report.db}</div>
        </Card>
        <Card>
          <div className="text-sm text-slate-400">Worker</div>
          <div className={`text-2xl font-semibold ${tone(report.worker.status === 'ok')}`}>
            {report.worker.status}
          </div>
          {report.worker.ageSec !== null && (
            <div className="text-sm text-slate-400">heartbeat {report.worker.ageSec}s ago</div>
          )}
        </Card>
        <Card>
          <div className="text-sm text-slate-400">SolarWinds (SWIS)</div>
          <div className={`text-2xl font-semibold ${tone(report.swis.status === 'up')}`}>
            {report.swis.status}
          </div>
          {report.swis.tlsVerification === 'DISABLED' && (
            <div className="text-sm text-red-400">TLS verification disabled</div>
          )}
        </Card>
      </section>
      <section className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => (
          <Card key={p}>
            <div className="flex items-center justify-between">
              <span className={`rounded px-2 py-0.5 text-sm font-bold ${PRIORITY_STYLE[p]}`}>
                {p}
              </span>
              <span className="text-3xl font-semibold">{counts[p]}</span>
            </div>
            <div className="mt-1 text-sm text-slate-400">open incidents</div>
          </Card>
        ))}
      </section>

      <Card
        className="mt-6"
        title="Noise reduction"
        description="Raw Orion alert raises per incident opened — the headline success metric (pre-existing alerts at startup excluded)."
      >
        <div className="grid grid-cols-2 gap-6">
          {[
            ['Last 24 hours', noise24],
            ['Last 7 days', noise7],
          ].map(([label, n]) => {
            const s = n as typeof noise24;
            return (
              <div key={label as string}>
                <div className="text-sm text-slate-400">{label as string}</div>
                <div className="text-3xl font-semibold">
                  {s.ratio !== null ? `${s.ratio} : 1` : '—'}
                </div>
                <div className="text-sm text-slate-400">
                  {s.rawAlerts} alerts → {s.incidents} incident{s.incidents === 1 ? '' : 's'}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        className="mt-6"
        title="Incidents"
        description="Open incidents first, then the most recent. Click one for the summary and why it has that priority."
      >
        {incidents.length === 0 && <p className="text-sm text-slate-400">No incidents yet.</p>}
        <ul className="divide-y divide-white/5">
          {incidents.map((i) => {
            const open = i.status === 'open' || i.status === 'acknowledged';
            return (
              <li key={i.id}>
                <details className="group py-2.5">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-bold ${PRIORITY_STYLE[i.priority]}`}
                    >
                      {i.priority}
                    </span>
                    <span className={open ? 'font-medium text-slate-100' : 'text-slate-400'}>
                      {i.title}
                    </span>
                    {i.siteName && !i.title.includes(i.siteName) && (
                      <span className="text-slate-500">{i.siteName}</span>
                    )}
                    <Badge tone={open ? 'warn' : 'neutral'}>{i.status}</Badge>
                    {i.inMaintenance && <Badge tone="info">maintenance</Badge>}
                    {i.seeded && <Badge>pre-existing</Badge>}
                    <span className="ml-auto text-xs text-slate-500">
                      INC-{i.id} · {i.alertCount} alert{i.alertCount === 1 ? '' : 's'} · opened{' '}
                      {since(i.openedAt)}
                    </span>
                  </summary>
                  <div className="mt-3 space-y-2 rounded-lg border border-white/10 bg-slate-950/40 p-4 text-sm">
                    <p>{i.templateSummary}</p>
                    <p className="text-xs text-slate-400">
                      Priority: {i.priorityFactors.explanation.join(' · ')}
                    </p>
                    <p className="text-xs text-slate-400">
                      Opened {i.openedAt.toLocaleString('en-US', { timeZone: tz })}
                      {i.resolvedAt &&
                        ` · resolved ${i.resolvedAt.toLocaleString('en-US', { timeZone: tz })}`}{' '}
                      · recovery target{' '}
                      {i.recoveryTargetMin % 60 === 0
                        ? `${i.recoveryTargetMin / 60} h`
                        : `${i.recoveryTargetMin} min`}
                    </p>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card className="mt-6" title="Pollers">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2">Poller</th>
              <th>Last success</th>
              <th>Failures</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {report.pollers.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-slate-400">
                  No polls yet.
                </td>
              </tr>
            )}
            {report.pollers.map((p) => (
              <tr key={p.poller} className="border-t border-white/10">
                <td className="py-2 font-mono">{p.poller}</td>
                <td>
                  {p.lastSuccessAt
                    ? new Date(p.lastSuccessAt).toLocaleString('en-US', {
                        timeZone: state.cfg!.timezone,
                      })
                    : '—'}
                </td>
                <td className={tone(p.consecutiveFailures === 0)}>{p.consecutiveFailures}</td>
                <td className="max-w-xs truncate text-xs text-slate-400" title={p.lastError ?? ''}>
                  {p.lastError ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="mt-6 text-sm text-slate-400">
        Change the connection, mapping, sites or intervals any time in{' '}
        <Link href="/settings" className="underline">
          Settings
        </Link>
        .
      </p>
    </Shell>
  );
}
