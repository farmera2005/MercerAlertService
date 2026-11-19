import Link from 'next/link';
import {
  flappingNodes,
  listDigests,
  noiseSeries,
  recurringProblems,
  topInterfaces,
} from '@mercer/db';
import { CountBars } from '@/components/count-bars';
import { parseRange, RangeTabs } from '@/components/range-tabs';
import { Shell } from '@/components/shell';
import { fmtTime, ROLE_LABEL } from '@/components/status';
import { Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { SERIES_COLORS } from '@/lib/chart-colors';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const RANGE_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;

/** A thin magnitude bar behind a value (one hue; the number is always printed too). */
function Meter({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="block h-1.5 w-full rounded-full bg-white/5" aria-hidden>
      <span
        className="block h-1.5 rounded-full"
        style={{ width: `${pct}%`, background: SERIES_COLORS[0] }}
      />
    </span>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-50">{value}</div>
      {note && <div className="mt-1 text-xs text-slate-500">{note}</div>}
    </div>
  );
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await requireUser('/trends');
  const range = parseRange((await searchParams).range);
  const cfg = await effectiveConfig();
  const tz = cfg.timezone;
  const db = server().db.db;
  const end = new Date();
  const start = new Date(end.getTime() - RANGE_MS[range]);
  const hourly = range === '24h';
  const period = { start, end };
  const [noise, flapping, talkers, recurring, digests] = await Promise.all([
    noiseSeries(db, { ...period, timeZone: tz, unit: hourly ? 'hour' : 'day' }),
    flappingNodes(db, { ...period, min: 3, limit: 10 }),
    topInterfaces(db, { ...period, limit: 10 }),
    recurringProblems(db, period),
    listDigests(db, 4),
  ]);
  const raw = noise.reduce((s, b) => s + b.rawAlerts, 0);
  const opened = noise.reduce((s, b) => s + b.incidents, 0);
  const repeats = recurring.filter((r) => r.incidents >= 2).slice(0, 10);
  const maxFlap = Math.max(0, ...flapping.map((f) => f.changes));
  const maxPeak = Math.max(0, ...talkers.map((t) => t.peak));

  return (
    <Shell user={user} wide>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Trends</h1>
          <p className="mt-1 text-sm text-slate-400">
            How noisy Orion is, what keeps coming back, and which links run hot.
          </p>
        </div>
        <RangeTabs base="/trends" current={range} />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3" data-testid="trend-stats">
        <Stat label="Raw Orion alert raises" value={raw.toLocaleString('en-US')} />
        <Stat label="Incidents opened" value={opened.toLocaleString('en-US')} />
        <Stat
          label="Noise ratio"
          value={
            opened ? `${(Math.round((raw / opened) * 10) / 10).toLocaleString('en-US')}:1` : '—'
          }
          note="Raw alerts per incident. Higher means more noise absorbed."
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <CountBars
          title={hourly ? 'Raw alert raises per hour' : 'Raw alert raises per day'}
          data={noise.map((b) => ({ label: b.label, value: b.rawAlerts }))}
          color={SERIES_COLORS[0]}
          hourly={hourly}
          testId="chart-raw"
        />
        <CountBars
          title={hourly ? 'Incidents opened per hour' : 'Incidents opened per day'}
          data={noise.map((b) => ({ label: b.label, value: b.incidents }))}
          color={SERIES_COLORS[0]}
          hourly={hourly}
          testId="chart-incidents"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card
          title="Flapping devices"
          description="Devices that changed state three or more times."
        >
          {flapping.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing flapped in this period.</p>
          ) : (
            <table className="w-full text-left text-sm" data-testid="flapping">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Device</th>
                  <th className="py-1.5 pr-3 font-medium">Site</th>
                  <th className="w-1/3 py-1.5 text-right font-medium">State changes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {flapping.map((f) => (
                  <tr key={f.nodeId}>
                    <td className="py-2 pr-3">
                      <Link href={`/nodes/${f.nodeId}`} className="text-sky-300 hover:underline">
                        {f.node}
                      </Link>
                      <div className="text-xs text-slate-500">{ROLE_LABEL[f.role] ?? f.role}</div>
                    </td>
                    <td className="py-2 pr-3 text-slate-300">{f.site ?? '—'}</td>
                    <td className="py-2">
                      <div className="text-right tabular-nums text-slate-100">{f.changes}</div>
                      <Meter value={f.changes} max={maxFlap} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title="Top talkers"
          description="Busiest interfaces by peak utilization (5-minute values, either direction)."
        >
          {talkers.length === 0 ? (
            <p className="text-sm text-slate-400">No interface data in this period.</p>
          ) : (
            <table className="w-full text-left text-sm" data-testid="talkers">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Interface</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Avg in / out</th>
                  <th className="w-1/4 py-1.5 text-right font-medium">Peak</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {talkers.map((t) => (
                  <tr key={t.interfaceId}>
                    <td className="py-2 pr-3">
                      <Link
                        href={`/interfaces/${t.interfaceId}`}
                        className="text-sky-300 hover:underline"
                      >
                        {t.node} · {t.iface}
                      </Link>
                      <div className="text-xs text-slate-500">{t.site ?? '—'}</div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-300">
                      {t.inAvg}% / {t.outAvg}%
                    </td>
                    <td className="py-2">
                      <div className="text-right tabular-nums text-slate-100">{t.peak}%</div>
                      <Meter value={t.peak} max={Math.max(maxPeak, 100)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card
          title="Recurring problems"
          description="Devices (or sites) with more than one incident in this period."
        >
          {repeats.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing came back more than once.</p>
          ) : (
            <table className="w-full text-left text-sm" data-testid="recurring">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Device or site</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Incidents</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Time open</th>
                  <th className="py-1.5 font-medium">Latest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {repeats.map((r) => (
                  <tr key={r.subject}>
                    <td className="py-2 pr-3">
                      {r.nodeId ? (
                        <Link href={`/nodes/${r.nodeId}`} className="text-sky-300 hover:underline">
                          {r.subject}
                        </Link>
                      ) : r.siteCode ? (
                        <Link
                          href={`/sites/${encodeURIComponent(r.siteCode)}`}
                          className="text-sky-300 hover:underline"
                        >
                          {r.subject}
                        </Link>
                      ) : (
                        r.subject
                      )}
                      {r.site && r.site !== r.subject && (
                        <div className="text-xs text-slate-500">{r.site}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-100">
                      {r.incidents}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-300">
                      {r.downMinutes >= 120
                        ? `${Math.round(r.downMinutes / 60)} h`
                        : `${r.downMinutes} min`}
                    </td>
                    <td className="py-2 text-xs">
                      {r.ids.slice(0, 3).map((id) => (
                        <Link
                          key={id}
                          href={`/incidents/${id}`}
                          className="mr-2 font-mono text-sky-300 hover:underline"
                        >
                          INC-{id}
                        </Link>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Digests" description="The morning digest and the Monday trends report.">
          {digests.length === 0 ? (
            <p className="text-sm text-slate-400">No digests yet.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {digests.map((d) => (
                <li key={d.id}>
                  <Link href={`/digests/${d.id}`} className="text-sky-300 hover:underline">
                    {d.kind === 'daily' ? 'Daily' : 'Weekly'} · {fmtTime(d.periodEnd, tz)}
                  </Link>
                  <div className="text-xs text-slate-400">{d.headline}</div>
                </li>
              ))}
            </ul>
          )}
          <Link href="/digests" className="mt-4 inline-block text-sm text-sky-300 hover:underline">
            All digests →
          </Link>
        </Card>
      </div>
    </Shell>
  );
}
