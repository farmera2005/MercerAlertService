import { createLogger, loadConfig } from '@mercer/core';
import { createDb } from '../client';
import { seedReferenceData } from '../seed';

const log = createLogger('seed');
const cfg = loadConfig();
const h = createDb({ url: cfg.database.url, poolMax: 1, applicationName: 'mas-seed' });
try {
  const r = await seedReferenceData(h.db);
  log.info(r, 'seed complete (existing rows left untouched)');
} finally {
  await h.close();
}
