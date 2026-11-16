import 'server-only';
import { createDb, type DbHandle } from '@mercer/db';
import {
  createLogger,
  loadConfig,
  loadOrCreateMasterKey,
  type AppConfig,
  type Logger,
  type SecretBox,
} from '@mercer/core';

interface ServerState {
  /** Environment-only config (DATABASE_URL etc.). Use getSettingsState() for effective settings. */
  bootstrap: AppConfig;
  db: DbHandle;
  box: SecretBox;
  log: Logger;
}

const g = globalThis as unknown as { __mas?: ServerState };

/** One pool / key per web process (survives dev hot-reload). */
export function server(): ServerState {
  if (!g.__mas) {
    const bootstrap = loadConfig();
    g.__mas = {
      bootstrap,
      db: createDb({ url: bootstrap.database.url, poolMax: 5, applicationName: 'mas-web' }),
      box: loadOrCreateMasterKey().box,
      log: createLogger('web'),
    };
  }
  return g.__mas;
}
