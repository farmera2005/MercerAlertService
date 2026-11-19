import 'server-only';
import { lookup } from 'node:dns/promises';
import { headers } from 'next/headers';
import { clientIp, tunnelClientIp } from '@mercer/core';
import { peerIpFrom } from './peer-ip';
import { effectiveConfig } from './settings';

export interface RequestMeta {
  /** Real client address (socket peer, or our proxy's X-Forwarded-For entry), or null. */
  ip: string | null;
  userAgent: string | null;
  https: boolean;
  origin: string;
}

let connector: { host: string; ips: string[]; at: number } | null = null;

/** The tunnel connector's addresses (the worker's container), looked up at most once a minute. */
async function connectorIps(host: string): Promise<string[]> {
  if (connector?.host === host && Date.now() - connector.at < 60_000) return connector.ips;
  const ips = await lookup(host, { all: true })
    .then((r) => r.map((a) => a.address))
    .catch(() => []);
  connector = { host, ips, at: Date.now() };
  return ips;
}

export async function metaFromHeaders(h: Headers): Promise<RequestMeta> {
  const cfg = await effectiveConfig();
  // Through the Cloudflare Tunnel: the client address is CF-Connecting-IP, believed only on
  // connections from the connector itself.
  const peer = peerIpFrom(h);
  if (cfg.tunnel.enabled && peer) {
    const viaTunnel = tunnelClientIp({
      peer,
      connectorIps: await connectorIps(cfg.tunnel.connectorHost),
      cfConnectingIp: h.get('cf-connecting-ip'),
    });
    if (viaTunnel) {
      const proto = h.get('x-forwarded-proto') === 'http' ? 'http' : 'https';
      return {
        ip: viaTunnel,
        userAgent: h.get('user-agent'),
        https: proto === 'https',
        origin: `${proto}://${h.get('host') ?? 'localhost:3000'}`,
      };
    }
  }
  const ip = clientIp({
    peer,
    forwardedFor: h.get('x-forwarded-for'),
    trustProxy: cfg.web.trustProxy,
    hops: cfg.web.trustProxyHops,
  });
  // Forwarded proto/host are only believed behind a trusted proxy.
  const proto = cfg.web.trustProxy ? (h.get('x-forwarded-proto') ?? 'http') : 'http';
  const host =
    (cfg.web.trustProxy ? h.get('x-forwarded-host') : null) ?? h.get('host') ?? 'localhost:3000';
  return {
    ip,
    userAgent: h.get('user-agent'),
    https: proto === 'https' || cfg.baseUrl.startsWith('https://'),
    origin: `${proto}://${host}`,
  };
}

/** Client IP and user agent for audit rows (server components and actions). */
export async function requestMeta(): Promise<RequestMeta> {
  return metaFromHeaders(await headers());
}

/** Small in-memory limiter (per web process) for login / setup-code / wall-token attempts. */
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}

/** Failure-only limiter: lets a busy wall refresh freely, throttles someone guessing tokens. */
const failures = new Map<string, { count: number; resetAt: number }>();
export function tooManyFailures(key: string, limit: number): boolean {
  const f = failures.get(key);
  return !!f && f.resetAt > Date.now() && f.count >= limit;
}
export function noteFailure(key: string, windowMs: number): void {
  const now = Date.now();
  const f = failures.get(key);
  if (!f || f.resetAt < now) failures.set(key, { count: 1, resetAt: now + windowMs });
  else f.count++;
}
