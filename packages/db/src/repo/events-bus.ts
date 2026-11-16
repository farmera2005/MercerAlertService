import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../client';

/** Channel the web process LISTENs on to drive SSE. Payloads must stay small (< 8 KB). */
export const EVENTS_CHANNEL = 'mas_events';

export type BusEvent =
  | { t: 'poll'; poller: string; ok: boolean; transitions?: number }
  | { t: 'source'; status: 'up' | 'down' }
  | { t: 'incident'; id: number; change: string }
  | { t: 'heartbeat'; component: string };

export async function publishEvent(db: DbOrTx, ev: BusEvent): Promise<void> {
  await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(ev)})`);
}
