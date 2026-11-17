import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, loadConfig, stablePrefix, type IncidentContext } from '@mercer/core';
import { createFakeAnthropic } from '@mercer/mock-swis';
import { AiRunner, type AiCallRecord } from './runner';
import { summarizeIncident, suggestPriority, testAi, writeDigest } from './tasks';

const fake = createFakeAnthropic();
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!.replace(/^\/__mock\//, '');
      void fake.handle(req.method ?? 'GET', path, req.headers, raw).then((r) => {
        res.writeHead(r?.[0] ?? 404, { 'content-type': 'application/json', 'request-id': 'req_1' });
        res.end(JSON.stringify(r?.[1] ?? { error: 'not found' }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/__mock/anthropic`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let rows: AiCallRecord[] = [];
beforeEach(() => {
  fake.clear();
  rows = [];
});

function runner(over: Record<string, string> = {}) {
  const cfg = loadConfig(
    { DATABASE_URL: 'x' },
    { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: base, AI_TIMEOUT_SEC: '10', ...over },
  );
  const r = new AiRunner({
    cfg: cfg.ai,
    timeZone: 'America/New_York',
    log: createLogger('ai-test', { level: 'silent' }),
    now: () => new Date(),
    store: {
      spendSince: async () => rows.reduce((s, r) => s + r.costUsd, 0),
      record: async (row) => {
        rows.push(row);
        return rows.length;
      },
    },
  });
  return { r, cfg: cfg.ai };
}

const prefix = stablePrefix('Corporate firewall 172.16.0.1 is the hub.', [
  {
    code: 'ROCK',
    name: 'Rockford Elevator',
    division: 'Grain',
    city: 'Rockford',
    tier: 'critical',
    harvestCritical: true,
    hours: 'Mon–Fri 07:00–17:00',
    harvestHours: null,
    ownerGroup: null,
  },
]);
const context = {
  id: 42,
  kind: 'site_outage',
  status: 'open',
  templateTitle: 'Site down — Rockford Elevator',
  site: { code: 'ROCK', name: 'Rockford Elevator', division: 'Grain' },
  rootNode: { caption: 'ROCK-FW01', role: 'firewall', status: 'down', site: 'Rockford Elevator' },
  nodes: [],
  interfaces: [],
  alerts: [{ name: 'Node down', message: 'ROCK-FW01 (10.20.30.1) is not responding' }],
  alertCount: 31,
} as unknown as IncidentContext;
const input = { incidentId: 42, context, previous: null, prefix };

describe('AiRunner', () => {
  it('redacts before sending, restores after, and logs cost with cache usage', async () => {
    const { r, cfg } = runner();
    const out = await summarizeIncident(r, cfg, input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.title).toBe('Rockford Elevator offline: WAN circuit or firewall down');
    expect(out.data.likelyCause).toContain('(address 10.20.30.1)');

    const sent = fake.records[0]!;
    expect(sent.user).not.toContain('10.20.30.1');
    expect(sent.user).toContain('[IP-2]'); // [IP-1] is the hub address in the cached prefix
    expect(sent.system[0]).toMatchObject({ cached: true });
    expect(sent.system[0]!.text).toContain('[IP-1] is the hub');
    expect(sent.system[1]).toMatchObject({ cached: false });
    expect(sent).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'medium',
      fallbacks: 'default',
      hasSchema: true,
    });
    expect(sent.betas).toContain('server-side-fallback-2026-07-01');

    expect(rows[0]).toMatchObject({
      purpose: 'summary',
      status: 'ok',
      attempts: 1,
      redacted: true,
    });
    expect(rows[0]!.cacheWriteTokens).toBeGreaterThan(0);
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
    await summarizeIncident(r, cfg, input);
    expect(rows[1]!.cacheReadTokens).toBe(rows[0]!.cacheWriteTokens);
    expect(rows[1]!.costUsd).toBeLessThan(rows[0]!.costUsd);
  });

  it('uses the fast model at low effort for the priority check', async () => {
    const { r, cfg } = runner();
    fake.control({ severityAdjust: 1 });
    const out = await suggestPriority(r, cfg, input);
    expect(out.ok && out.data.adjust).toBe(1);
    expect(fake.records[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
  });

  it('retries an invalid answer once, then falls back', async () => {
    const { r, cfg } = runner();
    fake.control({ mode: 'invalid', times: 1 });
    const once = await summarizeIncident(r, cfg, input);
    expect(once.ok && once.status).toBe('retried');
    expect(fake.records[1]!.user).toContain('Your previous answer could not be used');

    fake.control({ mode: 'invalid', times: 2 });
    const twice = await summarizeIncident(r, cfg, input);
    expect(twice).toMatchObject({ ok: false, status: 'fallback', transient: false });
    expect(rows.at(-1)).toMatchObject({ status: 'fallback', attempts: 2 });
  });

  it('treats a refusal as final', async () => {
    const { r, cfg } = runner();
    fake.control({ mode: 'refuse' });
    const out = await summarizeIncident(r, cfg, input);
    expect(out).toMatchObject({ ok: false, status: 'refused', transient: false });
    expect(fake.records).toHaveLength(1);
    expect(rows[0]!.error).toBe('The fake model declined.');
  });

  it('reports overload and timeouts as transient errors', async () => {
    const { r, cfg } = runner();
    fake.control({ mode: 'error' });
    const busy = await summarizeIncident(r, cfg, input);
    expect(busy).toMatchObject({ ok: false, status: 'error', transient: true });
    expect(rows[0]!.error).toContain('529');

    fake.control({ mode: 'slow', delayMs: 1500 });
    const { r: quick, cfg: qcfg } = runner();
    const slow = await quick.call({
      purpose: 'test',
      model: qcfg.models.summary,
      effort: 'low',
      maxTokens: 100,
      prompt: { stable: 's', task: 't', user: 'u' },
      schema: (await import('@mercer/core')).severityOutput,
      redactor: new (await import('@mercer/core')).Redactor(),
      timeoutMs: 200,
    });
    expect(slow).toMatchObject({ ok: false, status: 'error', transient: true, error: 'timed out' });
  });

  it('sends nothing once the daily budget is spent', async () => {
    const { r, cfg } = runner({ AI_DAILY_BUDGET_USD: '0.0001' });
    await testAi(r, cfg, cfg.models.summary); // spends a little
    const blocked = await summarizeIncident(r, cfg, input);
    expect(blocked).toMatchObject({ ok: false, status: 'budget_blocked', transient: true });
    expect(fake.records).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ status: 'budget_blocked', costUsd: 0 });
  });

  it('rejects a digest that cites an incident not in the facts', async () => {
    const { r, cfg } = runner();
    const facts = {
      kind: 'daily',
      overnight: [{ id: 7, title: 'Site down — Rockford Elevator', priority: 'P1' }],
      stillOpen: [],
      recurring: [],
    } as never;
    fake.control({ inventIncident: true, times: 1 });
    const fixed = await writeDigest(r, cfg, prefix, facts);
    expect(fixed.ok && fixed.status).toBe('retried');
    expect(fake.records[1]!.user).toContain('INC-999999');

    fake.control({ inventIncident: true });
    const bad = await writeDigest(r, cfg, prefix, facts);
    expect(bad).toMatchObject({ ok: false, status: 'fallback' });
    expect(rows.at(-1)!.error).toContain('INC-999999');
  });

  it('reports a wrong key without retrying', async () => {
    const { r, cfg } = runner();
    const noKey = new AiRunner({
      cfg: { ...cfg, apiKey: '' },
      timeZone: 'UTC',
      log: createLogger('ai-test', { level: 'silent' }),
      now: () => new Date(),
      store: { spendSince: async () => 0, record: async () => 1 },
    });
    void r;
    const out = await testAi(noKey, cfg, cfg.models.summary);
    expect(out).toMatchObject({ ok: false, status: 'error', transient: false });
  });
});
