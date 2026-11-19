/**
 * Notifications end to end: mock SWIS → pollers → correlation → dispatch → outbox → HTTP to the
 * mock's Teams / Twilio / Pushover sinks. Requires DATABASE_URL_TEST (wiped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { SecretBox, generateMasterKey, initLogger, loadConfig } from '@mercer/core';
import {
  applyIncidentAction,
  createDb,
  listPeople,
  savePerson,
  saveChannel,
  seedReferenceData,
  type DbHandle,
} from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { startMockSwis, type MockSwis, type SinkRecord } from '@mercer/mock-swis';
import { runNotifyCycle, runSelfCheck, runTestSend } from './notify';
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
  display: 'Pat Doe',
  ip: null,
  userAgent: null,
};
const SID = 'AC' + 'f'.repeat(32);

describe.skipIf(!url)('notifications (integration)', () => {
  let mock: MockSwis;
  let worker: Worker;
  let h: DbHandle;
  let box: SecretBox;
  let env: Record<string, string | undefined> = {};
  let clock = Date.now();
  const now = () => new Date(clock);
  let p1 = 0;
  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.pool.query(text, values)).rows as T[];
  const sent = (sink: string): SinkRecord[] => mock.sinks.records.filter((r) => r.sink === sink);
  const cardText = (r: SinkRecord) => JSON.stringify(r.body);

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
    box = SecretBox.fromBase64(key);
    env = {
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
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM: '+14195550100',
      TWILIO_API_BASE: `${mock.url}/__mock/twilio`,
      PUSHOVER_APP_TOKEN: 'app-token',
      PUSHOVER_API_BASE: `${mock.url}/__mock/pushover`,
    };
    // Real webhooks for three channels; net-digest stays unconfigured.
    for (const key of ['net-critical', 'net-alerts', 'mas-shadow'])
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
        actor,
      );
    // Everyone pages by SMS so the test can tell the levels apart by number.
    for (const [i, p] of (await listPeople(h.db)).entries())
      await savePerson(
        h.db,
        p.id,
        { ...p, pageVia: 'sms', phoneE164: `+1419555010${i}`, pushoverUserKey: null },
        actor,
      );
    worker = createWorker(loadConfig(env), { scheduling: false, log: silent, env, now });
    await worker.start();
    for (const p of ['topology', 'groups', 'nodes', 'interfaces', 'alerts', 'events'] as const)
      await worker.pollOnce(p);
    await worker.correlateOnce({ reconcile: true });
  });

  afterAll(async () => {
    await worker?.stop();
    await mock?.close();
    await h?.close();
  });

  it('stays silent about incidents that existed before MAS started', async () => {
    const r = await worker.notifyOnce();
    expect(r.dispatched).toBeGreaterThan(0);
    expect(mock.sinks.records).toEqual([]);
    const [{ n }] = (await q<{ n: number }>(
      'select count(*)::int as n from incident_notify_state where baselined',
    )) as [{ n: number }];
    expect(n).toBe(r.dispatched);
  });

  it('posts a P1 to net-critical and pages the on-call person once', async () => {
    mock.applyScenario('site-wan-down', { site: 'ROCK', childAlerts: 30 });
    await worker.pollOnce('nodes');
    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
    const r = await worker.notifyOnce();
    expect(r.sent).toBe(2);
    expect(sent('teams:net-critical')).toHaveLength(1);
    expect(cardText(sent('teams:net-critical')[0]!)).toContain('Site down — Rockford Elevator');
    const sms = sent('twilio');
    expect(sms).toHaveLength(1);
    expect(sms[0]!.authorization).toBe(`Basic ${Buffer.from(`${SID}:token`).toString('base64')}`);
    const body = sms[0]!.body as { Body: string; To: string };
    expect(body.Body).toMatch(
      /^P1 Site down — Rockford Elevator\. \d+ alerts\. Ack: https:\/\/mas\.example\/i\/[2-9A-HJ-NP-Z]{6} \[MAS\]$/,
    );
    expect(body.Body.length).toBeLessThanOrEqual(300);
    p1 = (await q<{ id: number }>(`select id from incidents where priority='P1'`))[0]!.id;
    const pending = await q<{ level: number }>(
      'select level from escalations where incident_id=$1 and fired_at is null and cancelled_at is null order by level',
      [p1],
    );
    expect(pending.map((e) => e.level)).toEqual([1, 2]);
    // A second pass with nothing new sends nothing.
    expect((await worker.notifyOnce()).sent).toBe(0);
  });

  it('escalates to the secondary when nobody acknowledges in 15 minutes', async () => {
    const firstPage = (sent('twilio')[0]!.body as { To: string }).To;
    clock += 16 * 60_000;
    const r = await worker.notifyOnce();
    expect(r.escalations).toBe(1);
    const pages = sent('twilio');
    expect(pages).toHaveLength(2);
    const second = pages[1]!.body as { To: string; Body: string };
    expect(second.To).not.toBe(firstPage);
    expect(second.Body).toMatch(/^ESCALATED \(no ack from .+\) P1 Site down/);
    expect(cardText(sent('teams:net-critical').at(-1)!)).toContain('escalated to');
  });

  it('acknowledging updates Teams and stops further escalation', async () => {
    await applyIncidentAction(h.db, p1, { action: 'ack' }, actor, now());
    await worker.notifyOnce();
    expect(cardText(sent('teams:net-critical').at(-1)!)).toContain('Acknowledged by Pat Doe');
    clock += 20 * 60_000;
    await worker.notifyOnce();
    expect(sent('twilio')).toHaveLength(2);
    const [esc] = await q<{ cancel_reason: string }>(
      'select cancel_reason from escalations where incident_id=$1 and level=2',
      [p1],
    );
    expect(esc!.cancel_reason).toBe('acknowledged');
  });

  it('retries a failed delivery with backoff, and gives up on a permanent error', async () => {
    mock.sinks.failNext('teams:net-critical', 503, 1);
    await applyIncidentAction(h.db, p1, { action: 'note', text: 'checking' }, actor, now());
    await applyIncidentAction(h.db, p1, { action: 'snooze', minutes: 30 }, actor, now());
    let r = await worker.notifyOnce();
    expect(r.retrying).toBe(1);
    const [row] = await q<{ status: string; attempts: number; last_error: string }>(
      `select status, attempts, last_error from notifications where kind='teams' order by id desc limit 1`,
    );
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(row!.last_error).toContain('HTTP 503');
    expect(row!.last_error).not.toContain('/__mock/sink');
    clock += 31_000;
    r = await worker.notifyOnce();
    expect(r.sent).toBe(1);
    expect(cardText(sent('teams:net-critical').at(-1)!)).toContain('Snoozed until');

    mock.sinks.failNext('teams:net-critical', 404, 1);
    await applyIncidentAction(h.db, p1, { action: 'unsnooze' }, actor, now());
    r = await worker.notifyOnce();
    // Cancelling a snooze is not news for Teams, so force a real update instead:
    if (r.failed === 0) {
      await applyIncidentAction(h.db, p1, { action: 'unack' }, actor, now());
      r = await worker.notifyOnce();
    }
    expect(r.failed).toBe(1);
    const [health] = await q<{ consecutive_failures: number }>(
      `select consecutive_failures from notifier_health where key='teams:net-critical'`,
    );
    expect(health!.consecutive_failures).toBeGreaterThan(0);
  });

  it('tells the people who were paged when it is resolved', async () => {
    await applyIncidentAction(h.db, p1, { action: 'resolve' }, actor, now());
    await worker.notifyOnce();
    expect(cardText(sent('teams:net-critical').at(-1)!)).toContain('RESOLVED · P1');
    const resolved = sent('twilio').filter((r) =>
      (r.body as { Body: string }).Body.startsWith('RESOLVED'),
    );
    expect(resolved).toHaveLength(2); // the primary and the secondary who was escalated to
  });

  it('in shadow mode sends to the shadow channel only and pages nobody', async () => {
    const before = mock.sinks.records.length;
    mock.applyScenario('ups-on-battery', { site: 'COLD' });
    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
    await runNotifyCycle({
      cfg: loadConfig({ ...env, NOTIFY_SHADOW_MODE: 'true' }),
      db: h.db,
      box,
      log: silent,
      now,
    });
    const fresh = mock.sinks.records.slice(before);
    expect(fresh.map((r) => r.sink)).toEqual(['teams:mas-shadow']);
    expect(cardText(fresh[0]!)).toContain('[SHADOW]');
  });

  it('test-sends to a channel, and explains what is missing when it cannot', async () => {
    const deps = { cfg: loadConfig(env), db: h.db, box, log: silent, now };
    expect(await runTestSend(deps, { kind: 'teams', channelKey: 'net-alerts' }, 'Pat')).toEqual({
      ok: true,
      message: 'Sent to #net-alerts.',
    });
    expect(cardText(sent('teams:net-alerts').at(-1)!)).toContain('Sent by Pat');
    expect(await runTestSend(deps, { kind: 'teams', channelKey: 'net-digest' }, 'Pat')).toEqual({
      ok: false,
      message: 'This channel has no webhook URL yet.',
    });
  });

  it('raises a self-alert on another channel when one keeps failing', async () => {
    const deps = { cfg: loadConfig(env), db: h.db, box, log: silent, now };
    mock.sinks.failNext('teams:net-alerts', 500, 3);
    for (let i = 0; i < 3; i++)
      await runTestSend(deps, { kind: 'teams', channelKey: 'net-alerts' }, 'Pat');
    const raised = await runSelfCheck(deps);
    expect(raised).toContain('teams:net-alerts');
    await worker.notifyOnce();
    const alert = sent('teams:net-critical').at(-1)!;
    expect(cardText(alert)).toContain('notifications via #net-alerts are failing');
    // Not repeated within the hour.
    expect(await runSelfCheck(deps)).not.toContain('teams:net-alerts');
  });
});
