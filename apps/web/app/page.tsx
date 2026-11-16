import { getHealth } from '@/lib/health';

export const dynamic = 'force-dynamic';

const tone = (ok: boolean) => (ok ? 'text-[var(--ok)]' : 'text-[var(--bad)]');

/**
 * Milestone 1 placeholder: operational status only (no device data — SSO arrives in Milestone 3).
 */
export default async function Home() {
  const { report } = await getHealth();
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-3xl font-semibold">MercerAlertService</h1>
      <p className="mt-2 text-[var(--muted)]">
        Foundation build. The dashboard, Entra ID sign-in and wall display arrive in Milestone 3.
      </p>
      <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-white/10 p-4">
          <div className="text-sm text-[var(--muted)]">Database</div>
          <div className={`text-2xl font-semibold ${tone(report.db === 'ok')}`}>{report.db}</div>
        </div>
        <div className="rounded-lg border border-white/10 p-4">
          <div className="text-sm text-[var(--muted)]">Worker</div>
          <div className={`text-2xl font-semibold ${tone(report.worker.status === 'ok')}`}>
            {report.worker.status}
          </div>
          {report.worker.ageSec !== null && (
            <div className="text-sm text-[var(--muted)]">heartbeat {report.worker.ageSec}s ago</div>
          )}
        </div>
        <div className="rounded-lg border border-white/10 p-4">
          <div className="text-sm text-[var(--muted)]">SolarWinds (SWIS)</div>
          <div className={`text-2xl font-semibold ${tone(report.swis.status === 'up')}`}>
            {report.swis.status}
          </div>
          {report.swis.tlsVerification === 'DISABLED' && (
            <div className="text-sm text-[var(--bad)]">TLS verification disabled</div>
          )}
        </div>
      </section>
      <table className="mt-8 w-full text-left text-sm">
        <thead className="text-[var(--muted)]">
          <tr>
            <th className="py-2">Poller</th>
            <th>Last success</th>
            <th>Failures</th>
          </tr>
        </thead>
        <tbody>
          {report.pollers.map((p) => (
            <tr key={p.poller} className="border-t border-white/10">
              <td className="py-2 font-mono">{p.poller}</td>
              <td>
                {p.lastSuccessAt
                  ? new Date(p.lastSuccessAt).toLocaleString('en-US', {
                      timeZone: 'America/New_York',
                    })
                  : '—'}
              </td>
              <td className={tone(p.consecutiveFailures === 0)}>{p.consecutiveFailures}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
