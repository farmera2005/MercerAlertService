import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { stripAddresses } from '@mercer/core';
import { LiveProvider } from '@/components/live';
import { WallScreen } from '@/components/wall';
import { checkKioskToken } from '@/lib/kiosk';
import { liveInitial } from '@/lib/live-initial';
import { mapConfig } from '@/lib/map';
import { overviewModel } from '@/lib/overview';
import { effectiveConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Network wall · Mercer Landmark',
  robots: { index: false, follow: false },
  referrer: 'strict-origin',
};

function Invalid() {
  // The same message whatever the reason, so a guessed link learns nothing.
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0e13] p-10 text-center">
      <div>
        <h1 className="text-[44px] font-bold text-white">This wall link is not valid</h1>
        <p className="mt-4 text-[30px] text-slate-300">
          It may have been revoked or replaced. Ask IT for a new link.
        </p>
      </div>
    </main>
  );
}

/** NOC wall display: no sign-in, a kiosk token in the URL, read-only. */
export default async function WallPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const check = await checkKioskToken(token, await headers());
  if (!check.ok) return <Invalid />;
  const cfg = await effectiveConfig();
  const [model, initial, map] = await Promise.all([
    overviewModel(),
    liveInitial(),
    mapConfig(cfg, token),
  ]);
  return (
    <LiveProvider endpoint={`/api/events?k=${encodeURIComponent(token)}`} initial={initial}>
      <WallScreen
        tz={cfg.timezone}
        rotateSec={cfg.wall.rotateSec}
        showMap={cfg.wall.showMap}
        pinP1={cfg.wall.pinP1}
        counts={model.counts}
        map={{
          mode: map.mode,
          tileUrl: map.tileUrl,
          attribution: map.attribution,
          image: map.image,
        }}
        mapSites={model.tiles.map((t) => ({
          code: t.code,
          name: t.name,
          level: t.health.level,
          reason: stripAddresses(t.health.reason),
          lat: t.lat,
          lon: t.lon,
          mapX: t.mapX,
          mapY: t.mapY,
        }))}
        sites={model.tiles.map((t) => ({
          id: t.id,
          name: t.name,
          division: t.divisionName,
          level: t.health.level,
          reason: stripAddresses(t.health.reason),
          harvestCritical: t.harvestCritical,
        }))}
        incidents={model.openIncidents
          .filter((i) => !i.snoozedUntil || i.snoozedUntil.getTime() < Date.now())
          .map((i) => {
            const tile = model.tiles.find((t) => t.incidents.some((x) => x.id === i.id));
            const fromTile = tile?.incidents.find((x) => x.id === i.id);
            return {
              id: i.id,
              priority: i.priority,
              title: stripAddresses(fromTile?.title ?? i.title),
              summary: stripAddresses(fromTile?.summary ?? i.templateSummary.slice(0, 180)),
              site: i.siteName,
              openedAt: i.openedAt.getTime(),
              acknowledged: i.status === 'acknowledged',
            };
          })}
      />
    </LiveProvider>
  );
}
