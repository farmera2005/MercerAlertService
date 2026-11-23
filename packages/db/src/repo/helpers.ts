import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Build an `ON CONFLICT DO UPDATE SET col = excluded.col` map for every column of `table`
 * except those listed (by TS property name).
 */
export function excludedSet<T extends PgTable>(
  table: T,
  except: ReadonlyArray<keyof T['$inferSelect']>,
): Record<string, SQL> {
  const out: Record<string, SQL> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    if ((except as readonly string[]).includes(key)) continue;
    out[key] = sql.raw(`excluded."${col.name}"`);
  }
  return out;
}

/** Running average for rollup upserts: (old*samples + new)/(samples+1), null-tolerant. */
export function runningAvg(tableName: string, column: string): SQL {
  const t = `"${tableName}"."${column}"`;
  const e = `excluded."${column}"`;
  return sql.raw(
    `CASE WHEN ${e} IS NULL THEN ${t} WHEN ${t} IS NULL THEN ${e} ELSE (${t} * "${tableName}"."samples" + ${e}) / ("${tableName}"."samples" + 1) END`,
  );
}

export function runningMax(tableName: string, column: string): SQL {
  return sql.raw(`GREATEST("${tableName}"."${column}", excluded."${column}")`);
}

export const UPSERT_CHUNK = 500;

/**
 * Await lazy Drizzle queries one after another, typed like `Promise.all`. Inside a transaction
 * everything shares one connection, so `Promise.all` gains nothing and stacks queries on a busy
 * client, which pg 9 rejects.
 */
export async function inSequence<T extends readonly unknown[] | []>(
  queries: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const out: unknown[] = [];
  for (const q of queries) out.push(await q);
  return out as { -readonly [P in keyof T]: Awaited<T[P]> };
}

/**
 * Whether an error is Postgres refusing a duplicate on `constraint`. Drizzle wraps the driver's
 * error ("Failed query: …"), so the constraint is on the error or its cause, not in the message.
 */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 3; e = (e as { cause?: unknown }).cause, i++) {
    const pgErr = e as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === constraint) return true;
  }
  return String(err).includes(constraint);
}
