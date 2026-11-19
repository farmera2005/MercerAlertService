/**
 * Placing sites on the map from their address (fake Nominatim in mock-swis → worker job →
 * Postgres). Requires DATABASE_URL_TEST (a throwaway database; the public schema is dropped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { generateMasterKey, initLogger, loadConfig } from '@mercer/core';
import {
  createDb,
  createSite,
  finishGeocode,
  getSiteRow,
  requestUnplacedGeocodes,
  seedReferenceData,
  updateSite,
  type DbHandle,
} from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { startMockSwis, type MockSwis } from '@mercer/mock-swis';
import { runGeocodeSite } from './geocode';

const url = process.env.DATABASE_URL_TEST;
initLogger({ service: 'test', level: 'silent' });
const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  child() {
    return silent;
  },
} as never;
const admin = { actorType: 'user' as const, actorId: 'local:1', actorLabel: 'local:admin' };
const base = { tier: 'standard' as const, harvestCritical: false, aliases: [] };

describe.skipIf(!url)('site addresses on the map (integration)', () => {
  let mock: MockSwis;
  let h: DbHandle;
  let env: Record<string, string>;
  const cfg = () => loadConfig(env);
  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.pool.query(text, values)).rows as T[];

  beforeAll(async () => {
    const pgAdmin = new pg.Client({ connectionString: url });
    await pgAdmin.connect();
    await pgAdmin.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
    await pgAdmin.end();
    await runMigrations(url!);
    h = createDb({ url: url!, poolMax: 2 });
    await seedReferenceData(h.db);
    mock = await startMockSwis({ port: 0 });
    env = {
      DATABASE_URL: url!,
      SWIS_BASE_URL: mock.url,
      LOG_LEVEL: 'silent',
      MAS_MASTER_KEY: generateMasterKey(),
      MAP_GEOCODER_URL: `${mock.url}/__mock/nominatim`,
    };
  });

  afterAll(async () => {
    await mock?.close();
    await h?.close();
  });

  it('places a new site from its address, once, and audits the move', async () => {
    const site = await createSite(
      h.db,
      { ...base, name: 'Geo Test One', address: '100 W Main St, Rockford, OH 45882' },
      admin,
    );
    expect(site.geoStatus).toBe('pending');
    const r = await runGeocodeSite({ siteId: site.id }, cfg(), h.db, silent);
    expect(r).toMatchObject({
      status: 'ok',
      label: '100 W Main St, Rockford, OH 45882, Ohio, United States',
    });
    const after = (await getSiteRow(h.db, site.id))!;
    expect(after).toMatchObject({ geoStatus: 'ok', geoQuery: '100 W Main St, Rockford, OH 45882' });
    expect(after.lat).toBeGreaterThan(40);
    expect(after.lon).toBeLessThan(-84);
    const [req] = mock.nominatim.requests;
    expect(req).toMatchObject({ q: '100 W Main St, Rockford, OH 45882', countrycodes: 'us' });
    expect(req!.userAgent).toMatch(/^MercerAlertService\//);
    const audit = await q<{ after: { lat: number } }>(
      `select after from audit_log where action = 'site.geocode' and target_id = $1`,
      [String(site.id)],
    );
    expect(audit[0]!.after.lat).toBe(after.lat);

    // Saving again without changing the address looks nothing up.
    const again = await updateSite(h.db, site.id, { tier: 'high' }, admin);
    expect(again!.geoStatus).toBe('ok');
    expect(await runGeocodeSite({ siteId: site.id }, cfg(), h.db, silent)).toMatchObject({
      status: 'skipped',
    });
    expect(mock.nominatim.requests).toHaveLength(1);
  });

  it('reports an address that is not found, and keeps typed coordinates', async () => {
    const site = await createSite(
      h.db,
      { ...base, name: 'Geo Test Two', address: 'Nowhere Rd' },
      admin,
    );
    const r = await runGeocodeSite({ siteId: site.id }, cfg(), h.db, silent);
    expect(r.status).toBe('not_found');
    expect(await getSiteRow(h.db, site.id)).toMatchObject({ geoStatus: 'not_found', lat: null });

    const typed = await updateSite(
      h.db,
      site.id,
      { address: '5 Elm St, Celina, OH', lat: 40.55, lon: -84.57 },
      admin,
    );
    expect(typed).toMatchObject({ geoStatus: 'manual', lat: 40.55, lon: -84.57 });
    expect(await runGeocodeSite({ siteId: site.id }, cfg(), h.db, silent)).toMatchObject({
      status: 'skipped',
    });
    expect(await getSiteRow(h.db, site.id)).toMatchObject({ lat: 40.55, lon: -84.57 });
  });

  it('records a failing service and lets the job retry', async () => {
    const site = await createSite(
      h.db,
      { ...base, name: 'Geo Test Three', address: 'error503 Way' },
      admin,
    );
    await expect(runGeocodeSite({ siteId: site.id }, cfg(), h.db, silent)).rejects.toThrow(
      /HTTP 503/,
    );
    expect(await getSiteRow(h.db, site.id)).toMatchObject({ geoStatus: 'failed' });
    expect((await getSiteRow(h.db, site.id))!.geoError).toMatch(/HTTP 503/);
  });

  it('ignores a result for an address that has since changed', async () => {
    const site = await createSite(
      h.db,
      { ...base, name: 'Geo Test Four', address: 'Old Rd, Celina, OH' },
      admin,
    );
    await updateSite(h.db, site.id, { address: 'New Rd, Celina, OH' }, admin);
    const stale = await finishGeocode(h.db, site.id, 'Old Rd, Celina, OH', {
      kind: 'ok',
      match: { lat: 1, lon: 1, label: 'old' },
    });
    expect(stale).toBe(false);
    expect(await getSiteRow(h.db, site.id)).toMatchObject({
      lat: null,
      geoQuery: 'New Rd, Celina, OH',
    });
  });

  it('queues every site without coordinates, by city when there is no address', async () => {
    const site = await createSite(
      h.db,
      { ...base, name: 'Geo Test Five', city: 'Fort Recovery', state: 'OH' },
      admin,
    );
    const ids = await requestUnplacedGeocodes(h.db, admin);
    expect(ids).toContain(site.id);
    expect(await getSiteRow(h.db, site.id)).toMatchObject({
      geoStatus: 'pending',
      geoQuery: 'Fort Recovery, OH',
    });
    // One request per second, as OpenStreetMap asks.
    const before = mock.nominatim.requests.length;
    for (const id of ids.slice(0, 2))
      await runGeocodeSite({ siteId: id }, cfg(), h.db, silent).catch(() => {});
    const [a, b] = mock.nominatim.requests.slice(before);
    expect(new Date(b!.at).getTime() - new Date(a!.at).getTime()).toBeGreaterThanOrEqual(1000);
  });

  it('does nothing when address lookup is off', async () => {
    const site = await createSite(
      h.db,
      { ...base, name: 'Geo Test Six', address: '1 Main St' },
      admin,
    );
    const off = loadConfig({ ...env, MAP_ADDRESS_LOOKUP: 'false' });
    expect(await runGeocodeSite({ siteId: site.id }, off, h.db, silent)).toMatchObject({
      status: 'skipped',
      message: expect.stringMatching(/off/),
    });
  });
});
