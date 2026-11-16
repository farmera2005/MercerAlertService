import Link from 'next/link';
import type { DivisionGroup } from '@/lib/overview';
import { LEVEL, LevelIcon } from './status';

/** Site tiles grouped by division (overview). */
export function SiteGrid({ groups }: { groups: DivisionGroup[] }) {
  if (groups.length === 0)
    return (
      <p className="text-sm text-slate-400">
        No sites with monitored devices yet. Check Settings → Mapping once the first node poll has
        run.
      </p>
    );
  return (
    <div className="gap-6 md:columns-2" data-testid="site-grid">
      {groups.map((g) => (
        <section key={g.code ?? 'none'} aria-label={g.name} className="mb-6 break-inside-avoid">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <LevelIcon level={g.level} size={14} />
            {g.name}
            {g.isAffiliate && <span className="text-xs font-normal text-slate-500">affiliate</span>}
          </h3>
          <ul className="space-y-2">
            {g.sites.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/sites/${encodeURIComponent(s.code)}`}
                  data-level={s.health.level}
                  data-site={s.name}
                  className="block rounded-lg border border-white/10 border-l-4 bg-white/[0.03] px-3 py-2.5 hover:bg-white/[0.06]"
                  style={{ borderLeftColor: LEVEL[s.health.level].color }}
                >
                  <span className="flex items-center gap-2">
                    <LevelIcon level={s.health.level} size={16} />
                    <span className="min-w-0 font-medium text-slate-100">{s.name}</span>
                    {s.harvestCritical && (
                      <span className="ml-auto shrink-0 rounded bg-amber-500/15 px-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-200">
                        harvest
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-300">
                    {s.health.reason}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {s.health.nodesTotal} device{s.health.nodesTotal === 1 ? '' : 's'}
                    {s.health.nodesDown ? ` · ${s.health.nodesDown} down` : ''}
                    {s.tier !== 'standard' ? ` · ${s.tier}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
