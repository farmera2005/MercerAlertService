import { createLogger, loadConfig } from '@mercer/core';
import { defaultMigrationsFolder, runMigrations } from '../migrate';

const log = createLogger('migrate');
const cfg = loadConfig();
const folder = defaultMigrationsFolder();
log.info({ folder }, 'applying migrations');
await runMigrations(cfg.database.url, folder);
log.info('migrations applied');
