import 'server-only';
import { headers } from 'next/headers';

/** Client IP and user agent for audit rows. X-Forwarded-For is only trusted with TRUST_PROXY=true. */
export async function requestMeta(): Promise<{
  ip: string | null;
  userAgent: string | null;
  https: boolean;
  origin: string;
}> {
  const h = await headers();
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const fwd = h.get('x-forwarded-for');
  // Client-supplied headers are spoofable, so they are only believed behind a trusted proxy.
  const ip = trustProxy ? ((fwd ? fwd.split(',')[0]!.trim() : h.get('x-real-ip')) ?? null) : null;
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  return {
    ip,
    userAgent: h.get('user-agent'),
    https: proto === 'https',
    origin: `${proto}://${host}`,
  };
}

/** Small in-memory limiter (per web process) for login / setup-code attempts. */
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}
