/**
 * sites.geocode: place a site on the map from its address with a Nominatim-compatible search
 * service (OpenStreetMap's by default). One request per second at most, as OpenStreetMap asks;
 * each answer is stored on the site, so an address is looked up once.
 */
import {
  GEOCODE_MIN_INTERVAL_MS,
  errorMessage,
  geocodeSiteSchema,
  nominatimSearchUrl,
  parseNominatim,
  type AppConfig,
  type GeoMatch,
  type GeocodeSiteResult,
  type Logger,
} from '@mercer/core';
import { finishGeocode, getSiteRow, publishEvent, type Db } from '@mercer/db';

export class GeocodeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeocodeError';
  }
}

let nextSlot = 0;
async function waitTurn(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + GEOCODE_MIN_INTERVAL_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export async function lookupAddress(
  geocoder: NonNullable<AppConfig['map']['geocoder']>,
  query: string,
  version: string,
): Promise<GeoMatch | null> {
  await waitTurn();
  let res: Response;
  try {
    res = await fetch(nominatimSearchUrl(geocoder.url, query, geocoder.countries), {
      headers: {
        // OpenStreetMap requires an application name; no person's details are sent.
        'user-agent': `MercerAlertService/${version} (self-hosted network monitoring)`,
        accept: 'application/json',
        'accept-language': 'en',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const why =
      e.name === 'TimeoutError' || e.name === 'AbortError'
        ? 'no answer within 10 s'
        : (e.cause?.code ?? e.message);
    throw new GeocodeError(`The address lookup service is unreachable: ${why}`, true);
  }
  if (!res.ok)
    throw new GeocodeError(
      `The address lookup service returned HTTP ${res.status}`,
      res.status === 429 || res.status >= 500,
    );
  try {
    return parseNominatim(await res.json());
  } catch {
    throw new GeocodeError('The address lookup service gave an answer MAS cannot read', false);
  }
}

export async function runGeocodeSite(
  raw: unknown,
  cfg: AppConfig,
  db: Db,
  log: Logger,
): Promise<GeocodeSiteResult> {
  const { siteId } = geocodeSiteSchema.parse(raw);
  const site = await getSiteRow(db, siteId);
  if (!site) return { status: 'skipped', message: 'The site no longer exists.' };
  const geocoder = cfg.map.geocoder;
  if (!geocoder)
    return { status: 'skipped', message: 'Address lookup is off (Settings → Map & wall).' };
  // Retries of a failed lookup are welcome; anything else was superseded by a later save.
  if (!site.geoQuery || (site.geoStatus !== 'pending' && site.geoStatus !== 'failed'))
    return { status: 'skipped', message: 'Nothing to look up.' };
  const query = site.geoQuery;
  let match: GeoMatch | null;
  try {
    match = await lookupAddress(geocoder, query, cfg.version);
  } catch (err) {
    const message = errorMessage(err);
    await finishGeocode(db, siteId, query, { kind: 'failed', error: message });
    log.warn({ siteId, err: message }, 'address lookup failed');
    throw err;
  }
  if (!match) {
    await finishGeocode(db, siteId, query, { kind: 'not_found' });
    log.info({ siteId }, 'address not found');
    return {
      status: 'not_found',
      message: `“${query}” was not found. Check the address, or type the latitude and longitude.`,
    };
  }
  const stored = await finishGeocode(db, siteId, query, { kind: 'ok', match });
  if (!stored) return { status: 'skipped', message: 'The site changed meanwhile.' };
  log.info({ siteId, lat: match.lat, lon: match.lon }, 'site placed from its address');
  // Maps refresh on a config event.
  await publishEvent(db, { t: 'config' });
  return { status: 'ok', label: match.label, message: `Placed on the map: ${match.label}.` };
}
