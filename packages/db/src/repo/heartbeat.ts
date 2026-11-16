import { eq } from 'drizzle-orm';
import { componentHeartbeats } from '../schema';
import type { DbOrTx } from '../client';

export type HeartbeatRow = typeof componentHeartbeats.$inferSelect;

export async function upsertHeartbeat(
  db: DbOrTx,
  hb: {
    component: string;
    status: string;
    details?: Record<string, unknown>;
    version?: string;
    host?: string;
    at?: Date;
  },
): Promise<void> {
  const values = {
    component: hb.component,
    lastBeatAt: hb.at ?? new Date(),
    status: hb.status,
    details: hb.details ?? {},
    version: hb.version,
    host: hb.host,
  };
  await db
    .insert(componentHeartbeats)
    .values(values)
    .onConflictDoUpdate({
      target: componentHeartbeats.component,
      set: {
        lastBeatAt: values.lastBeatAt,
        status: values.status,
        details: values.details,
        version: values.version,
        host: values.host,
      },
    });
}

export async function getHeartbeat(
  db: DbOrTx,
  component: string,
): Promise<HeartbeatRow | undefined> {
  const [row] = await db
    .select()
    .from(componentHeartbeats)
    .where(eq(componentHeartbeats.component, component));
  return row;
}

export async function listHeartbeats(db: DbOrTx): Promise<HeartbeatRow[]> {
  return db.select().from(componentHeartbeats);
}
