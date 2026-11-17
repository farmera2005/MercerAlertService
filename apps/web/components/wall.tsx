'use client';

import { useEffect, useMemo, useState } from 'react';
import { LiveDot, StaleBanner, useLive } from './live';
import { SiteMap, type MapConfig, type MapSite } from './site-map';
import { LEVEL, LevelIcon, PriorityBadge, type Level } from './status';

export interface WallSite {
  id: number;
  name: string;
  division: string;
  level: Level;
  reason: string;
  harvestCritical: boolean;
}

export interface WallIncident {
  id: number;
  priority: string;
  title: string;
  summary: string;
  site: string | null;
  openedAt: number;
  acknowledged: boolean;
}

type View = 'incidents' | 'sites' | 'map';

const SEVERITY: Level[] = ['bad', 'warn', 'maintenance', 'unknown', 'ok'];
const RELOAD_AFTER_MS = 6 * 3600_000;

function age(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} d`;
}

function Clock({ tz }: { tz: string }) {
  const live = useLive();
  const now = live?.now ?? Date.now();
  return (
    <span className="tabular-nums" suppressHydrationWarning>
      {new Date(now).toLocaleTimeString('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
      })}
    </span>
  );
}

function SitesView({ sites }: { sites: WallSite[] }) {
  const problems = sites
    .filter((s) => s.level !== 'ok')
    .sort((a, b) => SEVERITY.indexOf(a.level) - SEVERITY.indexOf(b.level));
  const fine = sites.filter((s) => s.level === 'ok');
  return (
    <div className="space-y-8">
      {problems.length > 0 && (
        <ul
          className="grid gap-5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(520px, 1fr))' }}
        >
          {problems.map((s) => (
            <li
              key={s.id}
              data-level={s.level}
              className="rounded-2xl border-l-[14px] bg-[#141a21] px-6 py-5"
              style={{ borderLeftColor: LEVEL[s.level].color }}
            >
              <div className="flex items-center gap-4">
                <LevelIcon level={s.level} size={44} />
                <span className="text-[40px] font-bold leading-tight text-white">{s.name}</span>
              </div>
              <div className="mt-2 text-[30px] leading-snug text-slate-200">{s.reason}</div>
              <div className="mt-1 text-[28px] text-slate-400">
                {s.division}
                {s.harvestCritical ? ' · harvest-critical' : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
      {fine.length > 0 && (
        <section>
          <h2 className="mb-4 flex items-center gap-3 text-[32px] font-semibold text-slate-200">
            <LevelIcon level="ok" size={36} />
            {problems.length ? `${fine.length} other sites OK` : `All ${fine.length} sites OK`}
          </h2>
          <ul className="flex flex-wrap gap-3">
            {fine.map((s) => (
              <li
                key={s.id}
                className="rounded-xl bg-[#141a21] px-5 py-2 text-[28px] text-slate-200"
              >
                {s.name}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function IncidentsView({ incidents, now }: { incidents: WallIncident[]; now: number }) {
  const shown = incidents.slice(0, 6);
  return (
    <div>
      <ul className="space-y-5">
        {shown.map((i) => (
          <li key={i.id} className="rounded-2xl bg-[#141a21] px-7 py-5" data-testid="wall-incident">
            <div className="flex items-start gap-5">
              <PriorityBadge p={i.priority} size="wall" />
              <div className="min-w-0 flex-1">
                <div className="text-[40px] font-bold leading-tight text-white">{i.title}</div>
                <div className="mt-2 text-[30px] leading-snug text-slate-200">{i.summary}</div>
                <div className="mt-2 text-[28px] text-slate-400">
                  {i.site ? `${i.site} · ` : ''}open {age(now - i.openedAt)}
                  {i.acknowledged ? ' · acknowledged' : ' · not acknowledged'}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {incidents.length > shown.length && (
        <p className="mt-5 text-[30px] text-slate-300">
          + {incidents.length - shown.length} more open incident
          {incidents.length - shown.length === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}

/**
 * The NOC wall: read-only, large, rotating between active incidents, the site grid and the map.
 * No buttons, no links, no addresses.
 */
export function WallScreen({
  tz,
  rotateSec,
  showMap,
  pinP1,
  counts,
  sites,
  incidents,
  map,
  mapSites,
}: {
  tz: string;
  rotateSec: number;
  showMap: boolean;
  pinP1: boolean;
  counts: Record<string, number>;
  sites: WallSite[];
  incidents: WallIncident[];
  map: MapConfig;
  mapSites: MapSite[];
}) {
  const live = useLive();
  // While a P1 is open the room should see it, not the map.
  const pinned = pinP1 && incidents.some((i) => i.priority === 'P1');
  const views = useMemo<View[]>(
    () =>
      pinned
        ? ['incidents']
        : [
            ...(incidents.length ? (['incidents'] as const) : []),
            'sites',
            ...(showMap ? (['map'] as const) : []),
          ],
    [pinned, incidents.length, showMap],
  );
  const [idx, setIdx] = useState(0);
  const view = views[idx % views.length]!;

  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % views.length), rotateSec * 1000);
    return () => clearInterval(id);
  }, [rotateSec, views.length]);

  // Kiosk browsers run for weeks: a periodic full reload picks up new releases and frees memory.
  useEffect(() => {
    const id = setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
    return () => clearTimeout(id);
  }, []);

  const title = view === 'incidents' ? 'Open incidents' : view === 'sites' ? 'Sites' : 'Map';

  return (
    <div className="flex min-h-screen cursor-none flex-col bg-[#0a0e13] text-slate-100">
      <StaleBanner variant="wall" />
      <header className="flex items-center gap-8 border-b border-white/10 px-10 py-5">
        <div className="text-[36px] font-bold">Mercer Landmark · Network</div>
        <div className="text-[32px] text-slate-400">{title}</div>
        <div className="ml-auto flex items-center gap-4">
          {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => (
            <span key={p} className="flex items-center gap-2" data-testid={`wall-count-${p}`}>
              <PriorityBadge p={p} size="wall" />
              <span className="text-[40px] font-bold tabular-nums">{counts[p] ?? 0}</span>
            </span>
          ))}
          <span className="ml-6 text-[40px] font-semibold">
            <Clock tz={tz} />
          </span>
          <span className="scale-150 pl-4">
            <LiveDot />
          </span>
        </div>
      </header>
      <main className="flex-1 px-10 py-8" data-view={view} data-testid="wall-view">
        {view === 'incidents' && (
          <IncidentsView incidents={incidents} now={live?.now ?? Date.now()} />
        )}
        {view === 'sites' && <SitesView sites={sites} />}
        {view === 'map' && <SiteMap variant="wall" height={760} config={map} sites={mapSites} />}
      </main>
      <footer className="flex justify-center gap-3 pb-5" aria-hidden>
        {views.map((v, i) => (
          <span
            key={v}
            className={`h-3 w-12 rounded-full ${i === idx % views.length ? 'bg-slate-200' : 'bg-slate-700'}`}
          />
        ))}
      </footer>
    </div>
  );
}
