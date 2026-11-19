/**
 * "Ask the network" end to end: a question stored by the web app, answered by the worker
 * through the read-only tools against real (mock-polled) data and the fake Claude, with
 * progress events addressed to the asker only. Requires DATABASE_URL_TEST (wiped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  CHAT_TOOL_NAMES,
  EVENTS_CHANNEL,
  generateMasterKey,
  initLogger,
  loadConfig,
} from '@mercer/core';
import {
  addChatQuestion,
  createDb,
  flappingNodes,
  noiseSeries,
  recurringProblems,
  topInterfaces,
  failStaleChatAnswers,
  getChatMessages,
  getChatThread,
  runChatTool,
  seedReferenceData,
  type DbHandle,
} from '@mercer/db';
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
const actor = { actorType: 'user' as const, actorId: 'local:1', actorLabel: 'local:pat' };
const ASKER = 'local:1';

describe.skipIf(!url)('Ask the network (integration)', () => {
  let mock: MockSwis;
  let worker: Worker;
  let h: DbHandle;
  let listener: pg.Client;
  const events: Array<{ t: string; thread?: number; user?: string; k?: string; text?: string }> =
    [];
  let p1 = 0;
  let thread = 0;
  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.pool.query(text, values)).rows as T[];
  const ctx = () => ({ now: new Date(), timeZone: 'America/New_York' });

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
    const env = {
      DATABASE_URL: url,
      SWIS_BASE_URL: mock.url,
      SWIS_USERNAME: 'mas',
      SWIS_PASSWORD: 'mas',
      SWIS_MAX_RETRIES: '0',
      LOG_LEVEL: 'silent',
      MAS_MASTER_KEY: generateMasterKey(),
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: `${mock.url}/__mock/anthropic`,
      AI_TIMEOUT_SEC: '10',
    };
    worker = createWorker(loadConfig(env), { scheduling: false, log: silent, env });
    await worker.start();
    for (const p of ['topology', 'nodes', 'interfaces', 'alerts', 'events'] as const)
      await worker.pollOnce(p);
    await worker.correlateOnce({ reconcile: true });
    mock.applyScenario('site-wan-down', { site: 'ROCK', childAlerts: 10 });
    await worker.pollOnce('nodes');
    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
    p1 = (await q<{ id: number }>(`select id::int from incidents where priority='P1'`))[0]!.id;
    // An address in alert text, to check it never reaches the model.
    await q(`update alert_records set last_message = 'ROCK-FW01 (10.40.1.1) is not responding'`);

    listener = new pg.Client({ connectionString: url });
    await listener.connect();
    listener.on('notification', (n) => {
      const ev = JSON.parse(n.payload ?? '{}');
      if (ev.t === 'chat') events.push(ev);
    });
    await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
  });

  afterAll(async () => {
    await listener?.end();
    await worker?.stop();
    await mock?.close();
    await h?.close();
  });

  it('answers with citations from the tools, streaming progress to the asker only', async () => {
    mock.anthropic.control({
      chatPlan: [
        {
          name: 'search_incidents',
          input: {
            text: null,
            status: 'active',
            priorities: ['P1'],
            site: 'rockford',
            since_hours: null,
            limit: 5,
          },
        },
        { name: 'get_incident', input: { incident_id: p1 } },
      ],
    });
    const asked = await addChatQuestion(
      h.db,
      { threadId: null, question: 'Why is Rockford down?', userKey: ASKER, userLabel: 'Pat' },
      actor,
    );
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    thread = asked.threadId;

    const r = await worker.chatOnce({ threadId: thread, answerId: asked.answerId });
    expect(r).toEqual({ status: 'ok', steps: 2 });

    const msgs = await getChatMessages(h.db, thread);
    expect(msgs.map((m) => [m.role, m.status])).toEqual([
      ['user', 'ok'],
      ['assistant', 'ok'],
    ]);
    const answer = msgs[1]!;
    expect(answer.text).toContain(`[INC-${p1}]`);
    expect(answer.text).toContain('10.40.1.1'); // restored for the person, not sent
    expect(answer.citations.find((c) => c.ref === `INC-${p1}`)?.verified).toBe(true);
    expect(answer.citations.every((c) => c.verified)).toBe(true);
    expect(answer.steps).toEqual([
      'Searching incidents (status: active · priorities: P1 · site: rockford · limit: 5)',
      `Reading incident (incident id: ${p1})`,
    ]);
    expect(Number(answer.costUsd)).toBeGreaterThan(0);
    for (const rec of mock.anthropic.records) expect(rec.user).not.toContain('10.40.1.1');

    const t = (await getChatThread(h.db, thread, ASKER))!;
    expect(t.history).toHaveLength(6);
    expect(t.redaction).toEqual({ '[IP-1]': '10.40.1.1' });
    expect(t.seenRefs).toContain(`INC-${p1}`);
    expect(await getChatThread(h.db, thread, 'local:2')).toBeNull();

    const calls = await q<{ purpose: string; status: string }>(
      `select purpose, status from ai_calls order by id`,
    );
    expect(calls.map((c) => c.purpose)).toEqual(['chat', 'chat', 'chat']);

    await new Promise((r) => setTimeout(r, 200));
    const mine = events.filter((e) => e.thread === thread);
    expect(mine.every((e) => e.user === ASKER)).toBe(true);
    expect(mine.filter((e) => e.k === 'step')).toHaveLength(2);
    expect(mine.filter((e) => e.k === 'delta').length).toBeGreaterThan(0);
    expect(mine.at(-1)!.k).toBe('done');
    const streamed = mine
      .filter((e) => e.k === 'delta')
      .map((e) => e.text)
      .join('');
    expect(streamed).toBe(answer.text);

    const [audit] = await q<{ action: string; after: { chars: number } }>(
      `select action, after from audit_log where action = 'chat.ask'`,
    );
    expect(audit!.after.chars).toBe('Why is Rockford down?'.length);
  });

  it('continues the thread, keeping earlier history untouched', async () => {
    const before = (await getChatThread(h.db, thread, ASKER))!.history;
    mock.anthropic.control({ chatPlan: [] });
    const asked = await addChatQuestion(
      h.db,
      { threadId: thread, question: 'Anything else?', userKey: ASKER, userLabel: 'Pat' },
      actor,
    );
    if (!asked.ok) throw new Error(asked.error);
    await worker.chatOnce({ threadId: thread, answerId: asked.answerId });
    const after = (await getChatThread(h.db, thread, ASKER))!.history;
    expect(after).toHaveLength(8);
    expect(after.slice(0, 6)).toEqual(before);
  });

  it('refuses a second question while one is pending, and fails answers a crash left behind', async () => {
    const a = await addChatQuestion(
      h.db,
      { threadId: thread, question: 'One', userKey: ASKER, userLabel: 'Pat' },
      actor,
    );
    expect(a.ok).toBe(true);
    const b = await addChatQuestion(
      h.db,
      { threadId: thread, question: 'Two', userKey: ASKER, userLabel: 'Pat' },
      actor,
    );
    expect(b).toEqual({ ok: false, error: 'Wait for the answer to the previous question.' });
    expect(await failStaleChatAnswers(h.db, new Date(Date.now() + 60_000))).toBe(1);
    const last = (await getChatMessages(h.db, thread)).at(-1)!;
    expect(last).toMatchObject({ status: 'error' });
  });

  it('every tool runs against real data, returns refs, and never returns addresses', async () => {
    const inputs: Record<string, unknown> = {
      get_network_status: { division: null },
      search_incidents: {
        text: 'Rockford',
        status: 'all',
        priorities: [],
        site: null,
        since_hours: 24,
        limit: 5,
      },
      get_incident: { incident_id: p1 },
      find_sites: { text: 'rock', division: null },
      get_site: { site: 'ROCK' },
      find_nodes: { text: 'ROCK', site: null, role: 'firewall', status: null, limit: 5 },
      get_node_history: { node_id: 1, hours: 24 },
      get_interface_utilization: { node_id: null, site: null, hours: 24, limit: 5 },
      get_flapping_devices: { hours: 24, limit: 5 },
    };
    const fw = await q<{ node_id: number; ip_address: string }>(
      `select node_id, ip_address from orion_nodes where caption = 'ROCK-FW01'`,
    );
    inputs.get_node_history = { node_id: fw[0]!.node_id, hours: 24 };
    for (const name of CHAT_TOOL_NAMES) {
      const r = await runChatTool(h.db, name, inputs[name], ctx());
      expect(r.ok, `${name}: ${r.output.slice(0, 200)}`).toBe(true);
      expect(r.output).not.toContain(fw[0]!.ip_address);
    }
    const status = await runChatTool(h.db, 'get_network_status', { division: null }, ctx());
    expect(status.output).toContain(`"ref":"INC-${p1}"`);
    // Rockford is listed as not healthy, with its site ref (the seed's code is "rockford").
    expect(status.output).toMatch(/"ref":"SITE-ROCKFORD","site":"Rockford Elevator"/);
    // Find a device by its address without ever seeing the address.
    const byIp = await runChatTool(
      h.db,
      'find_nodes',
      { text: fw[0]!.ip_address, site: null, role: null, status: null, limit: 5 },
      ctx(),
    );
    expect(byIp.output).toContain('ROCK-FW01');
    expect(byIp.output).not.toContain(fw[0]!.ip_address);
  });

  it('trend aggregates run for hourly and daily ranges', async () => {
    const end = new Date(Date.now() + 60_000);
    const start = new Date(end.getTime() - 86_400_000);
    const hours = await noiseSeries(h.db, {
      start,
      end,
      timeZone: 'America/New_York',
      unit: 'hour',
    });
    expect(hours.length).toBeGreaterThanOrEqual(24);
    expect(hours.reduce((s, b) => s + b.rawAlerts, 0)).toBeGreaterThan(0);
    expect(hours.reduce((s, b) => s + b.incidents, 0)).toBeGreaterThan(0);
    const days = await noiseSeries(h.db, {
      start: new Date(end.getTime() - 7 * 86_400_000),
      end,
      timeZone: 'America/New_York',
      unit: 'day',
    });
    expect(days.length).toBeGreaterThanOrEqual(7);
    expect(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.label))).toBe(true);
    await topInterfaces(h.db, { start, end, limit: 5 });
    await flappingNodes(h.db, { start, end, min: 1, limit: 5 });
    const recurring = await recurringProblems(h.db, { start, end });
    expect(recurring.reduce((s, r) => s + r.incidents, 0)).toBeGreaterThan(0);
  });

  it('rejects bad tool input and unknown entities as errors the model can correct', async () => {
    expect((await runChatTool(h.db, 'get_incident', { incident_id: 'x' }, ctx())).ok).toBe(false);
    expect((await runChatTool(h.db, 'drop_tables', {}, ctx())).output).toContain('Unknown tool');
    const missing = await runChatTool(h.db, 'get_site', { site: 'nowhere-at-all' }, ctx());
    expect(missing).toMatchObject({ ok: false });
    expect(missing.output).toContain('No site matches');
  });
});
