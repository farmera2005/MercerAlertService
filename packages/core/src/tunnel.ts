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

/** The token goes in TUNNEL_TOKEN (the environment), never on the command line. */
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

const LEVELS: Record<string, TunnelLogLevel> = {
  DBG: 'debug',
  INF: 'info',
  WRN: 'warn',
  ERR: 'error',
  FTL: 'error',
};

/** A cloudflared log line ("2026-11-19T20:00:00Z ERR Unable to …") as level and message. */
export function parseCloudflaredLine(line: string): { level: TunnelLogLevel; message: string } {
  const m = /^\S+Z\s+(DBG|INF|WRN|ERR|FTL)\s+(.*)$/.exec(line.trim());
  if (!m) return { level: 'info', message: line.trim().slice(0, 500) };
  return { level: LEVELS[m[1]!]!, message: m[2]!.slice(0, 500) };
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
