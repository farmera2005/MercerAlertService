/**
 * The AI layer end to end against the mock's fake Anthropic API: mock SWIS → pollers →
 * correlation → templated notification first → AI summary + priority check → follow-up card;
 * failures fall back to templates and retry later; digests are posted to #net-digest.
 * Requires DATABASE_URL_TEST (wiped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { SecretBox, generateMasterKey, initLogger, loadConfig } from '@mercer/core';
import { createDb, saveChannel, seedReferenceData, type DbHandle } from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { startMockSwis, type MockSwis } from '@mercer/mock-swis';
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
const actor = {
  actorType: 'user' as const,
  actorId: 'local:1',
  actorLabel: 'local:test',
  ip: null,
  userAgent: null,
};

describe.skipIf(!url)('AI layer (integration)', () => {
  let mock: MockSwis;
  let worker: Worker;
  let h: DbHandle;
  let clock = Date.now();
  const now = () => new Date(clock);
  let p1 = 0;
  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.pool.query(text, values)).rows as T[];
  const posted = (channel: string) =>
    mock.sinks.records
      .filter((r) => r.sink === `teams:${channel}`)
      .map((r) => JSON.stringify(r.body));

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;',
    );
    await admin.end();
    await runMigrations(url!);
    h = createDb({ url: url!, poolMax: 4 });
    await seedReferenceData(h.db);
    mock = await startMockSwis({ port: 0 });
    const key = generateMasterKey();
    const box = SecretBox.fromBase64(key);
    const env = {
      DATABASE_URL: url,
      SWIS_BASE_URL: mock.url,
      SWIS_USERNAME: 'mas',
      SWIS_PASSWORD: 'mas',
      SWIS_MAX_RETRIES: '0',
      LOG_LEVEL: 'silent',
      MAS_MASTER_KEY: key,
      APP_BASE_URL: 'https://mas.example',
      NOTIFY_SHADOW_MODE: 'false',
      NOTIFY_ALLOW_HTTP: 'true',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: `${mock.url}/__mock/anthropic`,
      AI_TIMEOUT_SEC: '10',
    };
    for (const key of ['net-critical', 'net-alerts', 'net-digest'])
      await saveChannel(
        h.db,
        box,
        {
          key,
          name: key,
          description: null,
          enabled: true,
          webhookUrl: `${mock.url}/__mock/sink/${key}`,
        },
        { ...actor },
      );
    worker = createWorker(loadConfig(env), { scheduling: false, log: silent, env, now });
    await worker.start();
    for (const p of ['topology', 'groups', 'nodes', 'interfaces', 'alerts', 'events'] as const)
      await worker.pollOnce(p);
    await worker.correlateOnce({ reconcile: true });
    await worker.notifyOnce();
  });

  afterAll(async () => {
    await worker?.stop();
    await mock?.close();
    await h?.close();
  });

  it('leaves pre-existing incidents alone', async () => {
    expect(await worker.aiOnce()).toEqual([]);
    expect(mock.anthropic.records).toEqual([]);
  });

  it('sends the templated alert first, then adds the AI summary as one follow-up card', async () => {
    mock.applyScenario('site-wan-down', { site: 'ROCK', childAlerts: 30 });
    await worker.pollOnce('nodes');
    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
    await worker.notifyOnce();
    expect(posted('net-critical')).toHaveLength(1);
    expect(posted('net-critical')[0]).toContain('Site down — Rockford Elevator');
    expect(posted('net-critical')[0]).not.toContain('Summary (AI)');
    p1 = (await q<{ id: number }>(`select id::int from incidents where priority='P1'`))[0]!.id;
    // An address in an alert message, to check it never leaves MAS.
    await q(
      `update alert_records set last_message = 'ROCK-FW01 (10.40.1.1) is not responding' where incident_id = $1 and alert_name ilike '%node%'`,
      [p1],
    );

    const results = await worker.aiOnce();
    expect(results).toEqual([
      expect.objectContaining({ incidentId: p1, outcome: 'written', summary: 'ok' }),
    ]);
    // A storm of 31 alerts is one summary and one priority check.
    expect(mock.anthropic.records.map((r) => r.task)).toEqual(['severity', 'summary']);
    for (const r of mock.anthropic.records) expect(r.user).not.toMatch(/\b10\.\d+\.\d+\.\d+\b/);

    const [inc] = await q<{
      ai_title: string;
      ai_summary: { likelyCause: string; forMaterialRev: number; redacted: boolean };
      ai_status: string;
      priority: string;
      ai_priority_suggested: number;
    }>(
      'select ai_title, ai_summary, ai_status, priority, ai_priority_suggested from incidents where id=$1',
      [p1],
    );
    expect(inc).toMatchObject({
      ai_title: 'Rockford Elevator offline: WAN circuit or firewall down',
      ai_status: 'ok',
      priority: 'P1',
      ai_priority_suggested: 0,
    });
    expect(inc!.ai_summary.redacted).toBe(true);
    const calls = await q<{ purpose: string; status: string; cost_usd: string; redacted: boolean }>(
      'select purpose, status, cost_usd, redacted from ai_calls order by id',
    );
    expect(calls.map((c) => [c.purpose, c.status, c.redacted])).toEqual([
      ['severity', 'ok', true],
      ['summary', 'ok', true],
    ]);
    expect(Number(calls[1]!.cost_usd)).toBeGreaterThan(0);
    const [ev] = await q<{ actor: string; message: string }>(
      `select actor, message from incident_events where incident_id=$1 and type='ai_summary'`,
      [p1],
    );
    expect(ev).toMatchObject({ actor: 'ai' });

    const smsBefore = mock.sinks.records.filter((r) => r.sink === 'twilio').length;
    await worker.notifyOnce();
    const cards = posted('net-critical');
    expect(cards).toHaveLength(2);
    expect(cards[1]).toContain('Update 1: Summary and first steps');
    expect(cards[1]).toContain('Likely cause** (medium confidence)');
    expect(cards[1]).toContain('Rockford Elevator offline: WAN circuit or firewall down');
    expect(mock.sinks.records.filter((r) => r.sink === 'twilio')).toHaveLength(smsBefore);

    // Nothing material changed: no further calls, no further posts.
    expect(await worker.aiOnce()).toEqual([]);
    await worker.notifyOnce();
    expect(posted('net-critical')).toHaveLength(2);
  });

  it('keeps the template when the API is down and retries with backoff', async () => {
    mock.anthropic.control({ mode: 'error' });
    mock.applyScenario('ups-on-battery', { site: 'COLD' });
    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
    await worker.notifyOnce();
    const [ups] = await q<{ id: number; title: string }>(
      `select id::int, title from incidents where kind='ups_power' and seeded=false`,
    );
    expect(ups).toBeDefined();
    const r = await worker.aiOnce();
    expect(r).toEqual([expect.objectContaining({ incidentId: ups!.id, outcome: 'deferred' })]);
    const [row] = await q<{ ai_status: string; ai_attempts: number; ai_title: string | null }>(
      'select ai_status, ai_attempts, ai_title from incidents where id=$1',
      [ups!.id],
    );
    expect(row).toMatchObject({ ai_status: 'error', ai_attempts: 1, ai_title: null });
    // Not due again until the backoff has passed.
    mock.anthropic.control({ mode: 'ok' });
    expect(await worker.aiOnce()).toEqual([]);
    clock += 3 * 60_000;
    expect(await worker.aiOnce()).toEqual([
      expect.objectContaining({ incidentId: ups!.id, outcome: 'written' }),
    ]);
    // A device model looks like a serial number but is context, so it is sent as is.
    expect(mock.anthropic.records.at(-1)!.user).toContain('OR1500LCDRM1U');
  });

  it('applies a priority step within the guardrails and records why', async () => {
    mock.anthropic.control({ severityAdjust: -1 });
    mock.applyScenario('flapping-ap', { node: 'CEL-AP02', flaps: 1 }, 0); // just the first "down"
    await worker.pollOnce('nodes');
    await worker.correlateOnce({ reconcile: false });
    const [ap] = await q<{ id: number; priority: string; base_priority: string }>(
      `select id::int, priority, base_priority from incidents where seeded=false and kind in ('device_down','flapping') order by id desc limit 1`,
    );
    expect(ap).toBeDefined();
    await worker.aiOnce();
    const [after] = await q<{
      priority: string;
      ai_priority_adjust: number | null;
      ai_priority_reason: string;
      guardrail_note: string | null;
    }>(
      'select priority, ai_priority_adjust, ai_priority_reason, guardrail_note from incidents where id=$1',
      [ap!.id],
    );
    const rank = (p: string) => Number(p.slice(1));
    expect(rank(after!.priority)).toBe(Math.min(4, rank(ap!.base_priority) + 1));
    expect(after!.ai_priority_reason).toBe('The fake model was told to adjust.');
    const [ev] = await q<{ message: string }>(
      `select message from incident_events where incident_id=$1 and type='priority_changed' and actor='ai'`,
      [ap!.id],
    );
    if (rank(ap!.base_priority) < 4) expect(ev!.message).toContain('(AI: The fake model');
    // A correlation pass keeps the AI step while the basis holds.
    await worker.correlateOnce({ reconcile: false });
    const [kept] = await q<{ priority: string }>('select priority from incidents where id=$1', [
      ap!.id,
    ]);
    expect(kept!.priority).toBe(after!.priority);
    mock.anthropic.control({ severityAdjust: 0 });
  });

  it('stops calling once the daily budget is spent, and says so once', async () => {
    await q(
      `insert into ai_calls (at, purpose, model, status, cost_usd) values ($1, 'summary', 'claude-opus-5-5', 'ok', 99)`,
      [now()],
    );
    const before = mock.anthropic.records.length;
    mock.applyScenario('ups-on-battery', { site: 'SPV' });
    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
    const r = await worker.aiOnce();
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.outcome === 'deferred' && x.summary === 'budget_blocked')).toBe(true);
    expect(mock.anthropic.records.length).toBe(before); // nothing is sent, not even the cheap check
    await worker.notifyOnce();
    const notices = posted('net-critical').filter((c) => c.includes('daily AI budget reached'));
    expect(notices).toHaveLength(1);
    await worker.aiOnce();
    await worker.notifyOnce();
    expect(
      posted('net-critical').filter((c) => c.includes('daily AI budget reached')),
    ).toHaveLength(1);
    await q(`delete from ai_calls where cost_usd = 99`);
  });

  it('writes the daily digest with Claude and posts it to #net-digest', async () => {
    const r = await worker.digestOnce('daily');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('by Claude');
    const [d] = await q<{ source: string; markdown: string; facts: { overnight: unknown[] } }>(
      'select source, markdown, facts from digests where id=$1',
      [r.digestId],
    );
    expect(d!.source).toBe('ai');
    expect(d!.markdown).toContain('Morning digest from the fake model.');
    expect(d!.facts.overnight.length).toBeGreaterThan(0);
    await worker.notifyOnce();
    const card = posted('net-digest').at(-1)!;
    expect(card).toContain('Network digest');
    expect(card).toContain('Written by Claude from MAS data.');
    expect((await worker.digestOnce('daily')).message).toContain('already has a digest');
  });

  it('falls back to the template when the digest cites incidents that do not exist', async () => {
    mock.anthropic.control({ inventIncident: true });
    const r = await worker.digestOnce('weekly', { manual: true });
    expect(r.message).toContain('from the template (AI: fallback)');
    const [d] = await q<{ source: string }>('select source from digests where id=$1', [r.digestId]);
    expect(d!.source).toBe('template');
    mock.anthropic.control({ inventIncident: false });
  });
});
