import { sql } from 'drizzle-orm';
import type { Db } from '../client';

export interface RetentionPolicy {
  rawDays: number;
  pollRunsDays: number;
  auditDays: number;
  incidentDays?: number;
}

/** [table, timestamp column, policy key]. Later milestones append incident/notification tables. */
const TARGETS: Array<[string, string, 'rawDays' | 'pollRunsDays' | 'auditDays']> = [
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
  // Closed incidents (members and events cascade), then cleared records no incident still uses.
  const incCutoff = new Date(now.getTime() - (policy.incidentDays ?? 730) * 86_400_000);
  const inc = await db.execute(
    sql`DELETE FROM incidents WHERE status = 'closed' AND closed_at < ${incCutoff}`,
  );
  out.incidents = inc.rowCount ?? 0;
  const rawCutoff = new Date(now.getTime() - policy.rawDays * 86_400_000);
  const recs = await db.execute(
    sql`DELETE FROM alert_records WHERE state = 'cleared' AND last_seen_at < ${rawCutoff} AND (incident_id IS NULL OR NOT EXISTS (SELECT 1 FROM incidents i WHERE i.id = alert_records.incident_id))`,
  );
  out.alert_records = recs.rowCount ?? 0;
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
