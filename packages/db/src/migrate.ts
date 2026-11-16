import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

/** Arbitrary constant: serializes concurrent migrators (e.g. two containers starting at once). */
const MIGRATION_LOCK_KEY = 4_204_202_601;

export function defaultMigrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const local = fileURLToPath(new URL('../migrations', import.meta.url));
  return existsSync(local) ? local : '/app/migrations';
}

export async function runMigrations(
  url: string,
  folder = defaultMigrationsFolder(),
): Promise<void> {
  // One connection so the session-level advisory lock covers the whole migration.
  const handle = createDb({ url, poolMax: 1, applicationName: 'mas-migrate' });
  try {
    await handle.db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    try {
      await migrate(handle.db, { migrationsFolder: folder });
    } finally {
      await handle.db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    }
  } finally {
    await handle.close();
  }
}
