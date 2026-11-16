/** Entry for the one-shot `migrate` Compose service: migrations, then first-install seed. */
import { createLogger, initLogger, loadConfig } from '@mercer/core';
import { createDb, seedReferenceData } from '@mercer/db';
import { defaultMigrationsFolder, runMigrations } from '@mercer/db/migrate';

const cfg = loadConfig();
initLogger({ service: 'mas-migrate', level: cfg.logLevel, version: cfg.version });
const log = createLogger('migrate');
const folder = defaultMigrationsFolder();
log.info({ folder }, 'applying migrations');
await runMigrations(cfg.database.url, folder);
const h = createDb({ url: cfg.database.url, poolMax: 1, applicationName: 'mas-migrate' });
try {
  const seeded = await seedReferenceData(h.db, { sites: 'if-empty' });
  log.info({ seeded }, 'migrations applied; reference data ensured');
} finally {
  await h.close();
}
