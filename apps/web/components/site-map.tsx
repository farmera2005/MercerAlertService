'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type * as Leaflet from 'leaflet';
import { LEVEL, LevelIcon, type Level } from './status';

export interface MapSite {
  code: string;
  name: string;
  level: Level;
  reason: string;
  lat: number | null;
  lon: number | null;
  mapX: number | null;
  mapY: number | null;
}

export interface MapConfig {
  mode: 'tiles' | 'image';
  tileUrl: string;
  attribution: string;
  /** For mode=image. */
  image: { url: string; width: number; height: number } | null;
}

const SURFACE = '#12161b';
const OHIO: [number, number] = [40.55, -84.57];

function placed(s: MapSite, cfg: MapConfig): [number, number] | null {
  if (cfg.mode === 'image') {
    if (!cfg.image || s.mapX === null || s.mapY === null) return null;
    return [cfg.image.height - s.mapY, s.mapX];
  }
  return s.lat !== null && s.lon !== null ? [s.lat, s.lon] : null;
}

/**
 * Sites as coloured markers on OpenStreetMap tiles, or on an uploaded image when the server has
 * no internet access (MAP_MODE=image). Markers update in place when the page refreshes.
 */
export function SiteMap({
  sites,
  config,
  height = 420,
  variant = 'dashboard',
}: {
  sites: MapSite[];
  config: MapConfig;
  height?: number;
  variant?: 'dashboard' | 'wall';
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const fitted = useRef(false);
  const router = useRouter();
  const wall = variant === 'wall';
  const cfgKey = `${config.mode}|${config.tileUrl}|${config.image?.url ?? ''}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const leaflet = (await import('leaflet')).default;
      if (cancelled || !el.current) return;
      L.current = leaflet;
      const m =
        config.mode === 'image' && config.image
          ? leaflet.map(el.current, {
              crs: leaflet.CRS.Simple,
              minZoom: -4,
              zoomControl: !wall,
              attributionControl: false,
            })
          : leaflet.map(el.current, { zoomControl: !wall, attributionControl: true });
      if (config.mode === 'image' && config.image) {
        const bounds: Leaflet.LatLngBoundsExpression = [
          [0, 0],
          [config.image.height, config.image.width],
        ];
        leaflet.imageOverlay(config.image.url, bounds).addTo(m);
        m.fitBounds(bounds);
      } else {
        leaflet
          .tileLayer(config.tileUrl, {
            attribution: config.attribution,
            maxZoom: 18,
            // Pages send no Referer elsewhere (Referrer-Policy: same-origin), but OpenStreetMap's
            // tile policy requires one: tiles send this site's origin only, never a path (the
            // wall's path holds its kiosk token).
            referrerPolicy: 'strict-origin',
          })
          .addTo(m);
        m.setView(OHIO, 8);
      }
      if (wall) {
        m.dragging.disable();
        m.scrollWheelZoom.disable();
        m.doubleClickZoom.disable();
        m.keyboard.disable();
      }
      map.current = m;
      layer.current = leaflet.layerGroup().addTo(m);
      fitted.current = false;
      draw();
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      layer.current = null;
    };
    // The map is rebuilt only when its background changes; markers redraw on every render below.
  }, [cfgKey, wall]);

  const draw = () => {
    const leaflet = L.current;
    const m = map.current;
    const g = layer.current;
    if (!leaflet || !m || !g) return;
    g.clearLayers();
    const points: Array<[number, number]> = [];
    // Worst last, so red markers sit on top.
    const order: Level[] = ['unknown', 'ok', 'maintenance', 'warn', 'bad'];
    const sorted = [...sites].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
    // Wall labels alternate sides (north to south) so neighbouring sites don't stack.
    const labelled = sorted
      .filter((s) => s.level === 'bad' || s.level === 'warn')
      .map((s) => ({ s, at: placed(s, config) }))
      .filter((x): x is { s: MapSite; at: [number, number] } => x.at !== null)
      .sort((a, b) => b.at[0] - a.at[0]);
    const side = new Map(
      labelled.map((x, i) => [x.s.code, i % 2 === 0 ? 'right' : 'left'] as const),
    );
    for (const s of sorted) {
      const at = placed(s, config);
      if (!at) continue;
      points.push(at);
      const marker = leaflet.circleMarker(at, {
        radius: wall ? (s.level === 'bad' ? 18 : 13) : s.level === 'bad' ? 11 : 8,
        color: SURFACE,
        weight: 2,
        fillColor: LEVEL[s.level].color,
        fillOpacity: 1,
      });
      const tip = document.createElement('div');
      const name = document.createElement('div');
      name.textContent = s.name;
      name.style.fontWeight = '600';
      tip.appendChild(name);
      // On the wall the label is just the name; the sites view carries the reason.
      if (!wall) {
        const why = document.createElement('div');
        why.textContent = `${LEVEL[s.level].label} · ${s.reason}`;
        tip.appendChild(why);
      }
      const dir = wall ? (side.get(s.code) ?? 'right') : 'right';
      marker.bindTooltip(tip, {
        permanent: wall && side.has(s.code),
        direction: dir,
        offset: [dir === 'right' ? (wall ? 18 : 10) : wall ? -18 : -10, 0],
        className: wall ? 'mas-map-tip mas-map-tip-wall' : 'mas-map-tip',
      });
      if (!wall) marker.on('click', () => router.push(`/sites/${encodeURIComponent(s.code)}`));
      marker.addTo(g);
    }
    if ((wall || !fitted.current) && points.length && config.mode === 'tiles') {
      m.fitBounds(leaflet.latLngBounds(points), { padding: [40, 40], maxZoom: 11 });
      fitted.current = true;
    }
  };

  useEffect(draw);

  const missing = sites.filter((s) => !placed(s, config)).length;
  return (
    <div>
      <div
        ref={el}
        style={{ height }}
        className="w-full overflow-hidden rounded-lg border border-white/10 bg-slate-900"
        role="img"
        aria-label={`Map of ${sites.length} sites`}
      />
      <div
        className={`mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-slate-300 ${wall ? 'text-[28px]' : 'text-xs'}`}
      >
        {(['bad', 'warn', 'maintenance', 'ok'] as const).map((l) => (
          <span key={l} className="inline-flex items-center gap-2">
            <LevelIcon level={l} size={wall ? 30 : 14} />
            {LEVEL[l].label}
          </span>
        ))}
        {missing > 0 && !wall && (
          <span className="text-slate-500">
            {missing} site{missing === 1 ? '' : 's'} not on the map (no{' '}
            {config.mode === 'image' ? 'map position' : 'coordinates'} in the Site Profile)
          </span>
        )}
      </div>
    </div>
  );
}
