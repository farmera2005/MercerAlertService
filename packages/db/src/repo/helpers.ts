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
