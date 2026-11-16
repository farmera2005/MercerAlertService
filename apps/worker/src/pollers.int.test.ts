/**
 * End-to-end ingestion: mock SWIS → pollers → Postgres.
 * Requires DATABASE_URL_TEST (a throwaway database; the public schema is dropped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { initLogger, loadConfig } from '@mercer/core';
import { createDb, purgeExpired, seedReferenceData, type DbHandle } from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { setNodeStatus, startMockSwis, type MockSwis } from '@mercer/mock-swis';
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

describe.skipIf(!url)('worker ingestion (integration)', () => {
  let mock: MockSwis;
  let worker: Worker;
  let h: DbHandle;
  const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> =>
    (await h.pool.query(text)).rows as T[];
  const one = async <T = Record<string, unknown>>(text: string): Promise<T> =>
    (await q<T>(text))[0]!;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
    await admin.end();
    await runMigrations(url!);
    h = createDb({ url: url!, poolMax: 2 });
    await seedReferenceData(h.db);
    mock = await startMockSwis({ port: 0 });
    const cfg = loadConfig({
      DATABASE_URL: url,
      SWIS_BASE_URL: mock.url,
      SWIS_USERNAME: 'mas',
      SWIS_PASSWORD: 'mas',
      SWIS_MAX_RETRIES: '0',
      SWIS_BREAKER_THRESHOLD: '2',
      SWIS_BREAKER_COOLDOWN_MS: '1000',
      SWIS_PAGE_SIZE: '25',
      SWIS_STALE_AFTER_SEC: '60',
      LOG_LEVEL: 'silent',
    });
    worker = createWorker(cfg, { scheduling: false, log: silent });
    await worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await mock?.close();
    await h?.close();
  });

  it('runs the initial sync and maps nodes to sites, divisions and roles', async () => {
    for (const p of ['topology', 'nodes', 'interfaces', 'alerts', 'events'] as const) {
      const r = await worker.pollOnce(p);
      expect(r, `poller ${p}`).not.toBeNull();
    }
    const { n } = await one<{ n: number }>('select count(*)::int as n from orion_nodes');
    expect(n).toBe(mock.world.nodes.length);

    const rows = await q<{
      caption: string;
      code: string | null;
      division_code: string | null;
      site_source: string;
      device_role: string;
    }>(
      `select n.caption, s.code, n.division_code, n.site_source, n.device_role
         from orion_nodes n left join sites s on s.id = n.site_id
        where n.caption in ('ROCK-FW01','ROCK-SCALE01','MEN-SW01','CEL-CORE01','COLD-UPS01','MPS-AP01','SPV-FW01','VWRT-RTR01')
        order by n.caption`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.caption, r]));
    expect(by['ROCK-FW01']).toMatchObject({
      code: 'rockford',
      division_code: 'grain',
      site_source: 'custom_property',
      device_role: 'firewall',
    });
    expect(by['ROCK-SCALE01']).toMatchObject({ device_role: 'scale_system' });
    expect(by['MEN-SW01']).toMatchObject({
      code: 'mendon',
      site_source: 'caption',
      division_code: 'grain',
    });
    expect(by['CEL-CORE01']).toMatchObject({
      code: 'celina-hq',
      device_role: 'core_switch',
      division_code: 'corporate',
    });
    expect(by['COLD-UPS01']).toMatchObject({ device_role: 'ups' });
    expect(by['MPS-AP01']).toMatchObject({
      code: 'mps-st-marys',
      division_code: 'mps_feed',
      device_role: 'access_point',
    });
    expect(by['VWRT-RTR01']).toMatchObject({
      code: 'van-wert',
      division_code: 'agronomy',
      device_role: 'router',
    });
    // Unknown "Spencerville" site value → auto-created placeholder profile.
    expect(by['SPV-FW01']).toMatchObject({ code: 'spencerville', site_source: 'custom_property' });
    const [auto] = await q<{ profile_status: string }>(
      `select profile_status from sites where code = 'spencerville'`,
    );
    expect(auto?.profile_status).toBe('auto');
    const [audit] = await q<{ n: number }>(
      `select count(*)::int as n from audit_log where action = 'site.auto_create'`,
    );
    expect(audit?.n).toBe(1);

    // Dependencies resolved to node / group IDs; groups and members stored.
    const deps = await q<{ parent_node_id: number; child_container_id: number }>(
      'select parent_node_id, child_container_id from orion_dependencies',
    );
    expect(deps.length).toBeGreaterThan(5);
    expect(deps.every((d) => d.parent_node_id > 0 && d.child_container_id > 0)).toBe(true);
    const { m } = await one<{ m: number }>(
      'select count(*)::int as m from orion_group_members where node_id is not null',
    );
    expect(m).toBeGreaterThan(30);

    // Already-active alerts are recorded as raised with initialSync.
    const raised = await q<{ details: { initialSync?: boolean }; site_id: number | null }>(
      `select details, site_id from entity_transitions where kind = 'alert' and change = 'raised'`,
    );
    expect(raised).toHaveLength(3);
    expect(raised.every((r) => r.details.initialSync === true && r.site_id !== null)).toBe(true);

    // First-seen unhealthy interfaces (unused wan2) produce transitions; healthy ones do not.
    const { ifaceT } = await one<{ ifaceT: number }>(
      `select count(*)::int as "ifaceT" from entity_transitions where kind = 'interface'`,
    );
    expect(ifaceT).toBe(mock.world.interfaces.filter((i) => i.Status !== 1).length);

    const { metrics } = await one<{ metrics: number }>(
      'select count(*)::int as metrics from node_metrics_5m',
    );
    expect(metrics).toBe(mock.world.nodes.length);
    const { ev } = await one<{ ev: number }>('select count(*)::int as ev from orion_events');
    expect(ev).toBe(mock.world.events.length);
    const states = await q<{ poller: string; consecutive_failures: number }>(
      'select poller, consecutive_failures from poller_state',
    );
    expect(states.map((s) => s.poller).sort()).toEqual([
      'alerts',
      'events',
      'interfaces',
      'nodes',
      'topology',
    ]);
  });

  it('records a WAN-down storm as transitions and is idempotent on re-poll', async () => {
    const before = (
      await q<{ id: number }>('select coalesce(max(id),0)::int as id from entity_transitions')
    )[0]!.id;
    mock.applyScenario('site-wan-down', { site: 'ROCK', childAlerts: 30 });
    await worker.pollOnce('alerts');
    await worker.pollOnce('nodes');
    await worker.pollOnce('interfaces');
    const rows = await q<{ kind: string; change: string; to_state: string; n: number }>(
      `select kind, change, to_state, count(*)::int as n from entity_transitions where id > ${before} group by 1,2,3 order by 1,2,3`,
    );
    const get = (kind: string, change: string, to: string) =>
      rows.find((r) => r.kind === kind && r.change === change && r.to_state === to)?.n ?? 0;
    expect(get('alert', 'raised', 'active')).toBe(31); // FortiGate + 30 child alerts
    expect(get('node', 'status', 'down')).toBe(1);
    expect(get('node', 'status', 'unreachable')).toBe(6); // Rockford has a dependency → children Unreachable
    const { rock } = await one<{ rock: number }>(
      `select count(distinct site_id)::int as rock from entity_transitions where id > ${before} and kind = 'alert'`,
    );
    expect(rock).toBe(1);

    const mid = (await q<{ id: number }>('select max(id)::int as id from entity_transitions'))[0]!
      .id;
    await worker.pollOnce('alerts');
    await worker.pollOnce('nodes');
    const { none } = await one<{ none: number }>(
      `select count(*)::int as none from entity_transitions where id > ${mid}`,
    );
    expect(none).toBe(0);
  });

  it('raises "source down" when SWIS fails and never clears alerts on a failed poll', async () => {
    const { active } = await one<{ active: number }>(
      'select count(*)::int as active from orion_active_alerts',
    );
    mock.setOutage('503');
    expect(await worker.pollOnce('alerts')).toBeNull();
    expect(await worker.pollOnce('alerts')).toBeNull(); // breaker opens (threshold 2)
    expect(await worker.pollOnce('alerts')).toBeNull(); // skipped: circuit open
    const { still } = await one<{ still: number }>(
      'select count(*)::int as still from orion_active_alerts',
    );
    expect(still).toBe(active);
    const down = await q<{ to_state: string }>(
      `select to_state from entity_transitions where kind = 'source' order by id`,
    );
    expect(down.map((d) => d.to_state)).toEqual(['down']);
    const [ps] = await q<{ consecutive_failures: number; last_error: string }>(
      `select consecutive_failures, last_error from poller_state where poller = 'alerts'`,
    );
    expect(ps!.consecutive_failures).toBe(3);
    const runs = await q<{ status: string }>(
      `select status from poll_runs where poller = 'alerts' order by id desc limit 3`,
    );
    expect(runs.map((r) => r.status)).toEqual(['skipped', 'error', 'error']);

    mock.setOutage('none');
    await new Promise((r) => setTimeout(r, 1100)); // breaker cooldown → half-open
    expect(await worker.pollOnce('alerts')).not.toBeNull();
    const all = await q<{ to_state: string }>(
      `select to_state from entity_transitions where kind = 'source' order by id`,
    );
    expect(all.map((d) => d.to_state)).toEqual(['down', 'up']);
    const [hb] = await q<{ status: string }>(
      `select status from component_heartbeats where component = 'swis'`,
    );
    expect(hb!.status).toBe('up');
  });

  it('records clears and recovery, and purges expired raw data', async () => {
    const before = (
      await q<{ id: number }>('select max(id)::int as id from entity_transitions')
    )[0]!.id;
    for (const id of mock.world.siteNodes.get('ROCK')!)
      setNodeStatus(mock.world, id, 1, new Date());
    mock.world.alertActive.splice(0, mock.world.alertActive.length);
    expect(await worker.pollOnce('alerts')).not.toBeNull();
    expect(await worker.pollOnce('nodes')).not.toBeNull();
    const rows = await q<{ change: string; to_state: string; n: number }>(
      `select change, to_state, count(*)::int as n from entity_transitions where id > ${before} group by 1,2`,
    );
    expect(rows.find((r) => r.change === 'cleared')?.n).toBeGreaterThanOrEqual(31);
    expect(rows.find((r) => r.change === 'status' && r.to_state === 'up')?.n).toBe(7);
    const { active } = await one<{ active: number }>(
      'select count(*)::int as active from orion_active_alerts',
    );
    expect(active).toBe(0);

    await h.db.execute(
      sql`update entity_transitions set observed_at = now() - interval '120 days' where id <= ${before}`,
    );
    const purged = await purgeExpired(h.db, { rawDays: 90, pollRunsDays: 30, auditDays: 730 });
    expect(purged.entity_transitions).toBe(before);
  });
});
