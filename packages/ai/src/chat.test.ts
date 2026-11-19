import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, loadConfig } from '@mercer/core';
import { createFakeAnthropic } from '@mercer/mock-swis';
import { runChatTurn, type ChatTurnInput } from './chat';
import { AiRunner, type AiCallRecord } from './runner';

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
        const type = r?.[2] ?? 'application/json';
        res.writeHead(r?.[0] ?? 404, { 'content-type': type, 'request-id': 'req_chat' });
        res.end(r?.[2] ? (r[1] as string) : JSON.stringify(r?.[1] ?? { error: 'not found' }));
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
  return new AiRunner({
    cfg: cfg.ai,
    timeZone: 'America/New_York',
    log: createLogger('chat-test', { level: 'silent' }),
    now: () => new Date(),
    store: {
      spendSince: async () => rows.reduce((s, r) => s + r.costUsd, 0),
      record: async (row) => {
        rows.push(row);
        return rows.length;
      },
    },
  });
}

const tools: Record<string, unknown> = {
  search_incidents: {
    count: 1,
    incidents: [{ ref: 'INC-42', title: 'Site down — Rockford Elevator', priority: 'P1' }],
  },
  get_incident: {
    ref: 'INC-42',
    affected_devices: [{ ref: 'NODE-1001', hostname: 'ROCK-FW01', model: 'FortiGate 60F' }],
    site_ref: 'SITE-ROCK',
    alerts: [{ message: 'ROCK-FW01 (10.40.1.1) is not responding' }],
  },
};

function input(over: Partial<ChatTurnInput> = {}): ChatTurnInput & { calls: string[] } {
  const calls: string[] = [];
  return {
    model: 'claude-opus-5-5',
    prefix: 'Role and site profiles.',
    history: [],
    redaction: {},
    seenRefs: [],
    question: 'Why is Rockford down?',
    nowLocal: '2026-11-19 10:05',
    timeZone: 'America/New_York',
    executeTool: async (name, args) => {
      calls.push(`${name} ${JSON.stringify(args)}`);
      return { ok: true, output: JSON.stringify(tools[name] ?? { error: 'unknown' }) };
    },
    calls,
    ...over,
  };
}

describe('runChatTurn', () => {
  it('calls tools, streams the answer, cites what the tools returned and restores addresses', async () => {
    fake.control({
      chatPlan: [
        {
          name: 'search_incidents',
          input: {
            text: 'Rockford',
            status: 'active',
            priorities: [],
            site: null,
            since_hours: null,
            limit: 5,
          },
        },
        { name: 'get_incident', input: { incident_id: 42 } },
      ],
    });
    const deltas: string[] = [];
    const steps: string[] = [];
    const i = input({ onText: (d) => deltas.push(d), onStep: (s) => steps.push(s) });
    const r = await runChatTurn(runner(), i);

    expect(r.status).toBe('ok');
    expect(i.calls).toEqual([
      'search_incidents {"text":"Rockford","status":"active","priorities":[],"site":null,"since_hours":null,"limit":5}',
      'get_incident {"incident_id":42}',
    ]);
    expect(steps).toEqual([
      'Searching incidents (text: Rockford · status: active · limit: 5)',
      'Reading incident (incident id: 42)',
    ]);
    expect(r.text).toContain('[INC-42]');
    expect(r.text).toContain('10.40.1.1');
    expect(deltas.join('')).toBe(r.text);
    expect(r.citations.map((c) => [c.ref, c.verified])).toEqual([
      ['INC-42', true],
      ['NODE-1001', true],
      ['SITE-ROCK', true],
    ]);
    // The address never left in a tool result; the model saw a placeholder.
    expect(fake.records.at(-1)!.user).not.toContain('10.40.1.1');
    expect(fake.records.at(-1)!.user).toContain('[IP-1]');
    expect(r.redaction).toEqual({ '[IP-1]': '10.40.1.1' });
    // user, assistant(tool), tool result, assistant(tool), tool result, assistant(answer)
    expect(r.historyAppend.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(rows.map((x) => [x.purpose, x.status])).toEqual([
      ['chat', 'ok'],
      ['chat', 'ok'],
      ['chat', 'ok'],
    ]);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('continues a thread with the same placeholders and without editing earlier history', async () => {
    fake.control({ chatPlan: [{ name: 'get_incident', input: { incident_id: 42 } }] });
    const first = await runChatTurn(runner(), input());
    fake.control({ chatPlan: [{ name: 'get_incident', input: { incident_id: 42 } }] });
    const second = await runChatTurn(
      runner(),
      input({
        history: first.historyAppend,
        redaction: first.redaction,
        seenRefs: first.seenRefs,
        question: 'And is 10.40.1.1 still down?',
      }),
    );
    expect(second.status).toBe('ok');
    // The question's address maps to the same placeholder as in turn one.
    expect(second.historyAppend[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('And is [IP-1] still down?') }],
    });
    expect(Object.keys(second.redaction)).toEqual(['[IP-1]']);
  });

  it('flags a citation no tool returned', async () => {
    fake.control({
      chatPlan: [{ name: 'get_incident', input: { incident_id: 42 } }],
      inventIncident: true,
    });
    const r = await runChatTurn(runner(), input());
    expect(r.citations.find((c) => c.ref === 'INC-999999')).toMatchObject({ verified: false });
  });

  it('stops before sending when the budget is spent, and on refusals and errors', async () => {
    const broke = await runChatTurn(runner({ AI_DAILY_BUDGET_USD: '0' }), input());
    expect(broke).toMatchObject({ status: 'budget_blocked', transient: true, historyAppend: [] });
    expect(fake.records).toHaveLength(0);

    fake.control({ mode: 'refuse' });
    const refused = await runChatTurn(runner(), input());
    expect(refused).toMatchObject({ status: 'refused', historyAppend: [] });

    fake.control({ mode: 'error' });
    const down = await runChatTurn(runner(), input());
    expect(down).toMatchObject({ status: 'error', transient: true, historyAppend: [] });
    expect(down.text).toContain('could not be reached');
  });

  it('gives up after too many tool calls', async () => {
    fake.control({
      mode: 'ok',
      chatPlan: Array.from({ length: 5 }, () => ({
        name: 'get_incident',
        input: { incident_id: 42 },
      })),
    });
    const r = await runChatTurn(runner(), input({ maxSteps: 3 }));
    expect(r).toMatchObject({ status: 'error', error: 'more than 3 steps', historyAppend: [] });
  });
});
