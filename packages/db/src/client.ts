import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything repository functions can run against: the pool-backed db or an open transaction. */
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(opts: {
  url: string;
  poolMax?: number;
  applicationName?: string;
}): DbHandle {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.poolMax ?? 10,
    application_name: opts.applicationName ?? 'mas',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
