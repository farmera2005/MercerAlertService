import { entityTransitions } from '../schema';
import type { DbOrTx } from '../client';
import { chunk } from '@mercer/core';

export type TransitionInsert = typeof entityTransitions.$inferInsert;

export async function insertTransitions(db: DbOrTx, rows: TransitionInsert[]): Promise<number> {
  for (const part of chunk(rows, 500)) await db.insert(entityTransitions).values(part);
  return rows.length;
}
