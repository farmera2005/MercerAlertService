import Link from 'next/link';
import { redirect } from 'next/navigation';
import { noiseStats } from '@mercer/db';
import { IncidentRows } from '@/components/incident-rows';
import { PollAgo } from '@/components/live';
import { Shell } from '@/components/shell';
import { SiteGrid } from '@/components/site-grid';
import { SiteMap } from '@/components/site-map';
import { LevelIcon, PRIORITY, PriorityBadge } from '@/components/status';
import { Alert, Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { getHealth } from '@/lib/health';
import { mapConfig } from '@/lib/map';
import { overviewModel } from '@/lib/overview';
import { server } from '@/lib/server';
import { getSettingsState } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const POLLERS = ['alerts', 'nodes', 'interfaces', 'events', 'groups', 'topology'] as const;

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const user = await requireUser('/');
  const state = await getSettingsState();
  if (!state.cfg?.setupComplete && !state.cfg?.envKeys.has('SWIS_PASSWORD')) {
    if (user.isAdmin) redirect('/setup/orion');
  }
  const cfg = state.cfg ?? server().bootstrap;
  const { welcome } = await searchParams;
  const now = Date.now();
  const { db } = server();
  const [model, health, noise24, noise7, map] = await Promise.all([
    overviewModel(new Date(now)),
    getHealth(),
    noiseStats(db.db, new Date(now - 86_400_000)),
    noiseStats(db.db, new Date(now - 7 * 86_400_000)),
    mapConfig(cfg),
  ]);
  const { report } = health;
  const swisUp = report.swis.status === 'up';
  const pollers = new Map(report.pollers.map((p) => [p.poller, p]));

  return (
    <Shell user={user} wide>
      {welcome && (
        <div className="mb-6">
          <Alert tone="success" title="Monitoring started">
            The worker begins polling SolarWinds within a few seconds; this page updates by itself.
          </Alert>
        </div>
      )}
      <h1 className="sr-only">Network status overview</h1>

      <section
        className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7"
        aria-label="Summary"
      >
        {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => (
          <Link
            key={p}
            href={`/incidents?priority=${p}`}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-4 hover:bg-white/[0.06]"
            data-testid={`count-${p}`}
          >
            <div className="flex items-center justify-between">
              <PriorityBadge p={p} />
              <span className="text-3xl font-semibold">{model.counts[p]}</span>
            </div>
            <div className="mt-2 text-xs text-slate-400">
              open {PRIORITY[p]!.label.split(' ')[1]} incident{model.counts[p] === 1 ? '' : 's'}
            </div>
          </Link>
        ))}
        <div className="col-span-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 md:col-span-2 xl:col-span-2">
          <div className="text-xs text-slate-400">Noise reduction, last 24 hours</div>
          <div className="mt-1 text-5xl font-semibold" data-testid="noise-24h">
            {noise24.ratio !== null ? `${noise24.ratio} : 1` : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {noise24.rawAlerts} Orion alerts → {noise24.incidents} incident
            {noise24.incidents === 1 ? '' : 's'} · 7 days:{' '}
            {noise7.ratio !== null ? `${noise7.ratio} : 1` : '—'}
          </div>
        </div>
        <div className="col-span-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 md:col-span-2 xl:col-span-1">
          <div className="text-xs text-slate-400">SolarWinds</div>
          <div className="mt-2 flex items-center gap-2 text-lg font-semibold">
            <LevelIcon level={swisUp ? 'ok' : report.swis.status === 'down' ? 'bad' : 'unknown'} />
            {swisUp ? 'Connected' : report.swis.status === 'down' ? 'Unreachable' : 'Unknown'}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            Alerts polled{' '}
            <PollAgo poller="alerts" initial={pollers.get('alerts')?.lastSuccessAt ?? null} />
          </div>
        </div>
      </section>

      {map.problem && user.isAdmin && (
        <div className="mt-6">
          <Alert tone="warning">{map.problem}</Alert>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Sites"
          description="Grouped by division. Red: a P1/P2 incident, a site outage or the WAN firewall down. Amber: anything else open or down."
        >
          <SiteGrid groups={model.groups} />
          {model.unmappedNodes > 0 && (
            <p className="mt-4 text-xs text-slate-400">
              {model.unmappedNodes} monitored device{model.unmappedNodes === 1 ? ' is' : 's are'}{' '}
              not mapped to a site
              {user.isAdmin && (
                <>
                  {' '}
                  (
                  <Link href="/settings/mapping" className="underline">
                    fix in Settings
                  </Link>
                  )
                </>
              )}
              .
            </p>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Map">
            <SiteMap
              height={360}
              config={map}
              sites={model.tiles.map((t) => ({
                code: t.code,
                name: t.name,
                level: t.health.level,
                reason: t.health.reason,
                lat: t.lat,
                lon: t.lon,
                mapX: t.mapX,
                mapY: t.mapY,
              }))}
            />
          </Card>
          <Card title="Last polls" description="Successful reads from SolarWinds, per dataset.">
            <table className="w-full text-sm">
              <tbody>
                {POLLERS.map((p) => {
                  const s = pollers.get(p);
                  return (
                    <tr key={p} className="border-t border-white/5 first:border-0">
                      <td className="py-1.5 text-slate-300">{p}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-400">
                        <PollAgo poller={p} initial={s?.lastSuccessAt ?? null} />
                      </td>
                      <td className="w-6 py-1.5 text-right">
                        {s && s.consecutiveFailures > 0 && (
                          <span title={s.lastError ?? ''}>
                            <LevelIcon level="bad" size={14} />
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      <Card
        className="mt-6"
        title={`Open incidents (${model.openIncidents.length})`}
        actions={
          <Link href="/incidents?status=all" className="text-sm text-sky-300 hover:underline">
            All incidents →
          </Link>
        }
      >
        <IncidentRows rows={model.openIncidents} empty="Nothing open. Every site is quiet." />
      </Card>
    </Shell>
  );
}
