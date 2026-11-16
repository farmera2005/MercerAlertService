/**
 * One-shot `init` container (runs as root before everything else): generates the bootstrap
 * secrets into the shared `bootstrap` volume so no .env file has to be written by hand.
 * Existing files are never overwritten, so re-running is safe.
 *
 *   postgres_password  → read by the db and backup containers (owner postgres, 70)
 *   database_url       → read by migrate/worker/web (owner node, 1000)
 *   master_key         → encrypts secrets saved in the web UI (owner node, 1000)
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateMasterKey } from '@mercer/core';

const dir = process.env.BOOTSTRAP_DIR ?? '/bootstrap';
const PG_UID = Number(process.env.BOOTSTRAP_PG_UID ?? 70);
const APP_UID = Number(process.env.BOOTSTRAP_APP_UID ?? 1000);
const user = process.env.POSTGRES_USER ?? 'mas';
const database = process.env.POSTGRES_DB ?? 'mas';
const dbHost = process.env.POSTGRES_HOST ?? 'db';

function log(msg: string, extra: Record<string, unknown> = {}) {
  process.stdout.write(
    JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      component: 'init',
      msg,
      ...extra,
    }) + '\n',
  );
}

function ensure(
  name: string,
  make: () => string,
  uid: number,
): { value: string; created: boolean } {
  const file = join(dir, name);
  if (existsSync(file)) return { value: readFileSync(file, 'utf8').trim(), created: false };
  writeFileSync(file, make() + '\n', { mode: 0o400, flag: 'wx' });
  try {
    chownSync(file, uid, uid);
  } catch {
    /* not root (local testing) — leave ownership as is */
  }
  chmodSync(file, 0o400);
  log(`generated ${name}`);
  return { value: readFileSync(file, 'utf8').trim(), created: true };
}

mkdirSync(dir, { recursive: true });
// An operator may still pin the DB password through the environment.
const pw = ensure(
  'postgres_password',
  () => process.env.POSTGRES_PASSWORD || randomBytes(24).toString('hex'),
  PG_UID,
);
ensure(
  'database_url',
  () => `postgres://${user}:${encodeURIComponent(pw.value)}@${dbHost}:5432/${database}`,
  APP_UID,
);
ensure('master_key', generateMasterKey, APP_UID);
log('bootstrap secrets ready', { dir });
