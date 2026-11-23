/**
 * Remote access through a Cloudflare Tunnel. The worker runs Cloudflare's connector (cloudflared)
 * with the tunnel token from Settings; Cloudflare forwards the tunnel's public hostname to the web
 * app. This module holds the pure parts: reading the token, the connector's status and log lines,
 * and which client address to believe.
 */
import { z } from 'zod';
import { normalizeIp } from './net';

const tokenSchema = z.object({
  /** Account tag. */
  a: z.string().regex(/^[0-9a-f]{32}$/i),
  /** Tunnel ID. */
  t: z.string().uuid(),
  /** Tunnel secret. */
  s: z.string().min(16),
});

/**
 * A remotely managed tunnel's token (the string after `--token` in Cloudflare's install command)
 * is base64 JSON. Returns the tunnel ID to show, or null when it isn't such a token.
 */
export function parseTunnelToken(token: string): { accountTag: string; tunnelId: string } | null {
  const t = token.trim();
  if (!/^[A-Za-z0-9+/_=-]{40,4096}$/.test(t)) return null;
  try {
    const json = JSON.parse(Buffer.from(t, 'base64').toString('utf8')) as unknown;
    const p = tokenSchema.safeParse(json);
    return p.success ? { accountTag: p.data.a.toLowerCase(), tunnelId: p.data.t } : null;
  } catch {
    return null;
  }
}

/** Where cloudflared serves /ready inside the worker container. */
export const TUNNEL_METRICS_ADDR = '127.0.0.1:20241';

/**
 * The token goes in TUNNEL_TOKEN (the environment), never on the command line. JSON log lines let
 * the worker read the routes Cloudflare pushes and the requests that failed.
 */
export const CLOUDFLARED_ENV = { NO_AUTOUPDATE: 'true', TUNNEL_LOG_OUTPUT: 'json' } as const;

export function cloudflaredArgs(metricsAddr = TUNNEL_METRICS_ADDR): string[] {
  return ['tunnel', '--no-autoupdate', '--metrics', metricsAddr, 'run'];
}

const readySchema = z.object({
  status: z.number().int(),
  readyConnections: z.number().int().min(0),
  connectorId: z.string().optional(),
});

/** cloudflared's GET /ready: connected when it holds at least one edge connection. */
export function parseTunnelReady(
  httpStatus: number,
  body: unknown,
): { connected: boolean; connections: number; connectorId: string | null } {
  const p = readySchema.safeParse(body);
  const connections = p.success ? p.data.readyConnections : 0;
  return {
    connected: httpStatus === 200 && connections > 0,
    connections,
    connectorId: p.success ? (p.data.connectorId ?? null) : null,
  };
}

export type TunnelLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CloudflaredLine {
  level: TunnelLogLevel;
  message: string;
  /** The line's fields (`error`, `originService`, `config`, …), from either log format. */
  fields: Record<string, unknown>;
}

const LEVELS: Record<string, TunnelLogLevel> = {
  DBG: 'debug',
  INF: 'info',
  WRN: 'warn',
  ERR: 'error',
  FTL: 'error',
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
  panic: 'error',
};

/** key=value and key="quoted value" pairs in cloudflared's console format (Go-quoted strings). */
function consoleFields(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of text.matchAll(/(?:^|\s)([A-Za-z][\w.-]*)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
    const raw = m[2]!;
    if (!raw.startsWith('"')) out[m[1]!] = raw;
    else
      try {
        out[m[1]!] = JSON.parse(raw) as unknown;
      } catch {
        out[m[1]!] = raw.slice(1, -1);
      }
  }
  return out;
}

/**
 * A cloudflared log line as level, message and fields. MAS asks for JSON lines
 * (TUNNEL_LOG_OUTPUT=json); the console format ("2026-11-19T20:00:00Z ERR Unable to …") is read
 * too, for a connector that ignores the setting.
 */
export function parseCloudflaredLine(line: string): CloudflaredLine {
  const t = line.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const f = o as Record<string, unknown>;
        const text = [f.message, f.error]
          .filter((v): v is string => typeof v === 'string' && v !== '')
          .join(': ');
        return {
          level: LEVELS[String(f.level)] ?? 'info',
          message: (text || t).slice(0, 500),
          fields: f,
        };
      }
    } catch {
      // Not JSON after all: read it as text.
    }
  }
  const m = /^\S+Z\s+(DBG|INF|WRN|ERR|FTL)\s+(.*)$/.exec(t);
  if (!m) return { level: 'info', message: t.slice(0, 500), fields: {} };
  return { level: LEVELS[m[1]!]!, message: m[2]!.slice(0, 500), fields: consoleFields(m[2]!) };
}

