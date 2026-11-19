import { readFileSync, readdirSync } from 'node:fs';
import {
  createServer as createHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttps } from 'node:https';
import { join } from 'node:path';
import { createFakeAnthropic, type FakeAnthropic } from './anthropic';
import { createSinks, type Sinks } from './sinks';
import { buildScenario, type OutageMode, type Scenario, type ScenarioEnv } from './scenarios';
import { entityTables, executeSwql, SwqlError } from './swql';
import { acknowledge, buildWorld, type Rec, type World } from './world';

export interface MockSwisOptions {
  port?: number;
  host?: string;
  username?: string;
  password?: string;
  tlsCert?: string;
  tlsKey?: string;
  /** "Entity.Prop" (case-insensitive) to hide, simulating an older Orion version. */
  dropFields?: string[];
  /** Directory of recorded fixtures (scripts/swis-record.ts) — replay mode. */
  replayDir?: string;
  /** Real-time multiplier for scenario steps (10 = ten times faster). */
  speed?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface MockSwis {
  url: string;
  world: World;
  server: Server;
  setOutage(mode: OutageMode): void;
  /** Start a scenario on the real-time scheduler. */
  runScenario(name: string, params?: Record<string, unknown>): Scenario;
  /** Apply all steps of a scenario immediately (or up to `untilSec`). */
  applyScenario(name: string, params?: Record<string, unknown>, untilSec?: number): Scenario;
  reset(): void;
  stats: { queries: number; invokes: number };
  /** Notification sinks (Teams webhooks, Twilio, Pushover lookalikes). */
  sinks: Sinks;
  /** A fake Anthropic Messages API at /__mock/anthropic/v1/messages. */
  anthropic: FakeAnthropic;
  close(): Promise<void>;
}

interface Recorded {
  entity: string;
  results: Rec[];
}

function loadReplay(dir: string): Map<string, Rec[]> {
  const map = new Map<string, Rec[]>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Recorded;
    if (r.entity && Array.isArray(r.results)) map.set(r.entity.toLowerCase(), r.results);
  }
  return map;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export async function startMockSwis(opts: MockSwisOptions = {}): Promise<MockSwis> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const user = opts.username ?? 'mas';
  const pass = opts.password ?? 'mas';
  const expectedAuth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const drop = new Set((opts.dropFields ?? []).map((f) => f.toLowerCase()));
  const replay = opts.replayDir ? loadReplay(opts.replayDir) : null;
  let world = buildWorld(now());
  let tables = entityTables(world, drop);
  let outage: OutageMode = 'none';
  const timers = new Set<NodeJS.Timeout>();
  const stats = { queries: 0, invokes: 0 };
  const sinks = createSinks();
  const anthropic = createFakeAnthropic();

