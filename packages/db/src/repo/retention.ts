import { sql } from 'drizzle-orm';
import type { Db } from '../client';

export interface RetentionPolicy {
  rawDays: number;
  pollRunsDays: number;
  auditDays: number;
}

/** [table, timestamp column, policy key]. Later milestones append incident/notification tables. */
const TARGETS: Array<[string, string, keyof RetentionPolicy]> = [
  ['entity_transitions', 'observed_at', 'rawDays'],
  ['node_metrics_5m', 'bucket', 'rawDays'],
  ['interface_metrics_5m', 'bucket', 'rawDays'],
  ['orion_events', 'event_time', 'rawDays'],
  ['orion_alert_history', 'at', 'rawDays'],
  ['poll_runs', 'started_at', 'pollRunsDays'],
  ['audit_log', 'at', 'auditDays'],
];

const BATCH = 10_000;

/** Delete expired rows in small batches (short locks, no long transactions). */
export async function purgeExpired(
  db: Db,
  policy: RetentionPolicy,
  now = new Date(),
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, column, key] of TARGETS) {
    const cutoff = new Date(now.getTime() - policy[key] * 86_400_000);
    let total = 0;
    for (;;) {
      const res = await db.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE ctid IN (SELECT ctid FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} < ${cutoff} LIMIT ${BATCH})`,
      );
      const n = res.rowCount ?? 0;
      total += n;
      if (n < BATCH) break;
    }
    out[table] = total;
  }
  return out;
}