/**
 * Where the tunnel's public hostname must send requests: the web container, by its name on the
 * Docker network. The connector runs in the worker container, so localhost there is the worker.
 */
export const TUNNEL_WEB_ORIGIN = 'web:3000';

/** One of the tunnel's routes (Cloudflare: Published application routes / Public hostnames). */
export interface TunnelRoute {
  /** Null for the catch-all rule at the end. */
  hostname: string | null;
  path: string | null;
  service: string;
}

const remoteConfigSchema = z.object({
  ingress: z.array(
    z.object({
      hostname: z.string().optional(),
      path: z.string().optional(),
      service: z.string().optional(),
    }),
  ),
});

export type TunnelLogEvent =
  | { kind: 'routes'; routes: TunnelRoute[] }
  | { kind: 'origin_error'; service: string | null; error: string };

/**
 * What a log line says about the tunnel's routes. cloudflared logs each configuration Cloudflare
 * pushes ("Updated to new configuration", the routes as JSON in `config`), and each request it
 * could not pass on ("Unable to reach the origin service", with `originService`).
 */
export function tunnelLogEvent(l: CloudflaredLine): TunnelLogEvent | null {
  const message = typeof l.fields.message === 'string' ? l.fields.message : l.message;
  if (message.startsWith('Updated to new configuration') && typeof l.fields.config === 'string') {
    try {
      const p = remoteConfigSchema.safeParse(JSON.parse(l.fields.config));
      if (!p.success) return null;
      return {
        kind: 'routes',
        routes: p.data.ingress.map((r) => ({
          hostname: r.hostname || null,
          path: r.path || null,
          service: r.service ?? '',
        })),
      };
    } catch {
      return null;
    }
  }
  const error = typeof l.fields.error === 'string' ? l.fields.error : '';
  if (!/unable to reach the origin service/i.test(error)) return null;
  const service =
    typeof l.fields.originService === 'string'
      ? l.fields.originService
      : (/dial tcp (\S+?):? connect/.exec(error)?.[1] ?? null);
  return { kind: 'origin_error', service, error: error.slice(0, 500) };
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1?\]?|0\.0\.0\.0)$/i;
const FIX = `In Cloudflare, set its service type to HTTP and the URL to ${TUNNEL_WEB_ORIGIN}.`;

/** Why a route's service can't reach MAS's web app from the connector, or null when it can. */
export function tunnelServiceProblem(service: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(service)) return `That is not MAS’s web app. ${FIX}`;
  let u: URL;
  try {
    u = new URL(service);
  } catch {
    return `That is not a valid address. ${FIX}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `That is not MAS’s web app. ${FIX}`;
  if (LOOPBACK.test(u.hostname))
    return `The connector runs inside MAS’s worker container, where that address is the worker itself, so nothing answers. ${FIX}`;
  if (u.hostname.toLowerCase() === 'web') {
    if (u.protocol === 'https:')
      return `MAS’s web container speaks plain HTTP inside the Docker network. ${FIX}`;
    if (u.port !== '3000') return `The web container listens on port 3000. ${FIX}`;
  }
  return null;
}

/** What is wrong with the tunnel's routes as Cloudflare sent them; empty when they reach MAS. */
export function tunnelRouteProblems(routes: readonly TunnelRoute[]): string[] {
  const named = routes.filter((r) => r.hostname);
  if (!named.length)
    return [
      `The tunnel has no public hostname yet. In Cloudflare, add one with the service type HTTP and the URL ${TUNNEL_WEB_ORIGIN}.`,
    ];
  return named.flatMap((r) => {
    const why = tunnelServiceProblem(r.service);
    return why ? [`${r.hostname}${r.path ?? ''} sends requests to ${r.service}. ${why}`] : [];
  });
}

/** What to check after the connector could not reach a route's service. */
export function tunnelOriginHint(service: string | null): string {
  return (
    (service ? tunnelServiceProblem(service) : null) ??
    `Check that MAS’s web container is running (docker compose ps -a), and that the route’s service in Cloudflare is HTTP with the URL ${TUNNEL_WEB_ORIGIN}.`
  );
}

/**
 * The client address of a request that came through the tunnel: Cloudflare's CF-Connecting-IP,
 * believed only when the connection comes from the connector itself. Null for any other request
 * (then the usual rules apply), so nobody on the network can claim an address with the header.
 */
export function tunnelClientIp(opts: {
  peer: string | null | undefined;
  connectorIps: readonly string[];
  cfConnectingIp: string | null | undefined;
}): string | null {
  const peer = normalizeIp(opts.peer);
  if (!peer || !opts.connectorIps.some((c) => normalizeIp(c) === peer)) return null;
  return normalizeIp(opts.cfConnectingIp);
}
