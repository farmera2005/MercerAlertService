import Link from 'next/link';
import { listAudit } from '@mercer/db';
import { Card, Select, Button } from '@/components/ui';
import { server } from '@/lib/server';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const FILTERS: Array<[string, string]> = [
  ['', 'Everything'],
  ['incident.', 'Incident actions'],
  ['settings.', 'Settings changes'],
  ['kiosk.', 'Wall links'],
  ['auth.', 'Sign-ins'],
  ['site', 'Sites'],
  ['season', 'Seasons'],
  ['maintenance', 'Maintenance'],
];

function short(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; before?: string }>;
}) {
  const sp = await searchParams;
  const action = FILTERS.some(([k]) => k === sp.action) ? sp.action! : '';
  const tz = (await effectiveConfig()).timezone;
  const { rows, nextBeforeId } = await listAudit(server().db.db, {
    limit: 100,
    actionPrefix: action || undefined,
    beforeId: Number(sp.before) || undefined,
  });
  return (
    <div className="space-y-4">
      <form method="get" className="flex items-end gap-3">
        <label className="text-xs text-slate-400">
          Show
          <Select name="action" defaultValue={action} className="mt-1 w-56">
            {FILTERS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </form>
      <Card
        title="Audit log"
        description="Every change made in the dashboard. Secrets are redacted."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="py-2 pr-3">When</th>
                <th className="pr-3">Who</th>
                <th className="pr-3">Action</th>
                <th className="pr-3">Target</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-white/5 align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-slate-400">
                    {r.at.toLocaleString('en-US', { timeZone: tz })}
                  </td>
                  <td className="pr-3">
                    {r.actorLabel}
                    {r.ip && <span className="block text-slate-500">{r.ip}</span>}
                  </td>
                  <td className="pr-3 font-mono">{r.action}</td>
                  <td className="pr-3">
                    {r.targetType === 'incident' && r.targetId ? (
                      <Link
                        href={`/incidents/${r.targetId}`}
                        className="text-sky-300 hover:underline"
                      >
                        INC-{r.targetId}
                      </Link>
                    ) : (
                      [r.targetType, r.targetId].filter(Boolean).join(' ')
                    )}
                  </td>
                  <td className="break-all font-mono text-slate-400">
                    {short(r.before) && <span className="block">− {short(r.before)}</span>}
                    {short(r.after) && <span className="block">+ {short(r.after)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nextBeforeId && (
          <div className="mt-4 text-right">
            <Link
              href={`/settings/audit?${new URLSearchParams({ ...(action ? { action } : {}), before: String(nextBeforeId) })}`}
              className="text-sm text-sky-300 hover:underline"
            >
              Older →
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
