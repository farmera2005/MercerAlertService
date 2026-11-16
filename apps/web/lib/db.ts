import 'server-only';
import { createDb, type DbHandle } from '@mercer/db';
import { loadConfig, type AppConfig } from '@mercer/core';

const g = globalThis as unknown as { __mas?: { cfg: AppConfig; db: DbHandle } };

/** One pool per web process (survives dev hot-reload). */
export function server(): { cfg: AppConfig; db: DbHandle } {
  if (!g.__mas) {
    const cfg = loadConfig();
    g.__mas = {
      cfg,
      db: createDb({ url: cfg.database.url, poolMax: 5, applicationName: 'mas-web' }),
    };
  }
  return g.__mas;
}
