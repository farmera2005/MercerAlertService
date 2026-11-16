import 'server-only';
import { headers } from 'next/headers';
import { clientIp } from '@mercer/core';
import { peerIpFrom } from './peer-ip';
import { effectiveConfig } from './settings';

export interface RequestMeta {
  /** Real client address (socket peer, or our proxy's X-Forwarded-For entry), or null. */
  ip: string | null;
  userAgent: string | null;
  https: boolean;
  origin: string;
}

export async function metaFromHeaders(h: Headers): Promise<RequestMeta> {
  const cfg = await effectiveConfig();
  const ip = clientIp({
    peer: peerIpFrom(h),
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
