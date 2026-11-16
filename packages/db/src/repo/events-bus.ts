import { sql } from 'drizzle-orm';
import { EVENTS_CHANNEL, type BusEvent } from '@mercer/core';
import type { DbOrTx } from '../client';

export { EVENTS_CHANNEL, type BusEvent };

/** Payloads must stay small (pg_notify limit 8 KB); the schema lives in @mercer/core/events. */
export async function publishEvent(db: DbOrTx, ev: BusEvent): Promise<void> {
  await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(ev)})`);
}
