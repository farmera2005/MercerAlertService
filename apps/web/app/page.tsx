import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Shell } from '@/components/shell';
import { Alert, Card } from '@/components/ui';
import { requireAdmin } from '@/lib/auth';
import { getHealth } from '@/lib/health';
import { getSettingsState } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const tone = (ok: boolean) => (ok ? 'text-emerald-400' : 'text-red-400');

/** Operational status. The full dashboard (sites, incidents, map) arrives in Milestone 3. */
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
