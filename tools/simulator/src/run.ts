import pg from 'pg';
import { generateMasterKey, initLogger, loadConfig } from '@mercer/core';
import { createDb, listIncidents, noiseStats, seedReferenceData, type DbHandle } from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { buildScenario, startMockSwis, type ScenarioEnv } from '@mercer/mock-swis';
import { createWorker } from '@mercer/worker';
import type { Expectation, SimScenario } from './scenarios';

const STEP_SEC = 15;

export interface IncidentSummary {
  id: number;
  title: string;
  kind: string;
  priority: string;
  status: string;
  alertCount: number;
  seeded: boolean;
}

export interface SimResult {
  scenario: SimScenario;
  incidents: IncidentSummary[];
  noise: { rawAlerts: number; incidents: number; ratio: number | null };
  failures: string[];
  ms: number;
}

const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
  child() {
    return silent;
  },
} as never;

async function resetDatabase(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;',
    );
  } finally {
    await c.end();
  }
}

export function check(
  expect: Expectation,
  incidents: IncidentSummary[],
  noise: SimResult['noise'],
): string[] {
  const failures: string[] = [];
  const fresh = incidents.filter((i) => !i.seeded);
  if (fresh.length !== expect.incidents) {
    failures.push(
      `expected ${expect.incidents} incident(s), got ${fresh.length}: ${fresh.map((i) => `${i.priority} ${i.title}`).join(' | ')}`,
    );
  }
  const main = fresh[0];
  if (main) {
    if (main.kind !== expect.kind) failures.push(`kind: expected ${expect.kind}, got ${main.kind}`);
    if (main.priority !== expect.priority)
      failures.push(`priority: expected ${expect.priority}, got ${main.priority}`);
    if (expect.minAlerts !== undefined && main.alertCount < expect.minAlerts)
      failures.push(`alerts: expected ≥ ${expect.minAlerts}, got ${main.alertCount}`);
    if (expect.finalStatus && main.status !== expect.finalStatus)
      failures.push(`status: expected ${expect.finalStatus}, got ${main.status}`);
    if (expect.titleIncludes && !main.title.includes(expect.titleIncludes))
      failures.push(`title "${main.title}" lacks "${expect.titleIncludes}"`);
  }
  if (expect.minNoiseRatio !== undefined && (noise.ratio ?? 0) < expect.minNoiseRatio) {
    failures.push(`noise ratio: expected ≥ ${expect.minNoiseRatio}:1, got ${noise.ratio ?? 0}:1`);
  }
  return failures;
}

/**
 * Run one scenario against a throwaway database (its schemas are dropped!). Polls follow the real
 * cadence in virtual time: alerts 30 s, nodes 60 s, interfaces 180 s; correlation every 15 s.
 */
export async function runScenario(sim: SimScenario, databaseUrl: string): Promise<SimResult> {
  const started = Date.now();
  initLogger({ service: 'simulator', level: 'silent' });
  await resetDatabase(databaseUrl);
  await runMigrations(databaseUrl);
  const h: DbHandle = createDb({ url: databaseUrl, poolMax: 2, applicationName: 'mas-simulator' });
  await seedReferenceData(h.db);

  const t0 = new Date(sim.start).getTime();
  let clock = t0 - 300_000; // baseline sync five minutes before the storm
  const now = () => new Date(clock);
  const mock = await startMockSwis({ port: 0, now });
  const env = {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    MAS_MASTER_KEY: generateMasterKey(),
    LOG_LEVEL: 'silent',
    SWIS_BASE_URL: mock.url,
    SWIS_USERNAME: 'mas',
    SWIS_PASSWORD: 'mas',
    SWIS_MAX_RETRIES: '0',
    // Breaker timing is wall-clock; detect outages via virtual staleness instead.
    SWIS_BREAKER_THRESHOLD: '100000',
    SWIS_STALE_AFTER_SEC: '120',
  };
  const worker = createWorker(loadConfig(env), { scheduling: false, env, log: silent, now });
  try {
    await worker.start();
    // Baseline: everything already active is "seeded".
    for (const p of ['topology', 'nodes', 'interfaces', 'alerts', 'events'] as const)
      await worker.pollOnce(p);
    await worker.correlateOnce({ reconcile: true });

    const scenario = buildScenario(sim.mock.name, sim.mock.params);
    const envForSteps: ScenarioEnv = {
      get world() {
        return mock.world;
      },
      setOutage: (m) => mock.setOutage(m),
    };
    const applied = new Set<number>();
    for (let t = 0; t <= sim.durationSec; t += STEP_SEC) {
      clock = t0 + t * 1000;
      scenario.steps.forEach((step, i) => {
        if (!applied.has(i) && step.atSec <= t) {
          step.apply(envForSteps, now());
          applied.add(i);
        }
      });
      if (t % 30 === 0) await worker.pollOnce('alerts');
      if (t % 60 === 0) await worker.pollOnce('nodes');
      if (t % 180 === 0) await worker.pollOnce('interfaces');
      await worker.correlateOnce({ reconcile: false });
    }

    const rows = await listIncidents(h.db, { limit: 500 });
    const incidents = rows
      .filter((r) => r.resolvedBy !== 'merged')
      .map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        priority: r.priority,
        status: r.status,
        alertCount: r.alertCount,
        seeded: r.seeded,
      }))
      .sort((a, b) => a.id - b.id);
    const noise = await noiseStats(h.db, new Date(t0));
    return {
      scenario: sim,
      incidents,
      noise,
      failures: check(sim.expect, incidents, noise),
      ms: Date.now() - started,
    };
  } finally {
    await worker.stop();
    await mock.close();
    await h.close();
  }
}
