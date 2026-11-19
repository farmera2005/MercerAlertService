import { hostname } from 'node:os';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import {
  ConfigError,
  createLogger,
  errorMessage,
  isSwisConfigured,
  loadConfig,
  loadOrCreateMasterKey,
  WRITEBACK_ACK_QUEUE,
  WRITEBACK_NOTE_QUEUE,
  WRITEBACK_SITE_NOTES_QUEUE,
  GEOCODE_SITE_QUEUE,
  NOTIFY_TEST_QUEUE,
  notifyTestSchema,
  AI_TEST_QUEUE,
  aiTestSchema,
  AI_CHAT_QUEUE,
  chatJobSchema,
  DIGEST_QUEUES,
  digestRunSchema,
  type DigestRunResult,
  type AppConfig,
  type Logger,
  type SecretBox,
} from '@mercer/core';
import {
  createDb,
  EVENTS_CHANNEL,
  loadSettings,
  purgeExpired,
  purgeExpiredSessions,
  settingsFingerprint,
  publishEvent,
  upsertHeartbeat,
  type DbHandle,
  type PollerName,
} from '@mercer/db';
import { SchemaProbe, SwisClient, SwisFetcher } from '@mercer/swis';
import type { WorkerContext } from './context';
import {
  CORRELATE_QUEUE,
  CORRELATE_TICK_SEC,
  runCorrelationCycle,
  type CycleSummary,
} from './correlation';
import { POLLERS } from './pollers';
import { runPoll } from './pollers/run-poll';
import { POLL_EXPIRE_SEC, POLL_QUEUES, RETENTION_QUEUE } from './queues';
import {
  runCertJob,
  runDiscoverJob,
  runTestJob,
  SETUP_QUEUES,
  type ConnectionInput,
} from './setup-jobs';
import { SiteResolver } from './site-resolver';
import { runWritebackAck, runWritebackNote, runWritebackSiteNotes } from './writeback';
import { runGeocodeSite } from './geocode';
import {
  NOTIFY_QUEUE,
  NOTIFY_TICK_SEC,
  SELFCHECK_QUEUE,
  runNotifyCycle,
  runSelfCheck,
  runTestSend,
  type NotifyDeps,
  type NotifySummary,
} from './notify';
import { SourceMonitor } from './source-monitor';
import {
  AI_SUMMARY_QUEUE,
  AI_SWEEP_SEC,
  dueSummaries,
  runAiTest,
  runDigest,
  runIncidentAi,
  type AiDeps,
  type IncidentAiResult,
} from './ai';
import { failStaleChats, runChatJob } from './chat';

export type WorkerMode = 'awaiting_setup' | 'monitoring' | 'config_error';

export interface Worker {
  /** Current context, or null until the Orion connection is configured. */
  readonly ctx: WorkerContext | null;
  readonly cfg: AppConfig;
  readonly mode: WorkerMode;
  readonly boss: PgBoss | null;
  readonly box: SecretBox;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Re-read settings from the database and apply them (also triggered by NOTIFY). */
  reloadConfig(): Promise<void>;
  /** Run a poller inline (tests, CLI). Returns null when not configured or on failure. */
  pollOnce(name: PollerName): ReturnType<typeof runPoll>;
  /** Run one correlation cycle inline (tests, simulator). */
  correlateOnce(opts?: { reconcile?: boolean }): Promise<CycleSummary | null>;
  notifyOnce(): Promise<NotifySummary>;
  selfCheckOnce(): Promise<string[]>;
  /** Run the AI for every incident that needs it, inline (tests, simulator). */
  aiOnce(): Promise<IncidentAiResult[]>;
  digestOnce(kind: 'daily' | 'weekly', opts?: { manual?: boolean }): Promise<DigestRunResult>;
  /** Answer one "Ask the network" question inline (tests). */
  chatOnce(job: { threadId: number; answerId: number }): ReturnType<typeof runChatJob>;
  health(): Promise<{ ok: boolean; details: Record<string, unknown> }>;
}