  const env: ScenarioEnv = {
    get world() {
      return world;
    },
    setOutage: (m) => {
      outage = m;
      log(`outage → ${m}`);
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    // ---- control API (dev only, no auth) ----
    if (url.pathname.startsWith('/__mock/')) {
      const path = url.pathname.slice('/__mock/'.length);
      const raw = req.method === 'POST' ? await readBody(req) : '';
      const sink = sinks.handle(req.method ?? 'GET', path, req.headers, raw);
      if (sink) return send(res, sink[0], sink[1]);
      const ai = await anthropic.handle(req.method ?? 'GET', path, req.headers, raw);
      if (ai) {
        if (ai[2]) {
          res.writeHead(ai[0], { 'content-type': ai[2], 'cache-control': 'no-cache' });
          return void res.end(ai[1] as string);
        }
        return send(res, ai[0], ai[1]);
      }
      const body = JSON.parse(raw || '{}');
      try {
        if (path === 'state') {
          return send(res, 200, {
            outage,
            nodes: world.nodes.length,
            interfaces: world.interfaces.length,
            activeAlerts: world.alertActive.length,
            events: world.events.length,
            stats,
            sites: [...world.siteNodes.keys()],
          });
        }
        if (path === 'outage') {
          env.setOutage((body.mode ?? 'none') as OutageMode);
          return send(res, 200, { outage });
        }
        if (path === 'reset') {
          api.reset();
          return send(res, 200, { ok: true });
        }
        if (path === 'scenario') {
          const s = body.immediate
            ? api.applyScenario(String(body.name), body.params ?? {}, body.untilSec)
            : api.runScenario(String(body.name), body.params ?? {});
          return send(res, 200, {
            started: s.name,
            description: s.description,
            steps: s.steps.map((x) => ({ atSec: x.atSec, label: x.label })),
          });
        }
        return send(res, 404, { error: 'unknown control endpoint' });
      } catch (err) {
        return send(res, 400, { error: (err as Error).message });
      }
    }

    // ---- SWIS emulation ----
    if (outage === 'timeout') return; // never respond; client must time out
    if (outage === '503') return send(res, 503, { Message: 'Service Unavailable (mock outage)' });
    if (req.headers.authorization !== expectedAuth || outage === 'auth') {
      return send(res, 401, { Message: 'Authentication failed' });
    }
    const raw = await readBody(req);
    if (url.pathname === '/SolarWinds/InformationService/v3/Json/Query' && req.method === 'POST') {
      stats.queries++;
      try {
        const { query, parameters } = JSON.parse(raw) as {
          query: string;
          parameters?: Record<string, unknown>;
        };
        let results: Rec[];
        if (replay) {
          const entity = /FROM\s+([\w.]+)/i.exec(query)?.[1]?.toLowerCase() ?? '';
          const recorded = replay.get(entity);
          if (!recorded) throw new SwqlError(`replay: no fixture for ${entity}`);
          const rows = /WITH ROWS (\d+) TO (\d+)/i.exec(query);
          const cursor = parameters?.cursor;
          const firstKey = Object.keys(recorded[0] ?? {})[0];
          let r =
            cursor !== undefined && firstKey
              ? recorded.filter((x) => Number(x[firstKey]) > Number(cursor))
              : recorded;
          if (rows) r = r.slice(Number(rows[1]) - 1, Number(rows[2]));
          results = r;
        } else {
          results = executeSwql(query, parameters ?? {}, tables, { utcNow: now() });
        }
        return send(res, 200, { results });
      } catch (err) {
        const message =
          err instanceof SwqlError ? err.message : `mock-swis: ${(err as Error).message}`;
        return send(res, 400, {
          Message: message,
          ExceptionType: 'SolarWinds.Data.Query.ParserException',
        });
      }
    }
    const inv = /^\/SolarWinds\/InformationService\/v3\/Json\/Invoke\/([\w.]+)\/(\w+)$/.exec(
      url.pathname,
    );
    if (inv && req.method === 'POST') {
      stats.invokes++;
      if (inv[1] === 'Orion.AlertActive' && inv[2] === 'Acknowledge') {
        const [ids, note] = JSON.parse(raw) as [number[], string];
        acknowledge(world, ids, note, now());
        return send(res, 200, true);
      }
      return send(res, 400, { Message: `Verb ${inv[1]}.${inv[2]} not supported by mock` });
    }
    return send(res, 404, { Message: 'Not found' });
  };

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err: unknown) => send(res, 500, { Message: (err as Error).message }));
  };
  const tls =
    opts.tlsCert && opts.tlsKey
      ? { cert: readFileSync(opts.tlsCert), key: readFileSync(opts.tlsKey) }
      : null;
  const server: Server = tls ? createHttps(tls, listener) : createHttp(listener);
  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 17774, opts.host ?? '127.0.0.1', resolve),
  );
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 17774);
  const host = opts.host && opts.host !== '0.0.0.0' ? opts.host : '127.0.0.1';
  const url = `${tls ? 'https' : 'http'}://${host === '127.0.0.1' && tls ? 'localhost' : host}:${port}`;

  const api: MockSwis = {
    url,
    get world() {
      return world;
    },
    server,
    stats,
    setOutage: env.setOutage,
    runScenario(name, params = {}) {
      const s = buildScenario(name, params);
      const speed = opts.speed ?? 1;
      for (const step of s.steps) {
        const t = setTimeout(
          () => {
            timers.delete(t);
            log(`[${s.name}] ${step.label}`);
            step.apply(env, now());
          },
          (step.atSec * 1000) / speed,
        );
        timers.add(t);
      }
      log(`scenario ${s.name} scheduled (${s.steps.length} steps, speed ×${speed})`);
      return s;
    },
    applyScenario(name, params = {}, untilSec = Number.POSITIVE_INFINITY) {
      const s = buildScenario(name, params);
      for (const step of s.steps) if (step.atSec <= untilSec) step.apply(env, now());
      return s;
    },
    sinks,
    anthropic,
    reset() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      // Orion never hands out an AlertActiveID twice; keep counting past the old world's IDs so a
      // client that saw them (MAS) doesn't mistake a new alert for an old one after a reset.
      const seq = world.seq;
      world = buildWorld(now());
      for (const k of Object.keys(seq) as Array<keyof typeof seq>)
        world.seq[k] = Math.max(world.seq[k], seq[k]);
      tables = entityTables(world, drop);
      outage = 'none';
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}
