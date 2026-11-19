/**
 * A fake Nominatim search API at /__mock/nominatim/search, so tests never call OpenStreetMap.
 * Any query is found at a stable point in western Ohio, except: one containing "nowhere" matches
 * nothing, and one containing "error503" fails. GET /__mock/nominatim lists the requests.
 */
import type { IncomingHttpHeaders } from 'node:http';

export interface NominatimRequest {
  q: string;
  countrycodes: string | null;
  userAgent: string | null;
  at: string;
}

export interface FakeNominatim {
  requests: NominatimRequest[];
  clear(): void;
  handle(
    method: string,
    path: string,
    url: URL,
    headers: IncomingHttpHeaders,
  ): [number, unknown] | null;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function createFakeNominatim(): FakeNominatim {
  const requests: NominatimRequest[] = [];
  return {
    requests,
    clear() {
      requests.length = 0;
    },
    handle(method, path, url, headers) {
      if (path === 'nominatim' && method === 'GET') return [200, { requests }];
      if (path === 'nominatim' && method === 'DELETE') {
        requests.length = 0;
        return [200, { ok: true }];
      }
      if (path !== 'nominatim/search' || method !== 'GET') return null;
      const q = url.searchParams.get('q') ?? '';
      const ua = headers['user-agent'];
      requests.push({
        q,
        countrycodes: url.searchParams.get('countrycodes'),
        userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null),
        at: new Date().toISOString(),
      });
      if (url.searchParams.get('format') !== 'jsonv2') return [400, { error: 'format' }];
      if (/error503/i.test(q)) return [503, { error: 'Service Unavailable' }];
      if (!q.trim() || /nowhere/i.test(q)) return [200, []];
      const h = hash(q);
      const lat = 40.2 + (h % 8000) / 10000;
      const lon = -85.0 + (Math.floor(h / 8000) % 8000) / 10000;
      return [
        200,
        [
          {
            place_id: h,
            lat: lat.toFixed(7),
            lon: lon.toFixed(7),
            display_name: `${q}, Ohio, United States`,
          },
        ],
      ];
    },
  };
}