export interface WorkerOptions {
  /** false = no pg-boss / no timers (integration tests drive pollOnce directly). */
  scheduling?: boolean;
  /** Environment used to (re)build config; env values always win over saved settings. */
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  now?: () => Date;
}

interface SwisRuntime {
  key: string;
  client: SwisClient;
  probe: SchemaProbe;
  fetcher: SwisFetcher;
  source: SourceMonitor;
}

const swisKey = (c: AppConfig) =>
  JSON.stringify({ ...c.swis, pollSec: undefined, staleAfterSec: undefined, writeback: undefined });
const mappingKey = (c: AppConfig) => JSON.stringify(c.mapping);
const pollKey = (c: AppConfig) => JSON.stringify(c.swis.pollSec);

/**
 * The worker starts with nothing but a database. Everything else (Orion connection, mapping,
 * intervals) comes from settings saved in the web UI and is re-applied whenever they change.
 * Polling begins once the setup wizard is finished — or immediately if the Orion credentials are
 * supplied through the environment (infrastructure-as-code deployments, CI).
 */
export function createWorker(bootstrap: AppConfig, opts: WorkerOptions = {}): Worker {
  const log = opts.log ?? createLogger('worker');
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const { box } = loadOrCreateMasterKey(env);
  const dbh: DbHandle = createDb({
    url: bootstrap.database.url,
    poolMax: bootstrap.database.poolMax,
    applicationName: 'mas-worker',
  });

  let cfg = bootstrap;
  let mode: WorkerMode = 'awaiting_setup';
  let configError: string | null = null;
  let runtime: SwisRuntime | null = null;
  let ctx: WorkerContext | null = null;
  let sites = new SiteResolver(dbh.db, cfg.mapping, createLogger('sites'));
  let boss: PgBoss | null = null;
  let listener: pg.Client | null = null;
  const scheduling = opts.scheduling ?? true;
  const pollTimers: NodeJS.Timeout[] = [];
  const baseTimers: NodeJS.Timeout[] = [];
  const startedAt = now();
  let stopping = false;
  let lastBeatOk: Date | null = null;
  const aiLog = createLogger('ai');
  let fingerprint = '';
  let reloadTimer: NodeJS.Timeout | null = null;
  let reloading: Promise<void> | null = null;
  /** Align alert records with the mirror once per monitoring start (upgrades, long gaps). */
  let reconcileDue = false;
  let monitoringSince: Date | null = null;

  const monitoringWanted = (c: AppConfig) =>
    isSwisConfigured(c.swis) &&
    (c.setupComplete || (c.envKeys.has('SWIS_USERNAME') && c.envKeys.has('SWIS_PASSWORD')));

  async function buildRuntime(c: AppConfig): Promise<SwisRuntime> {
    const client = new SwisClient({
      baseUrl: c.swis.baseUrl,
      username: c.swis.username,
      password: c.swis.password,
      caCertPath: c.swis.caCertPath,
      caCertPem: c.swis.caCertPem,
      tlsServername: c.swis.tlsServername,
      insecureSkipVerify: c.swis.insecureSkipVerify,
      timeoutMs: c.swis.timeoutMs,
      maxRetries: c.swis.maxRetries,
      retryBaseMs: c.swis.retryBaseMs,
      retryMaxMs: c.swis.retryMaxMs,
      breakerThreshold: c.swis.breakerThreshold,
      breakerCooldownMs: c.swis.breakerCooldownMs,
      userAgent: `MercerAlertService/${c.version}`,
      logger: createLogger('swis'),
    });
    const probe = new SchemaProbe(client, createLogger('swis-probe'));
    const fetcher = new SwisFetcher(client, probe, {
      pageSize: c.swis.pageSize,
      incrementalPageSize: c.swis.incrementalPageSize,
      eventsBackfill: c.swis.eventsBackfill,
      naiveTimeZone: c.swis.naiveTimezone,
      logger: createLogger('swis-fetch'),
    });
    const source = new SourceMonitor(
      dbh.db,
      client,
      c.swis.staleAfterSec,
      createLogger('source'),
      now,
    );
    await source.init();
    return { key: swisKey(c), client, probe, fetcher, source };
  }

  function makeCtx(): WorkerContext | null {
    if (!runtime) return null;
    return {
      cfg,
      log,
      db: dbh.db,
      swis: { client: runtime.client, probe: runtime.probe, fetcher: runtime.fetcher },
      sites,
      source: runtime.source,
      onTransitions: async () => {
        await boss
          ?.send(CORRELATE_QUEUE, {})
          .catch((e: unknown) =>
            log.error({ err: errorMessage(e) }, 'could not enqueue correlation'),
          );
      },
      now,
    };
  }

  function clearPollTimers() {
    for (const t of pollTimers.splice(0)) clearInterval(t);
  }

  function schedulePolls() {
    clearPollTimers();
    if (!boss || mode !== 'monitoring') return;
    // Topology first: it refreshes the schema probe and custom-property list.
    // Nodes before alerts, so the first correlation already knows sites and device roles.
    // Groups before nodes: devices are placed in their SolarWinds site groups.
    const order: PollerName[] = ['topology', 'groups', 'nodes', 'alerts', 'interfaces', 'events'];
    order.forEach((name, i) => {
      const queue = POLL_QUEUES[name];
      const enqueue = () => {
        if (stopping || mode !== 'monitoring') return;
        boss
          ?.send(queue, {})
          .catch((e: unknown) => log.error({ queue, err: errorMessage(e) }, 'enqueue failed'));
      };
      pollTimers.push(setTimeout(enqueue, i * 1500));
      pollTimers.push(setInterval(enqueue, cfg.swis.pollSec[name] * 1000));
    });
    // Lifecycle timers (hold-down, reopen window, snoozes, maintenance) need a heartbeat of their own.
    pollTimers.push(
      setInterval(() => {
        if (!stopping && mode === 'monitoring') {
          boss
            ?.send(CORRELATE_QUEUE, {})
            .catch((e: unknown) =>
              log.error({ err: errorMessage(e) }, 'could not enqueue correlation'),
            );
        }
      }, CORRELATE_TICK_SEC * 1000),
    );
  }

  /** The mirror is trustworthy for reconcile once alerts and nodes have both been polled since start. */
  async function mirrorFresh(): Promise<boolean> {
    if (!monitoringSince) return false;
    const r = await dbh.pool.query<{ n: number }>(
      `select count(*)::int as n from poller_state where poller in ('alerts','nodes') and last_success_at >= $1`,
      [monitoringSince],
    );
    return (r.rows[0]?.n ?? 0) === 2;
  }

  async function correlateOnce(opts: { reconcile?: boolean } = {}): Promise<CycleSummary | null> {
    const c = ctx;
    if (!c) return null;
    const reconcile = opts.reconcile ?? (reconcileDue && (await mirrorFresh()));
    const summary = await runCorrelationCycle(c, { reconcile });
    if (reconcile) reconcileDue = false;
    return summary;
  }

  const notifyDeps = (): NotifyDeps => ({ cfg, db: dbh.db, box, log, now });

  /** Dispatch, escalate and send (also callable directly by the simulator and tests). */
  async function notifyOnce(): Promise<NotifySummary> {
    return runNotifyCycle(notifyDeps());
  }

  const aiDeps = (): AiDeps => ({ cfg, db: dbh.db, box, log: aiLog, now });

  async function aiOnce(): Promise<IncidentAiResult[]> {
    const out: IncidentAiResult[] = [];
    for (const id of await dueSummaries(aiDeps())) out.push(await runIncidentAi(aiDeps(), id));
    return out;
  }

  /** One debounced job per incident that needs a summary (a storm queues one, not 40). */
  const kickAi = () => {
    if (stopping || !boss || !cfg.ai.enabled) return;
    const b = boss;
    dueSummaries(aiDeps())
      .then(async (ids) => {
        for (const incidentId of ids)
          await b.send(
            AI_SUMMARY_QUEUE,
            { incidentId },
            { singletonKey: `inc:${incidentId}`, startAfter: cfg.ai.summaryDebounceSec },
          );
      })
      .catch((e: unknown) => log.error({ err: errorMessage(e) }, 'could not enqueue AI summaries'));
  };

  let digestSchedule = '';
  /** (Re)apply digest crons when they or the time zone change; called after pg-boss starts. */
  async function scheduleDigests(): Promise<void> {
    if (!boss) return;
    const key = JSON.stringify([cfg.digest, cfg.timezone]);
    if (key === digestSchedule) return;
    digestSchedule = key;
    for (const [kind, cron] of [
      ['daily', cfg.digest.dailyCron],
      ['weekly', cfg.digest.weeklyCron],
    ] as const) {
      if (cfg.digest.enabled)
        await boss.schedule(DIGEST_QUEUES[kind], cron, {}, { tz: cfg.timezone });
      else await boss.unschedule(DIGEST_QUEUES[kind]).catch(() => {});
    }
    log.info({ digest: cfg.digest }, 'digest schedule applied');
  }

  const kickNotify = () => {
    if (stopping || !boss) return;
    boss
      .send(NOTIFY_QUEUE, {})
      .catch((e: unknown) => log.error({ err: errorMessage(e) }, 'could not enqueue notify'));
  };

  /** Apply a new config: rebuild the SWIS runtime / site resolver / tickers only where it changed. */
  async function apply(next: AppConfig): Promise<void> {
    const prev = cfg;
    const prevMode = mode;
    cfg = next;
    if (mappingKey(prev) !== mappingKey(next) || !ctx)
      sites = new SiteResolver(dbh.db, next.mapping, createLogger('sites'));
    if (!isSwisConfigured(next.swis)) {
      if (runtime) await runtime.client.close();
      runtime = null;
    } else if (!runtime || runtime.key !== swisKey(next)) {
      const old = runtime;
      runtime = await buildRuntime(next);
      if (old) {
        await old.client.close();
        log.info(
          { swis: next.swis.baseUrl },
          'Orion connection settings changed; SWIS client rebuilt',
        );
      }
      await runtime.probe
        .refresh()
        .catch((e: unknown) => log.warn({ err: errorMessage(e) }, 'schema probe failed'));
    }
    ctx = makeCtx();
    mode = runtime && monitoringWanted(next) ? 'monitoring' : 'awaiting_setup';
    if (mode !== prevMode) {
      if (mode === 'monitoring') {
        monitoringSince = now();
        reconcileDue = true;
        log.info({ swis: next.swis.baseUrl, pollSec: next.swis.pollSec }, 'monitoring started');
      } else log.info('awaiting setup: finish the setup wizard in the web UI to start polling');
    }
    if (mode !== prevMode || pollKey(prev) !== pollKey(next)) {
      if (mode === prevMode && mode === 'monitoring')
        log.info({ pollSec: next.swis.pollSec }, 'poll intervals updated');
      schedulePolls();
    }
    // New site-group settings: link sites and re-place devices now, not at the next tick.
    else if (mode === 'monitoring' && mappingKey(prev) !== mappingKey(next)) {
      for (const queue of [POLL_QUEUES.groups, POLL_QUEUES.nodes])
        await boss
          ?.send(queue, {})
          .catch((e: unknown) => log.error({ queue, err: errorMessage(e) }, 'enqueue failed'));
    }
    await scheduleDigests().catch((e: unknown) =>
      log.error({ err: errorMessage(e) }, 'could not schedule digests'),
    );
  }

  async function doReload(): Promise<void> {
    try {
      fingerprint = await settingsFingerprint(dbh.db);
      const saved = await loadSettings(dbh.db, box);
      if (saved.undecryptable.length) {
        log.error(
          { keys: saved.undecryptable },
          'saved secrets cannot be decrypted (master key changed?); re-enter them in Settings',
        );
      }
      const next = loadConfig(env, saved.values);
      configError = null;
      await apply(next);
    } catch (err) {
      configError = err instanceof ConfigError ? err.message : errorMessage(err);
      if (mode === 'awaiting_setup') mode = 'config_error';
      log.error(
        { err: configError },
        'could not apply saved settings; keeping the previous configuration',
      );
    }
  }

  /** Always reads settings that were committed before the call (waits out an in-flight reload first). */
  async function reloadConfig(): Promise<void> {
    while (reloading) await reloading;
    reloading = doReload().finally(() => {
      reloading = null;
    });
    return reloading;
  }

  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reloadConfig(), 500);
  }

  async function listen(): Promise<void> {
    try {
      listener = new pg.Client({
        connectionString: bootstrap.database.url,
        application_name: 'mas-worker-listen',
      });
      listener.on('error', (e) =>
        log.warn({ err: errorMessage(e) }, 'config listener error; falling back to polling'),
      );
      listener.on('notification', (n) => {
        if (n.payload?.includes('"t":"config"')) scheduleReload();
        // Acknowledged, snoozed or resolved in the dashboard: update Teams, cancel escalations.
        else if (n.payload?.includes('"t":"incident"')) kickNotify();
      });
      await listener.connect();
      await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (err) {
      log.warn(
        { err: errorMessage(err) },
        'could not LISTEN for config changes; using periodic checks only',
      );
    }
  }

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
        status: mode === 'monitoring' ? 'ok' : mode,
        version: cfg.version,
        host: hostname(),
        details: {
          pid: process.pid,
          mode,
          configError,
          uptimeSec: Math.round((now().getTime() - startedAt.getTime()) / 1000),
          backlog,
        },
      });
      // Dashboards and the wall show DATA STALE when these stop arriving.
      await publishEvent(dbh.db, { t: 'heartbeat', component: 'worker' });
      if (runtime && mode === 'monitoring') await runtime.source.evaluate();
      lastBeatOk = now();
      // Fallback change detection if NOTIFY was missed.
      if ((await settingsFingerprint(dbh.db)) !== fingerprint) await reloadConfig();
      if (cfg.worker.deadmanPingUrl) {
        await fetch(cfg.worker.deadmanPingUrl, { signal: AbortSignal.timeout(5000) }).catch(
          (e: unknown) => log.warn({ err: errorMessage(e) }, 'dead-man ping failed'),
        );
      }
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'heartbeat failed');
    }
  }

  const pollOnce = (name: PollerName) => {
    const c = ctx;
    if (!c) return Promise.resolve(null);
    return runPoll(c, name, POLLERS[name]);
  };

  return {
    get ctx() {
      return ctx;
    },
    get cfg() {
      return cfg;
    },
    get mode() {
      return mode;
    },
    get boss() {
      return boss;
    },
    box,
    pollOnce,
    reloadConfig,
    correlateOnce,
    notifyOnce,
    selfCheckOnce: () => runSelfCheck(notifyDeps()),
    aiOnce,
    digestOnce: (kind, o) => runDigest(aiDeps(), kind, o),
    chatOnce: (job) => runChatJob(aiDeps(), job),

    async start() {
      await reloadConfig();
      await beat();
      if (!scheduling) return;

      boss = new PgBoss({
        connectionString: bootstrap.database.url,
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
          if (mode === 'monitoring') await pollOnce(name);
        });
      }
      // Setup-wizard jobs: answered within a second or two (the web request waits for them).
      // Re-read settings first: the admin may have saved them a moment ago, before the NOTIFY-driven
      // reload ran, and "use the saved connection" must mean the one just saved.
      const setupHandler =
        <T>(fn: (input: ConnectionInput) => Promise<T>) =>
        async ([job]: Array<{ data: ConnectionInput }>) => {
          await reloadConfig();
          return fn(job?.data ?? {});
        };
      for (const queue of Object.values(SETUP_QUEUES)) {
        await boss.createQueue(queue, {
          policy: 'standard',
          retryLimit: 0,
          expireInSeconds: 180,
          retentionSeconds: 3600,
        });
      }
      const setupLog = createLogger('setup');
      await boss.work(
        SETUP_QUEUES.cert,
        { pollingIntervalSeconds: 0.5 },
        setupHandler((i) => runCertJob(i, cfg, box)),
      );
      await boss.work(
        SETUP_QUEUES.test,
        { pollingIntervalSeconds: 0.5 },
        setupHandler((i) => runTestJob(i, cfg, box, dbh.db, setupLog)),
      );
      await boss.work(
        SETUP_QUEUES.discover,
        { pollingIntervalSeconds: 0.5 },
        setupHandler((i) => runDiscoverJob(i, cfg, box, dbh.db, setupLog)),
      );

      await boss.createQueue(CORRELATE_QUEUE, {
        policy: 'stately',
        retryLimit: 1,
        expireInSeconds: 600,
      });
      await boss.work(CORRELATE_QUEUE, { pollingIntervalSeconds: 1 }, async () => {
        if (mode === 'monitoring') {
          await correlateOnce();
          kickNotify();
          kickAi();
        }
      });
      await boss.createQueue(RETENTION_QUEUE, {
        policy: 'singleton',
        retryLimit: 2,
        expireInSeconds: 3600,
      });
      await boss.work(RETENTION_QUEUE, async () => {
        const purged = await purgeExpired(dbh.db, cfg.retention);
        await purgeExpiredSessions(dbh.db);
        log.info({ purged }, 'retention purge complete');
      });
      await boss.schedule(RETENTION_QUEUE, cfg.retention.cron, {}, { tz: cfg.timezone });

      await boss.createQueue(WRITEBACK_ACK_QUEUE, {
        retryLimit: 2,
        retryDelay: 15,
        expireInSeconds: 300,
      });
      await boss.work(WRITEBACK_ACK_QUEUE, async ([job]) => {
        if (job) return runWritebackAck(job.data, cfg, dbh.db, log);
      });
      await boss.createQueue(WRITEBACK_NOTE_QUEUE, {
        retryLimit: 2,
        retryDelay: 15,
        expireInSeconds: 300,
      });
      await boss.work(WRITEBACK_NOTE_QUEUE, async ([job]) => {
        if (job) return runWritebackNote(job.data, cfg, dbh.db, log);
      });
      // Never retried: the outcome is stored on the write and shown next to the site notes.
      await boss.createQueue(WRITEBACK_SITE_NOTES_QUEUE, { retryLimit: 0, expireInSeconds: 300 });
      await boss.work(WRITEBACK_SITE_NOTES_QUEUE, async ([job]) => {
        if (job) return runWritebackSiteNotes(job.data, cfg, dbh.db, log);
      });

      // One lookup at a time (and one per second, in runGeocodeSite), as OpenStreetMap asks.
      await boss.createQueue(GEOCODE_SITE_QUEUE, {
        retryLimit: 2,
        retryDelay: 30,
        expireInSeconds: 120,
      });
      await boss.work(GEOCODE_SITE_QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
        if (!job) return;
        await reloadConfig();
        return runGeocodeSite(job.data, cfg, dbh.db, log);
      });

      // Notifications run in every mode: the outbox, escalations and test-sends don't need SWIS.
      await boss.createQueue(NOTIFY_QUEUE, {
        policy: 'stately',
        retryLimit: 1,
        expireInSeconds: 300,
      });
      await boss.work(NOTIFY_QUEUE, { pollingIntervalSeconds: 1 }, async () => {
        await notifyOnce();
      });
      await boss.createQueue(SELFCHECK_QUEUE, { policy: 'singleton', retryLimit: 0 });
      await boss.work(SELFCHECK_QUEUE, async () => {
        await runSelfCheck(notifyDeps());
      });
      await boss.schedule(SELFCHECK_QUEUE, '* * * * *', {}, { tz: cfg.timezone });
      await boss.createQueue(NOTIFY_TEST_QUEUE, { retryLimit: 0, expireInSeconds: 120 });
      await boss.work(NOTIFY_TEST_QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
        if (!job) return;
        await reloadConfig();
        const input = notifyTestSchema.parse(job.data);
        return runTestSend(notifyDeps(), input.target, input.by);
      });

      // AI: enrichment only, in its own queues; nothing above waits for it.
      await boss.createQueue(AI_SUMMARY_QUEUE, {
        policy: 'stately',
        retryLimit: 0,
        expireInSeconds: 900,
      });
      await boss.work(AI_SUMMARY_QUEUE, { pollingIntervalSeconds: 2 }, async ([job]) => {
        const id = Number((job?.data as { incidentId?: unknown } | undefined)?.incidentId);
        if (Number.isInteger(id) && id > 0) return runIncidentAi(aiDeps(), id);
      });
      for (const kind of ['daily', 'weekly'] as const) {
        await boss.createQueue(DIGEST_QUEUES[kind], {
          policy: 'singleton',
          retryLimit: 1,
          retryDelay: 300,
          expireInSeconds: 900,
        });
        await boss.work(DIGEST_QUEUES[kind], { pollingIntervalSeconds: 1 }, async ([job]) => {
          await reloadConfig();
          const input = digestRunSchema.parse(job?.data ?? {});
          const r = await runDigest(aiDeps(), kind, { manual: input.manual });
          kickNotify();
          return r;
        });
      }
      await scheduleDigests();
      // Ask the network: a few answers in parallel; each turn has its own deadline.
      await boss.createQueue(AI_CHAT_QUEUE, { retryLimit: 0, expireInSeconds: 300 });
      await boss.work(
        AI_CHAT_QUEUE,
        { pollingIntervalSeconds: 0.5, localConcurrency: 3 },
        async ([job]) => {
          if (!job) return;
          return runChatJob(aiDeps(), chatJobSchema.parse(job.data));
        },
      );
      await boss.createQueue(AI_TEST_QUEUE, { retryLimit: 0, expireInSeconds: 180 });
      await boss.work(AI_TEST_QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
        await reloadConfig();
        const input = aiTestSchema.parse(job?.data);
        return runAiTest(aiDeps(), input.model);
      });

      await listen();
      schedulePolls();
      baseTimers.push(setInterval(kickNotify, NOTIFY_TICK_SEC * 1000));
      baseTimers.push(setInterval(kickAi, AI_SWEEP_SEC * 1000));
      baseTimers.push(
        setInterval(
          () =>
            void failStaleChats(aiDeps()).catch((e: unknown) =>
              log.warn({ err: errorMessage(e) }, 'could not clean up stale chat answers'),
            ),
          60_000,
        ),
      );
      baseTimers.push(setInterval(() => void beat(), cfg.worker.heartbeatSec * 1000));
      log.info(
        { mode, swis: isSwisConfigured(cfg.swis) ? cfg.swis.baseUrl : null },
        'worker started',
      );
    },

    async stop() {
      stopping = true;
      clearPollTimers();
      for (const t of baseTimers.splice(0)) clearInterval(t);
      if (reloadTimer) clearTimeout(reloadTimer);
      await listener?.end().catch(() => {});
      if (boss) await boss.stop({ graceful: true, timeout: 15_000 }).catch(() => {});
      await runtime?.client.close();
      await dbh.close();
    },

    async health() {
      const details: Record<string, unknown> = {
        mode,
        configError,
        uptimeSec: Math.round((now().getTime() - startedAt.getTime()) / 1000),
        lastHeartbeatAt: lastBeatOk?.toISOString() ?? null,
        source: runtime?.source.current ?? 'not_configured',
        breaker: runtime?.client.breaker.snapshot().state ?? null,
        tlsVerification: runtime?.client.getStats().tlsVerification ?? null,
      };
      try {
        await dbh.pool.query('select 1');
        details.db = 'ok';
      } catch (err) {
        details.db = errorMessage(err);
        return { ok: false, details };
      }
      const staleMs = cfg.worker.heartbeatSec * 4 * 1000;
      // Awaiting setup is a healthy state: the container must stay up so the wizard can use it.
      const ok = !!lastBeatOk && now().getTime() - lastBeatOk.getTime() < staleMs;
      return { ok, details };
    },
  };
}
