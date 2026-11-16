import 'server-only';
import { ipAllowed } from '@mercer/core';
import { findKioskToken, touchKioskToken, type KioskTokenRow } from '@mercer/db';
import { metaFromHeaders, noteFailure, tooManyFailures } from './request';
import { server } from './server';

export type KioskCheck =
  | { ok: true; token: KioskTokenRow; ip: string | null }
  | { ok: false; reason: 'invalid' | 'ip_not_allowed' | 'rate_limited' };

/**
 * Validate a wall-display token presented in the URL: known, not revoked or expired, and the
 * client inside the token's IP allowlist. Wall pages and their SSE stream both call this.
 */
export async function checkKioskToken(token: string, h: Headers): Promise<KioskCheck> {
  const meta = await metaFromHeaders(h);
  const key = `wall:${meta.ip ?? 'unknown'}`;
  if (tooManyFailures(key, 20)) return { ok: false, reason: 'rate_limited' };
  const { db, log } = server();
  const row = await findKioskToken(db.db, token);
  if (!row) {
    noteFailure(key, 15 * 60_000);
    return { ok: false, reason: 'invalid' };
  }
  if (!ipAllowed(meta.ip, row.allowedCidrs)) {
    noteFailure(key, 15 * 60_000);
    log.warn(
      { kiosk: row.name, tokenPrefix: row.tokenPrefix, ip: meta.ip },
      'wall link used from an address outside its allowlist',
    );
    return { ok: false, reason: 'ip_not_allowed' };
  }
  await touchKioskToken(db.db, row, meta.ip);
  return { ok: true, token: row, ip: meta.ip };
}
