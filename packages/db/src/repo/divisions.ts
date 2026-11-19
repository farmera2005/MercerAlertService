/**
 * Division names for a site's or an incident's division list, in divisions order (sort_order,
 * then name). Codes that are not in `divisions` are ignored.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** Names as an array (empty when none). */
export function divisionNameList(codes: AnyPgColumn | SQL): SQL<string[]> {
  return sql<
    string[]
  >`coalesce((select array_agg(d.name order by d.sort_order, d.name) from divisions d where d.code = any(${codes})), '{}'::text[])`;
}

/** Names joined for display ("Grain, Agronomy"); null when none. */
export function divisionNames(codes: AnyPgColumn | SQL): SQL<string | null> {
  return sql<
    string | null
  >`(select string_agg(d.name, ', ' order by d.sort_order, d.name) from divisions d where d.code = any(${codes}))`;
}
