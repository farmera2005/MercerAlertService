/**
 * Placing sites on the map from their address. The worker asks a Nominatim-compatible search
 * service (OpenStreetMap's by default); this module holds the pure parts: what to look up, when,
 * and how to read the answer.
 */
import { z } from 'zod';

export interface GeoFields {
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
}

/** The text a site is looked up by: its address, else its city and state. */
export function geocodeQuery(site: Pick<GeoFields, 'address' | 'city' | 'state'>): string | null {
  const address = site.address?.replace(/\s+/g, ' ').trim();
  if (address) return address.slice(0, 300);
  const city = site.city?.trim();
  if (!city) return null;
  const state = site.state?.trim();
  return state ? `${city}, ${state}` : city;
}

export type GeoPlan =
  /** Look the query up and move the site there. */
  | { action: 'lookup'; query: string }
  /** Coordinates were typed: keep them, and don't look this query up later. */
  | { action: 'manual'; query: string | null }
  | { action: 'none' };

const sameCoords = (a: Pick<GeoFields, 'lat' | 'lon'>, b: Pick<GeoFields, 'lat' | 'lon'>) =>
  a.lat === b.lat && a.lon === b.lon;

/**
 * What a save means for the site's place on the map (`before` is null for a new site):
 *
 * - Coordinates typed in this save win.
 * - Otherwise a site without coordinates is looked up, and so is one whose address (or city)
 *   changed in this save. Clearing the coordinates is how to ask for a fresh lookup. Other edits
 *   never move a site.
 */
export function planGeocode(before: GeoFields | null, after: GeoFields): GeoPlan {
  const query = geocodeQuery(after);
  const hasCoords = after.lat !== null && after.lon !== null;
  const typed = hasCoords && (before === null || !sameCoords(before, after));
  if (typed) return { action: 'manual', query };
  if (!query) return { action: 'none' };
  if (!hasCoords || (before !== null && geocodeQuery(before) !== query))
    return { action: 'lookup', query };
  return { action: 'none' };
}

/** Nominatim /search?format=jsonv2; extra fields are ignored. */
const nominatimResults = z.array(
  z.object({
    lat: z.coerce.number().min(-90).max(90),
    lon: z.coerce.number().min(-180).max(180),
    display_name: z.string().max(1000),
  }),
);

export interface GeoMatch {
  lat: number;
  lon: number;
  /** The place the service matched, e.g. "Rockford, Mercer County, Ohio, United States". */
  label: string;
}

/** The best match, null when nothing matched; throws on an answer that isn't Nominatim's. */
export function parseNominatim(body: unknown): GeoMatch | null {
  const first = nominatimResults.parse(body)[0];
  if (!first) return null;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { lat: round(first.lat), lon: round(first.lon), label: first.display_name };
}

export function nominatimSearchUrl(base: string, query: string, countries: string[]): string {
  const q = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1' });
  if (countries.length) q.set('countrycodes', countries.join(','));
  return `${base.replace(/\/+$/, '')}/search?${q}`;
}

/** OpenStreetMap asks for at most one request per second to its public service. */
export const GEOCODE_MIN_INTERVAL_MS = 1100;
