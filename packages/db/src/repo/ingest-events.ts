import { chunk } from '@mercer/core';
import { orionAlertHistory, orionEvents } from '../schema';
import type { DbOrTx } from '../client';

export interface EventRow {
  eventId: number;
  eventTime: Date | null;
  eventType: number;
  eventTypeName: string | null;
  message: string | null;
  nodeId: number | null;
  netObjectId: string | null;
  netObjectType: string | null;
  acknowledged: boolean;
}

export interface AlertHistoryRow {
  alertHistoryId: number;
  eventType: number;
  at: Date | null;
  message: string | null;
  accountId: string | null;
  alertActiveId: number | null;
  alertObjectId: number | null;
  alertId: number | null;
  entityUri: string | null;
  relatedNodeId: number | null;
}

export async function insertEvents(db: DbOrTx, rows: EventRow[]): Promise<number> {
  let n = 0;
  for (const part of chunk(rows, 500)) {
    const res = await db
      .insert(orionEvents)
      .values(part.map((r) => ({ ...r, message: r.message?.slice(0, 4000) ?? null })))
      .onConflictDoNothing()
      .returning({ id: orionEvents.eventId });
    n += res.length;
  }
  return n;
}

export async function insertAlertHistory(db: DbOrTx, rows: AlertHistoryRow[]): Promise<number> {
  let n = 0;
  for (const part of chunk(rows, 500)) {
    const res = await db
      .insert(orionAlertHistory)
      .values(part.map((r) => ({ ...r, message: r.message?.slice(0, 4000) ?? null })))
      .onConflictDoNothing()
      .returning({ id: orionAlertHistory.alertHistoryId });
    n += res.length;
  }
  return n;
}
