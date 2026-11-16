import { and, eq, sql } from 'drizzle-orm';
import { planIncidentAction, type ActionRequest } from '@mercer/core';
import { alertRecords, incidentEvents, incidentMembers, incidents } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import { publishEvent } from './events-bus';
import { lockCorrelation } from './locks';
import type { Actor } from './settings';

export type IncidentActionResult =
  | { ok: true; incidentId: number; status: string; activeOrionAlerts: number }
  | { ok: false; error: string; notFound?: boolean };

/**
 * Apply a person's action (ack, snooze, resolve, note, …) to an incident: audited, on the
 * incident timeline and announced over SSE, all in one transaction that also excludes the
 * correlator.
 */
export async function applyIncidentAction(
  db: Db,
  incidentId: number,
  req: ActionRequest,
  actor: Actor & { display: string },
  now = new Date(),
): Promise<IncidentActionResult> {
  return db.transaction(async (tx) => {
    await lockCorrelation(tx);
    const [inc] = await tx
      .select()
      .from(incidents)
      .where(eq(incidents.id, incidentId))
      .for('update');
    if (!inc) return { ok: false, error: 'Incident not found.', notFound: true };
    const [counts] = await tx
      .select({
        active: sql<number>`count(*) filter (where ${alertRecords.state} = 'active')::int`,
        orion: sql<number>`count(*) filter (where ${alertRecords.state} = 'active' and ${alertRecords.source} = 'orion' and ${alertRecords.currentAlertObjectId} is not null)::int`,
      })
      .from(incidentMembers)
      .innerJoin(alertRecords, eq(alertRecords.id, incidentMembers.alertRecordId))
      .where(eq(incidentMembers.incidentId, incidentId));

    const plan = planIncidentAction(
      { status: inc.status, snoozedUntil: inc.snoozedUntil, activeAlerts: counts?.active ?? 0 },
      req,
      actor.display,
      now,
    );
    if (!plan.ok) return { ok: false, error: plan.error };

    if (Object.keys(plan.patch).length || plan.material) {
      await tx
        .update(incidents)
        .set({
          ...plan.patch,
          ...(plan.material ? { materialRev: inc.materialRev + 1 } : {}),
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(eq(incidents.id, incidentId));
    }
    await tx.insert(incidentEvents).values({
      incidentId,
      at: now,
      type: plan.event.type,
      actor: `user:${actor.display}`,
      message: plan.event.message,
      details: plan.event.details ?? null,
    });
    const pick = (o: Record<string, unknown>) =>
      Object.fromEntries(
        Object.keys(plan.patch).map((k) => {
          const v = o[k];
          return [k, v instanceof Date ? v.toISOString() : v];
        }),
      );
    await writeAudit(tx, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      ip: actor.ip,
      userAgent: actor.userAgent,
      action: `incident.${req.action}`,
      targetType: 'incident',
      targetId: incidentId,
      before: Object.keys(plan.patch).length ? pick(inc) : undefined,
      after:
        req.action === 'note'
          ? { note: plan.event.message }
          : { ...pick(plan.patch as Record<string, unknown>), ...(plan.event.details ?? {}) },
    });
    await publishEvent(tx, { t: 'incident', id: incidentId, change: req.action });
    return {
      ok: true,
      incidentId,
      status: plan.patch.status ?? inc.status,
      activeOrionAlerts: counts?.orion ?? 0,
    };
  });
}

/** The Orion alert objects an Orion write-back ack would acknowledge. */
export async function activeOrionAlertObjects(
  db: Db,
  incidentId: number,
): Promise<Array<{ alertObjectId: number; caption: string }>> {
  const rows = await db
    .select({ id: alertRecords.currentAlertObjectId, caption: alertRecords.entityCaption })
    .from(incidentMembers)
    .innerJoin(alertRecords, eq(alertRecords.id, incidentMembers.alertRecordId))
    .where(
      and(
        eq(incidentMembers.incidentId, incidentId),
        eq(alertRecords.state, 'active'),
        eq(alertRecords.source, 'orion'),
        eq(alertRecords.acknowledgedInOrion, false),
      ),
    );
  return rows
    .filter((r): r is { id: number; caption: string | null } => r.id !== null)
    .map((r) => ({ alertObjectId: r.id, caption: r.caption ?? '' }));
}

export async function addIncidentSystemEvent(
  db: DbOrTx,
  incidentId: number,
  ev: { type: string; message: string; details?: Record<string, unknown> },
  now = new Date(),
): Promise<void> {
  await db.insert(incidentEvents).values({
    incidentId,
    at: now,
    type: ev.type,
    actor: 'system',
    message: ev.message,
    details: ev.details ?? null,
  });
}
