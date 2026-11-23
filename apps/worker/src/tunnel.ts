/**
 * Runs Cloudflare's tunnel connector (cloudflared) while the tunnel is on in Settings. The token
 * reaches cloudflared only through its environment (TUNNEL_TOKEN), never the command line or the
 * logs. The connector is restarted with back-off when it exits, and its /ready endpoint says
 * whether Cloudflare's edge is connected; the status is reported for Settings → General. The
 * connector logs the routes Cloudflare pushes and each request it couldn't pass on, so the status
 * also says when a route can't reach MAS (localhost:3000 is the worker itself, not the web app).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  CLOUDFLARED_ENV,
  TUNNEL_METRICS_ADDR,
  cloudflaredArgs,
  errorMessage,
  parseCloudflaredLine,
  parseTunnelReady,
  tunnelLogEvent,
  tunnelRouteProblems,
  type AppConfig,
  type Logger,
  type TunnelRoute,
} from '@mercer/core';

export type TunnelState =
  'off' | 'starting' | 'connecting' | 'connected' | 'restarting' | 'not_installed';

export interface TunnelSnapshot {
  state: TunnelState;
  tunnelId: string | null;
  connections: number;
  /** The connector's last error line, or why it stopped. */
  lastError: string | null;
  /** When the current state began. */
  since: string;
  restarts: number;
  /** The routes Cloudflare last sent the connector; null until it has. */
  routes: TunnelRoute[] | null;
  /** Why those routes can't reach MAS (tunnelRouteProblems). */
  routeProblems: string[];
  /** The last request the connector couldn't pass on, since the routes last changed. */
  originError: { service: string | null; error: string; at: string } | null;
}

export interface TunnelSupervisorOptions {
  log: Logger;
  /** Called on every change and every probe (the worker stores it as the 'tunnel' heartbeat). */
  report: (s: TunnelSnapshot) => Promise<void> | void;
  binary?: string;
  metricsAddr?: string;
  probeMs?: number;
  /** First restart delay; doubles up to five minutes. */
  backoffMs?: number;
  /** Extra environment for the connector (tests). It gets nothing else from the worker's. */
  env?: Record<string, string>;
}

const MAX_BACKOFF_MS = 5 * 60_000;
/** Failing requests can come many a second: report the same failure at most this often. */
const ORIGIN_REPORT_MS = 30_000;

