import Link from 'next/link';
import { Shell } from '@/components/shell';
import { LevelIcon } from '@/components/status';
import { Card } from '@/components/ui';
import { requireUser } from '@/lib/auth';
import { overviewModel } from '@/lib/overview';

export const dynamic = 'force-dynamic';

export default async function SitesPage() {
  const user = await requireUser('/sites');
  const model = await overviewModel();
  return (
    <Shell user={user} wide>
      <h1 className="text-2xl font-semibold">Sites</h1>
      <div className="mt-6 space-y-6">
        {model.groups.map((g) => (
          <Card
            key={g.code ?? 'none'}
            title={g.name}
            description={g.isAffiliate ? 'Affiliate' : undefined}
          >
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-2">Site</th>
                  <th>Status</th>
                  <th className="text-right">Devices</th>
                  <th className="text-right">Down</th>
                  <th className="text-right">Open incidents</th>
                  <th className="pl-4">Profile</th>
                </tr>
              </thead>
              <tbody>
                {g.sites.map((s) => (
                  <tr key={s.id} className="border-t border-white/5">
                    <td className="py-2">
                      <Link
                        href={`/sites/${encodeURIComponent(s.code)}`}
                        className="font-medium text-sky-300 hover:underline"
                      >
                        {s.name}
                      </Link>
                      {s.city && <span className="ml-2 text-xs text-slate-500">{s.city}</span>}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-2">
                        <LevelIcon level={s.health.level} size={14} />
                        <span className="text-slate-300">{s.health.reason}</span>
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{s.health.nodesTotal}</td>
                    <td className="text-right tabular-nums">{s.health.nodesDown || ''}</td>
                    <td className="text-right tabular-nums">{s.health.openIncidents || ''}</td>
                    <td className="pl-4 text-xs text-slate-400">
                      {s.tier}
                      {s.harvestCritical ? ' · harvest-critical' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
    </Shell>
  );
}
