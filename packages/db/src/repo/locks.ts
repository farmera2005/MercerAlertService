import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

/**
 * Held by the correlator for a whole cycle and by every user action on an incident, so a person's
 * Ack can never be overwritten by a correlation run that loaded the incident a moment earlier.
 */
export const CORRELATION_LOCK_KEY = 4_204_202_603;

export async function lockCorrelation(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${CORRELATION_LOCK_KEY})`);
}
