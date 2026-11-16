/**
 * Online setup: the worker starts with only a database, and everything else arrives through
 * settings saved by the web wizard. Requires DATABASE_URL_TEST (schema is dropped).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  generateMasterKey,
  initLogger,
  INTERNAL_SETTING_KEYS,
  loadConfig,
  SecretBox,
} from '@mercer/core';
import {
  createDb,
  getInternalSetting,
  loadSettings,
  saveSettings,
  seedReferenceData,
  type DbHandle,
} from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { startMockSwis, type MockSwis } from '@mercer/mock-swis';
import { runCertJob, runDiscoverJob, runTestJob } from './setup-jobs';
import { createWorker, type Worker } from './worker';

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
const admin = { actorType: 'user' as const, actorId: '1', actorLabel: 'admin' };

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!url)('online setup (integration)', () => {
  let mock: MockSwis;
  let worker: Worker;
  let h: DbHandle;
  let box: SecretBox;
  const env = { DATABASE_URL: url, LOG_LEVEL: 'silent', MAS_MASTER_KEY: generateMasterKey() };

  beforeAll(async () => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
    await c.end();
    await runMigrations(url!);
    h = createDb({ url: url!, poolMax: 2 });
    await seedReferenceData(h.db);
    mock = await startMockSwis({ port: 0 });
    box = SecretBox.fromBase64(env.MAS_MASTER_KEY);
    worker = createWorker(loadConfig(env), { scheduling: false, log: silent, env });
    await worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await mock?.close();
    await h?.close();
  });

  it('starts with no Orion configuration and waits for setup', async () => {
    expect(worker.mode).toBe('awaiting_setup');
    expect(worker.ctx).toBeNull();
    expect(await worker.pollOnce('alerts')).toBeNull();
    const health = await worker.health();
    expect(health.ok).toBe(true);
    expect(health.details.mode).toBe('awaiting_setup');
  });

  it('tests a candidate connection before anything is saved, with actionable hints', async () => {
    const bad = await runTestJob(
      { baseUrl: mock.url, username: 'mas', passwordSealed: box.seal('wrong') },
      worker.cfg,
      box,
      h.db,
      silent,
    );
    expect(bad).toMatchObject({ ok: false, field: 'SWIS_PASSWORD' });
    expect(bad.hint).toMatch(/username or password/);
    const refused = await runTestJob(
      { baseUrl: 'http://127.0.0.1:1', username: 'mas', passwordSealed: box.seal('mas') },
      worker.cfg,
      box,
      h.db,
      silent,
    );
    expect(refused).toMatchObject({ ok: false, field: 'SWIS_PORT' });
    const good = await runTestJob(
      { baseUrl: mock.url, username: 'mas', passwordSealed: box.seal('mas') },
      worker.cfg,
      box,
      h.db,
      silent,
    );
    expect(good).toMatchObject({ ok: true, nodes: mock.world.nodes.length });
  });

  it('applies saved settings (secrets encrypted at rest) and starts polling once setup completes', async () => {
    await saveSettings(
      h.db,
      [
        { key: 'SWIS_BASE_URL', value: mock.url },
        { key: 'SWIS_USERNAME', value: 'mas' },
        { key: 'SWIS_PASSWORD', value: 'mas' },
        { key: 'SWIS_POLL_ALERTS_SEC', value: '45' },
      ],
      admin,
      box,
    );
    const raw = await h.pool.query(`select value from app_settings where key = 'SWIS_PASSWORD'`);
    expect(JSON.stringify(raw.rows[0].value)).not.toContain('"mas"');
    expect((await loadSettings(h.db, box)).values.SWIS_PASSWORD).toBe('mas');
    const audit = await h.pool.query(
      `select after from audit_log where action = 'settings.update' order by id desc limit 1`,
    );
    expect(audit.rows[0].after.SWIS_PASSWORD).toBe('[secret]');

    await worker.reloadConfig();
    expect(worker.cfg.swis.pollSec.alerts).toBe(45);
    expect(worker.ctx).not.toBeNull(); // connection usable (discovery, tests)…
    expect(worker.mode).toBe('awaiting_setup'); // …but no polling until the wizard is finished

    const disc = await runDiscoverJob({}, worker.cfg, box, h.db, silent);
    expect(disc.ok).toBe(true);
    const stored = await getInternalSetting<{
      report: { customProperties: Array<{ field: string }> };
    }>(h.db, INTERNAL_SETTING_KEYS.lastDiscovery);
    expect(stored?.report.customProperties.map((c) => c.field)).toContain('Site');

    await saveSettings(h.db, [{ key: 'MAS_SETUP_COMPLETE', value: 'true' }], admin, box);
    await worker.reloadConfig();
    expect(worker.mode).toBe('monitoring');
    expect(await worker.pollOnce('topology')).not.toBeNull();
    expect(await worker.pollOnce('nodes')).not.toBeNull();
    const n = await h.pool.query('select count(*)::int as n from orion_nodes');
    expect(n.rows[0].n).toBe(mock.world.nodes.length);
  });

  it('rebuilds the SWIS client when the connection changes', async () => {
    const before = worker.ctx!.swis.client;
    await saveSettings(h.db, [{ key: 'SWIS_PASSWORD', value: 'changed' }], admin, box);
    await worker.reloadConfig();
    expect(worker.ctx!.swis.client).not.toBe(before);
    expect(await worker.pollOnce('alerts')).toBeNull(); // wrong password → poll fails (recorded)
    await saveSettings(h.db, [{ key: 'SWIS_PASSWORD', value: 'mas' }], admin, box);
    await worker.reloadConfig();
    expect(await worker.pollOnce('alerts')).not.toBeNull();
  });

  it('keeps the previous config when a saved value is invalid', async () => {
    await h.pool.query(
      `insert into app_settings (key, value) values ('SWIS_POLL_ALERTS_SEC', '{"v":"1"}') on conflict (key) do update set value = excluded.value`,
    );
    await worker.reloadConfig();
    expect(worker.cfg.swis.pollSec.alerts).toBe(45);
    expect(worker.mode).toBe('monitoring');
    await h.pool.query(`delete from app_settings where key = 'SWIS_POLL_ALERTS_SEC'`);
  });

  it.skipIf(!haveOpenssl())(
    'fetches the server certificate so it can be trusted, then connects with it',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mas-tls-'));
      const cnf = join(dir, 'c.cnf');
      // Self-signed like Orion's default certificate: the CN is not the host name.
      writeFileSync(
        cnf,
        '[req]\ndistinguished_name=dn\n[dn]\n[ext]\nsubjectAltName=DNS:SolarWinds-Orion\nbasicConstraints=critical,CA:TRUE\n',
      );
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '2',
          '-subj',
          '/CN=SolarWinds-Orion',
          '-keyout',
          join(dir, 'k.pem'),
          '-out',
          join(dir, 'c.pem'),
          '-config',
          cnf,
          '-extensions',
          'ext',
        ],
        { stdio: 'ignore' },
      );
      const tlsMock = await startMockSwis({
        port: 0,
        tlsCert: join(dir, 'c.pem'),
        tlsKey: join(dir, 'k.pem'),
      });
      const port = Number(new URL(tlsMock.url).port);
      try {
        const cert = await runCertJob({ host: '127.0.0.1', port, servername: '' }, worker.cfg, box);
        expect(cert.ok).toBe(true);
        if (!cert.ok) return;
        expect(cert.report.trusted).toBe(false);
        expect(cert.report.recommended.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
        expect(cert.report.suggestedServername).toBe('SolarWinds-Orion');

        const untrusted = await runTestJob(
          {
            host: '127.0.0.1',
            port,
            username: 'mas',
            passwordSealed: box.seal('mas'),
            caCertPem: '',
          },
          worker.cfg,
          box,
          h.db,
          silent,
        );
        expect(untrusted).toMatchObject({ ok: false, field: 'SWIS_CA_CERT_PEM' });
        const trusted = await runTestJob(
          {
            host: '127.0.0.1',
            port,
            username: 'mas',
            passwordSealed: box.seal('mas'),
            caCertPem: cert.report.recommended.pem,
            servername: cert.report.suggestedServername!,
          },
          worker.cfg,
          box,
          h.db,
          silent,
        );
        expect(trusted).toMatchObject({ ok: true, tlsVerification: 'enabled' });
      } finally {
        await tlsMock.close();
      }
    },
  );
});