export class TunnelSupervisor {
  private readonly binary: string;
  private readonly metricsAddr: string;
  private readonly probeMs: number;
  private readonly backoffMs: number;
  private child: ChildProcess | null = null;
  private key: string | null = null;
  private token: string | null = null;
  private snap: TunnelSnapshot = {
    state: 'off',
    tunnelId: null,
    connections: 0,
    lastError: null,
    since: new Date().toISOString(),
    restarts: 0,
    routes: null,
    routeProblems: [],
    originError: null,
  };
  private originReportedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: TunnelSupervisorOptions) {
    this.binary = o.binary ?? process.env.CLOUDFLARED_PATH ?? 'cloudflared';
    this.metricsAddr = o.metricsAddr ?? TUNNEL_METRICS_ADDR;
    this.probeMs = o.probeMs ?? 15_000;
    this.backoffMs = o.backoffMs ?? 5_000;
  }

  get snapshot(): TunnelSnapshot {
    return structuredClone(this.snap);
  }

  /** Start, restart (new token) or stop the connector to match the settings. */
  async apply(t: AppConfig['tunnel']): Promise<void> {
    const want = t.enabled && t.token ? createHash('sha256').update(t.token).digest('hex') : null;
    if (want === this.key) return;
    this.key = want;
    this.token = want ? t.token : null;
    this.clearTimers();
    await this.stopChild();
    this.snap.tunnelId = want ? t.tunnelId : null;
    this.snap.restarts = 0;
    this.snap.lastError = null;
    this.snap.connections = 0;
    this.snap.routes = null;
    this.snap.routeProblems = [];
    this.snap.originError = null;
    this.originReportedAt = 0;
    if (!want) {
      await this.set('off');
      this.o.log.info('Cloudflare Tunnel connector off');
      return;
    }
    await this.startChild();
    this.probeTimer = setInterval(() => void this.probe(), this.probeMs);
  }

  async stop(): Promise<void> {
    this.key = null;
    this.token = null;
    this.clearTimers();
    await this.stopChild();
    await this.set('off');
  }

  /** Ask the connector whether Cloudflare's edge is connected. */
  async probe(): Promise<void> {
    // Between restarts (or with no cloudflared), just keep the status fresh.
    if (!this.child || this.snap.state === 'restarting') return this.set(this.snap.state);
    try {
      const res = await fetch(`http://${this.metricsAddr}/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      const r = parseTunnelReady(res.status, await res.json().catch(() => null));
      this.snap.connections = r.connections;
      if (r.connected) {
        this.snap.restarts = 0;
        this.snap.lastError = null;
      }
      await this.set(r.connected ? 'connected' : 'connecting');
    } catch {
      // Not listening yet (starting) or busy: the next probe tells.
      await this.set(this.snap.state === 'starting' ? 'starting' : 'connecting');
    }
  }

  private async startChild(): Promise<void> {
    await this.set('starting');
    let child: ChildProcess;
    try {
      child = spawn(this.binary, cloudflaredArgs(this.metricsAddr), {
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? '/tmp',
          ...this.o.env,
          ...CLOUDFLARED_ENV,
          TUNNEL_TOKEN: this.token!,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return this.failed(errorMessage(err));
    }
    this.child = child;
    this.o.log.info({ tunnelId: this.snap.tunnelId }, 'Cloudflare Tunnel connector starting');
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on('line', (line) => this.onLine(line));
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null;
      if (err.code === 'ENOENT') {
        this.snap.lastError = 'cloudflared is not installed in this worker image';
        void this.set('not_installed');
        this.scheduleRestart(MAX_BACKOFF_MS);
      } else void this.failed(errorMessage(err));
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      void this.failed(this.snap.lastError ?? `cloudflared exited (${code ?? signal})`);
    });
  }

  private onLine(line: string): void {
    const parsed = parseCloudflaredLine(line);
    const event = tunnelLogEvent(parsed);
    if (event?.kind === 'routes') {
      this.snap.routes = event.routes;
      this.snap.routeProblems = tunnelRouteProblems(event.routes);
      // The routes changed, so an earlier failure may be fixed: wait for the next one.
      this.snap.originError = null;
      const routes = event.routes.map((r) => `${r.hostname ?? '*'}${r.path ?? ''} → ${r.service}`);
      if (this.snap.routeProblems.length)
        this.o.log.warn(
          { connector: 'cloudflared', routes, problems: this.snap.routeProblems },
          'the tunnel routes do not reach MAS',
        );
      else this.o.log.info({ connector: 'cloudflared', routes }, 'tunnel routes from Cloudflare');
      void this.set(this.snap.state);
      return;
    }
    this.o.log[parsed.level]({ connector: 'cloudflared' }, parsed.message);
    if (event?.kind === 'origin_error') {
      // A request failed, not the connection to Cloudflare: kept apart from lastError.
      const first = this.snap.originError?.service !== event.service;
      const now = Date.now();
      this.snap.originError = {
        service: event.service,
        error: event.error,
        at: new Date(now).toISOString(),
      };
      if (first || now - this.originReportedAt >= ORIGIN_REPORT_MS) {
        this.originReportedAt = now;
        void this.set(this.snap.state);
      }
      return;
    }
    if (parsed.level === 'error') this.snap.lastError = parsed.message;
  }

  private async failed(why: string): Promise<void> {
    if (!this.key) return;
    this.snap.lastError = why;
    this.snap.connections = 0;
    await this.set('restarting');
    const delay = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** this.snap.restarts);
    this.snap.restarts += 1;
    this.o.log.warn({ err: why, retryInSec: Math.round(delay / 1000) }, 'tunnel connector stopped');
    this.scheduleRestart(delay);
  }

  private scheduleRestart(delayMs: number): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const key = this.key;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.key && this.key === key && !this.child) void this.startChild();
    }, delayMs);
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.restartTimer = null;
    this.probeTimer = null;
  }

  private async set(state: TunnelState): Promise<void> {
    if (state !== this.snap.state) {
      this.snap.state = state;
      this.snap.since = new Date().toISOString();
    }
    try {
      await this.o.report(this.snapshot);
    } catch (err) {
      this.o.log.warn({ err: errorMessage(err) }, 'could not record the tunnel status');
    }
  }
}
