import 'server-only';
import {
  constantTimeEquals,
  generateSetupCode,
  INTERNAL_SETTING_KEYS,
  normalizeSetupCode,
} from '@mercer/core';
import {
  countActiveAccounts,
  deleteInternalSetting,
  getInternalSetting,
  setInternalSetting,
} from '@mercer/db';
import { server } from './server';

/**
 * First-run protection: until an admin account exists, /setup requires a one-time code that is
 * only visible in the web container's log (`docker compose logs web`). Whoever can read the
 * server's logs can claim it; someone who merely reaches port 3000 cannot.
 */
export async function ensureSetupCode(opts: { announce?: boolean } = {}): Promise<string | null> {
  const { db, box, log, bootstrap } = server();
  if ((await countActiveAccounts(db.db)) > 0) {
    await deleteInternalSetting(db.db, INTERNAL_SETTING_KEYS.setupCode);
    return null;
  }
  const stored = await getInternalSetting<{ enc: string }>(db.db, INTERNAL_SETTING_KEYS.setupCode);
  let code: string | null = null;
  if (stored?.enc) {
    try {
      code = box.open(stored.enc);
    } catch {
      code = null;
    }
  }
  if (!code) {
    code = generateSetupCode();
    await setInternalSetting(db.db, INTERNAL_SETTING_KEYS.setupCode, { enc: box.seal(code) });
  }
  if (opts.announce !== false) {
    log.warn(
      { setupCode: code, url: `${bootstrap.baseUrl}/setup` },
      `SETUP REQUIRED — open the dashboard in a browser and enter setup code ${code}`,
    );
  }
  return code;
}

export async function checkSetupCode(input: string): Promise<boolean> {
  const code = await ensureSetupCode({ announce: false });
  if (!code) return false;
  return constantTimeEquals(normalizeSetupCode(input), normalizeSetupCode(code));
}
