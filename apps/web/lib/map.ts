import 'server-only';
import type { AppConfig } from '@mercer/core';
import { ASSET_KEYS, getSettingAssetInfo } from '@mercer/db';
import type { MapConfig } from '@/components/site-map';
import { server } from './server';

/** Map settings for the browser; image mode falls back to tiles until an image is uploaded. */
export async function mapConfig(
  cfg: AppConfig,
  kioskToken?: string,
): Promise<MapConfig & { problem: string | null }> {
  const base = { tileUrl: cfg.map.tileUrl, attribution: cfg.map.attribution };
  if (cfg.map.mode !== 'image') return { ...base, mode: 'tiles', image: null, problem: null };
  const info = await getSettingAssetInfo(server().db.db, ASSET_KEYS.mapImage);
  if (!info?.width || !info.height)
    return {
      ...base,
      mode: 'tiles',
      image: null,
      problem:
        'Offline map mode is on, but no map image has been uploaded (Settings → Map & wall).',
    };
  const q = new URLSearchParams({ v: info.sha256.slice(0, 12) });
  if (kioskToken) q.set('k', kioskToken);
  return {
    ...base,
    mode: 'image',
    image: { url: `/api/map-image?${q}`, width: info.width, height: info.height },
    problem: null,
  };
}
