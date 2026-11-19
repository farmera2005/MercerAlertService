import pg from 'pg';
import { SecretBox, generateMasterKey, initLogger, loadConfig } from '@mercer/core';
import {
  createDb,
  listIncidents,
  listPeople,
  noiseStats,
  saveChannel,
  savePerson,
  seedReferenceData,
  type DbHandle,
} from '@mercer/db';
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

export interface NotifySummary {
  channels: string[];
  pages: number;
  escalations: number;
}

export interface AiSummary {
  summaries: number;
  priorityChecks: number;
  costUsd: number;
}

export interface SimResult {
  scenario: SimScenario;
  incidents: IncidentSummary[];
  noise: { rawAlerts: number; incidents: number; ratio: number | null };
  notify: NotifySummary;
  ai: AiSummary;
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
  notify?: NotifySummary,
  ai?: AiSummary,
): string[] {
  const failures: string[] = [];
  if (expect.ai && ai) {
    if (ai.summaries < 1) failures.push('AI: expected at least one summary, got none');
    if (ai.summaries > expect.ai.maxSummaries)
      failures.push(`AI: expected ≤ ${expect.ai.maxSummaries} summaries, got ${ai.summaries}`);
  }
  if (expect.notify && notify) {
    const want = [...expect.notify.channels].sort().join(', ');
    const got = [...notify.channels].sort().join(', ');
    if (want !== got) failures.push(`Teams channels: expected [${want}], got [${got}]`);
    if (expect.notify.paged !== notify.pages > 0)
      failures.push(
        `paging: expected ${expect.notify.paged ? 'a page' : 'no page'}, got ${notify.pages}`,
      );
    if (expect.notify.escalated !== undefined && expect.notify.escalated !== notify.escalations > 0)
      failures.push(
        `escalation: expected ${expect.notify.escalated ? 'one' : 'none'}, got ${notify.escalations}`,
      );
  }
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
  const masterKey = generateMasterKey();
  const system = { actorType: 'system' as const, actorLabel: 'simulator' };
  // Default channels and rules, every channel pointed at the mock's Teams sink, everyone on SMS.
  for (const key of ['net-critical', 'net-alerts', 'mas-shadow'])
    await saveChannel(
      h.db,
      SecretBox.fromBase64(masterKey),
      {
        key,
        name: key,
        description: null,
        enabled: true,
        webhookUrl: `${mock.url}/__mock/sink/${key}`,
      },
      system,
    );
  for (const [i, p] of (await listPeople(h.db)).entries())
    await savePerson(h.db, p.id, { ...p, pageVia: 'sms', phoneE164: `+1419555020${i}` }, system);
  const env = {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    MAS_MASTER_KEY: masterKey,
    APP_BASE_URL: 'https://mas.example',
    NOTIFY_SHADOW_MODE: 'false',
    NOTIFY_ALLOW_HTTP: 'true',
    TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32),
    TWILIO_AUTH_TOKEN: 'sim',
    TWILIO_FROM: '+14195550100',
    TWILIO_API_BASE: `${mock.url}/__mock/twilio`,
    LOG_LEVEL: 'silent',
    SWIS_BASE_URL: mock.url,
    SWIS_USERNAME: 'mas',
    SWIS_PASSWORD: 'mas',
    SWIS_MAX_RETRIES: '0',
    // Breaker timing is wall-clock; detect outages via virtual staleness instead.
    SWIS_BREAKER_THRESHOLD: '100000',
    SWIS_STALE_AFTER_SEC: '120',
    // The mock's fake Claude: deterministic answers, real call accounting.
    ANTHROPIC_API_KEY: 'sim',
    ANTHROPIC_BASE_URL: `${mock.url}/__mock/anthropic`,
  };
  const worker = createWorker(loadConfig(env), { scheduling: false, env, log: silent, now });
  try {
    await worker.start();
    // Baseline: everything already active is "seeded".
    for (const p of ['topology', 'groups', 'nodes', 'interfaces', 'alerts', 'events'] as const)
      await worker.pollOnce(p);
    await worker.correlateOnce({ reconcile: true });
    await worker.notifyOnce();
    mock.sinks.clear();

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
      await worker.notifyOnce();
      // The real worker debounces per incident (45 s); a once-a-minute pass is the same here.
      if (t % 60 === 0) {
        await worker.aiOnce();
        await worker.notifyOnce();
      }
    }
    await worker.aiOnce();

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
    const smsBodies = mock.sinks.records
      .filter((r) => r.sink === 'twilio')
      .map((r) => String((r.body as { Body?: string }).Body ?? ''));
    const notify: NotifySummary = {
      channels: [
        ...new Set(
          mock.sinks.records.filter((r) => r.sink.startsWith('teams:')).map((r) => r.sink.slice(6)),
        ),
      ],
      pages: smsBodies.filter((b) => !b.startsWith('RESOLVED')).length,
      escalations: smsBodies.filter((b) => b.startsWith('ESCALATED')).length,
    };
    const calls = await h.pool.query<{ purpose: string; n: number; usd: string }>(
      `select purpose, count(*)::int as n, coalesce(sum(cost_usd),0) as usd from ai_calls group by purpose`,
    );
    const ai: AiSummary = {
      summaries: calls.rows.find((r) => r.purpose === 'summary')?.n ?? 0,
      priorityChecks: calls.rows.find((r) => r.purpose === 'severity')?.n ?? 0,
      costUsd: calls.rows.reduce((sum, r) => sum + Number(r.usd), 0),
    };
    return {
      scenario: sim,
      incidents,
      noise,
      notify,
      ai,
      failures: check(sim.expect, incidents, noise, notify, ai),
      ms: Date.now() - started,
    };
  } finally {
    await worker.stop();
    await mock.close();
    await h.close();
  }
}
