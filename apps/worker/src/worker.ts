import { hostname } from 'node:os';
import { PgBoss } from 'pg-boss';
import { createLogger, errorMessage, type AppConfig, type Logger } from '@mercer/core';
import {
  createDb,
  purgeExpired,
  upsertHeartbeat,
  type DbHandle,
  type PollerName,
} from '@mercer/db';
import { SchemaProbe, SwisClient, SwisFetcher } from '@mercer/swis';
import type { WorkerContext } from './context';
import { POLLERS } from './pollers';
import { runPoll } from './pollers/run-poll';
import { POLL_EXPIRE_SEC, POLL_QUEUES, RETENTION_QUEUE } from './queues';
import { SiteResolver } from './site-resolver';
import { SourceMonitor } from './source-monitor';

export interface Worker {
  ctx: WorkerContext;
  boss: PgBoss | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Run a poller inline (tests, CLI). */
  pollOnce(name: PollerName): ReturnType<typeof runPoll>;
  health(): Promise<{ ok: boolean; details: Record<string, unknown> }>;
}

export interface WorkerOptions {
  /** false = no pg-boss / no timers (integration tests drive pollOnce directly). */
  scheduling?: boolean;
  log?: Logger;
  now?: () => Date;
}

export function createWorker(cfg: AppConfig, opts: WorkerOptions = {}): Worker {
  const log = opts.log ?? createLogger('worker');
  const now = opts.now ?? (() => new Date());
  const dbh: DbHandle = createDb({
    url: cfg.database.url,
    poolMax: cfg.database.poolMax,
    applicationName: 'mas-worker',
  });
  const client = new SwisClient({
    baseUrl: cfg.swis.baseUrl,
    username: cfg.swis.username,
    password: cfg.swis.password,
    caCertPath: cfg.swis.caCertPath,
    tlsServername: cfg.swis.tlsServername,
    insecureSkipVerify: cfg.swis.insecureSkipVerify,
    timeoutMs: cfg.swis.timeoutMs,
    maxRetries: cfg.swis.maxRetries,
    retryBaseMs: cfg.swis.retryBaseMs,
    retryMaxMs: cfg.swis.retryMaxMs,
    breakerThreshold: cfg.swis.breakerThreshold,
    breakerCooldownMs: cfg.swis.breakerCooldownMs,
    userAgent: `MercerAlertService/${cfg.version}`,
    logger: createLogger('swis'),
  });
  const probe = new SchemaProbe(client, createLogger('swis-probe'));
  const fetcher = new SwisFetcher(client, probe, {
    pageSize: cfg.swis.pageSize,
    incrementalPageSize: cfg.swis.incrementalPageSize,
    eventsBackfill: cfg.swis.eventsBackfill,
    naiveTimeZone: cfg.swis.naiveTimezone,
    logger: createLogger('swis-fetch'),
  });
  const source = new SourceMonitor(
    dbh.db,
    client,
    cfg.swis.staleAfterSec,
    createLogger('source'),
    now,
  );
  const ctx: WorkerContext = {
    cfg,
    log,
    db: dbh.db,
    swis: { client, probe, fetcher },
    sites: new SiteResolver(dbh.db, cfg.mapping, createLogger('sites')),
    source,
    onTransitions: async () => {
      /* M2: enqueue correlate.run */
    },
    now,
  };

  const scheduling = opts.scheduling ?? true;
  let boss: PgBoss | null = null;
  const timers: NodeJS.Timeout[] = [];
  const startedAt = now();
  let stopping = false;
  let lastBeatOk: Date | null = null;

  async function beat(): Promise<void> {
    try {
      const backlog: Record<string, number> = {};
      if (boss) {
        for (const q of Object.values(POLL_QUEUES)) {
          const stats = await boss.getQueueStats(q).catch(() => []);
          backlog[q] = stats.reduce((n, s) => n + s.queuedCount, 0);
        }
      }
      await upsertHeartbeat(dbh.db, {
        component: 'worker',
        status: 'ok',
        version: cfg.version,
        host: hostname(),
        details: {
          pid: process.pid,
          uptimeSec: Math.round((now().getTime() - startedAt.getTime()) / 1000),
          backlog,
        },
      });
      await source.evaluate();
      lastBeatOk = now();
      if (cfg.worker.deadmanPingUrl) {
        await fetch(cfg.worker.deadmanPingUrl, { signal: AbortSignal.timeout(5000) }).catch(
          (e: unknown) => log.warn({ err: errorMessage(e) }, 'dead-man ping failed'),
        );
      }
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'heartbeat failed');
    }
  }

  return {
    ctx,
    get boss() {
      return boss;
    },
    pollOnce: (name) => runPoll(ctx, name, POLLERS[name]),

    async start() {
      await source.init();
      await probe
        .refresh()
        .catch((e: unknown) => log.warn({ err: errorMessage(e) }, 'initial schema probe failed'));
      await beat();
      if (!scheduling) return;

      boss = new PgBoss({
        connectionString: cfg.database.url,
        application_name: 'mas-boss',
        max: 5,
      });
      boss.on('error', (err) => log.error({ err: errorMessage(err) }, 'pg-boss error'));
      await boss.start();

      for (const [name, queue] of Object.entries(POLL_QUEUES) as Array<[PollerName, string]>) {
        await boss.createQueue(queue, {
          policy: 'stately',
          retryLimit: 0,
          expireInSeconds: POLL_EXPIRE_SEC[name],
        });
        await boss.work(queue, { pollingIntervalSeconds: 1 }, async () => {
          await runPoll(ctx, name, POLLERS[name]);
        });
      }
      await boss.createQueue(RETENTION_QUEUE, {
        policy: 'singleton',
        retryLimit: 2,
        expireInSeconds: 3600,
      });
      await boss.work(RETENTION_QUEUE, async () => {
        const purged = await purgeExpired(dbh.db, cfg.retention);
        log.info({ purged }, 'retention purge complete');
      });
      await boss.schedule(RETENTION_QUEUE, cfg.retention.cron, {}, { tz: cfg.timezone });

      // Interval ticks → stately queues (dedupes across replicas, never overlaps a slow poll).
      // Topology first: it refreshes the schema probe and custom-property list.
      const order: PollerName[] = ['topology', 'alerts', 'nodes', 'interfaces', 'events'];
      order.forEach((name, i) => {
        const queue = POLL_QUEUES[name];
        const enqueue = () => {
          if (stopping) return;
          boss
            ?.send(queue, {})
            .catch((e: unknown) => log.error({ queue, err: errorMessage(e) }, 'enqueue failed'));
        };
        timers.push(setTimeout(enqueue, i * 1500));
        timers.push(setInterval(enqueue, cfg.swis.pollSec[name] * 1000));
      });
      timers.push(setInterval(() => void beat(), cfg.worker.heartbeatSec * 1000));
      log.info({ pollSec: cfg.swis.pollSec, swis: cfg.swis.baseUrl }, 'worker started');
    },

    async stop() {
      stopping = true;
      for (const t of timers) clearInterval(t);
      if (boss) await boss.stop({ graceful: true, timeout: 15_000 }).catch(() => {});
      await client.close();
      await dbh.close();
    },

    async health() {
      const details: Record<string, unknown> = {
        uptimeSec: Math.round((now().getTime() - startedAt.getTime()) / 1000),
        lastHeartbeatAt: lastBeatOk?.toISOString() ?? null,
        source: source.current,
        breaker: client.breaker.snapshot().state,
        tlsVerification: client.getStats().tlsVerification,
      };
      try {
        await dbh.pool.query('select 1');
        details.db = 'ok';
      } catch (err) {
        details.db = errorMessage(err);
        return { ok: false, details };
      }
      const staleMs = cfg.worker.heartbeatSec * 4 * 1000;
      const ok = !!lastBeatOk && now().getTime() - lastBeatOk.getTime() < staleMs;
      return { ok, details };
    },
  };
}
