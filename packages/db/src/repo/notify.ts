/**
 * Worker side of notifications: which incidents need a dispatch pass, recording plans in the
 * notifications outbox, escalations, sending bookkeeping, notifier health and short links.
 */
import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  displayTitle,
  type DispatchPlan,
  type NotificationPurpose,
  type NotifyIncident,
  type NotifyState,
  type PlannedMessage,
} from '@mercer/core';
import {
  divisions,
  escalations,
  incidentNotifyState,
  incidents,
  notifications,
  notifierHealth,
  shortLinks,
  sites,
} from '../schema';
import type { Db, DbOrTx, Tx } from '../client';

export type NotificationRow = typeof notifications.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;
type StateRow = typeof incidentNotifyState.$inferSelect;
type SiteRow = typeof sites.$inferSelect;

export const NOTIFY_LOCK_KEY = 4_204_202_604;

export async function lockNotify(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${NOTIFY_LOCK_KEY})`);
}

// ---------------------------------------------------------------------------------------------
// Dispatch candidates
// ---------------------------------------------------------------------------------------------

export interface DispatchCandidate {
  incident: IncidentRow;
  site: SiteRow | null;
  divisionName: string | null;
  state: StateRow | null;
}

/**
 * Incidents whose announced state lags their real state: never seen while open, or status,
 * priority, kind, material revision or snooze changed since the last dispatch.
 */
export async function loadDispatchCandidates(
  db: DbOrTx,
  now: Date,
  limit = 200,
): Promise<DispatchCandidate[]> {
  const i = incidents;
  const s = incidentNotifyState;
  const snoozeNow = sql`CASE WHEN ${i.snoozedUntil} > ${now} THEN ${i.snoozedUntil} END`;
  const rows = await db
    .select({ incident: i, site: sites, divisionName: divisions.name, state: s })
    .from(i)
    .leftJoin(s, eq(s.incidentId, i.id))
    .leftJoin(sites, eq(sites.id, i.primarySiteId))
    .leftJoin(divisions, eq(divisions.code, i.divisionCode))
    .where(
      sql`(${s.incidentId} IS NULL AND ${i.status} IN ('open','acknowledged'))
        OR (${s.incidentId} IS NOT NULL AND (
              ${s.lastStatus} <> ${i.status}
           OR ${s.lastPriority} <> ${i.priority}
           OR ${s.lastKind} <> ${i.kind}
           OR ${s.lastMaterialRev} <> ${i.materialRev}
           OR ${s.lastSnoozedUntil} IS DISTINCT FROM ${snoozeNow}
           OR (${s.baselined} AND NOT ${i.seeded} AND ${i.status} IN ('open','acknowledged'))))`,
    )
    .orderBy(asc(i.id))
    .limit(limit);
  return rows;
}

export function toNotifyIncident(
  i: IncidentRow,
  siteName: string | null,
  divisionName: string | null,
): NotifyIncident {
  return {
    id: i.id,
    status: i.status,
    priority: i.priority,
    kind: i.kind,
    title: displayTitle(i),
    summary: i.templateSummary,
    siteId: i.primarySiteId,
    siteName,
    affectedSiteIds: i.affectedSiteIds,
    divisionCode: i.divisionCode,
    divisionName,
    alertCount: i.alertCount,
    openedAt: i.openedAt,
    acknowledgedBy: i.acknowledgedBy,
    resolvedAt: i.resolvedAt,
    resolvedBy: i.resolvedBy,
    snoozedUntil: i.snoozedUntil,
    snoozedBy: i.snoozedBy,
    materialRev: i.materialRev,
    inMaintenance: i.inMaintenance,
    seeded: i.seeded,
    recoveryTargetMin: i.recoveryTargetMin,
  };
}

export function toNotifyState(r: StateRow): NotifyState {
  return {
    lastStatus: r.lastStatus,
    lastPriority: r.lastPriority,
    lastKind: r.lastKind,
    lastMaterialRev: r.lastMaterialRev,
    updateCount: r.updateCount,
    pagedAt: r.pagedAt,
    pagedPersonIds: r.pagedPersonIds,
    lastSnoozedUntil: r.lastSnoozedUntil,
    baselined: r.baselined,
  };
}

export async function loadNotifyState(db: DbOrTx, incidentId: number): Promise<NotifyState | null> {
  const [row] = await db
    .select()
    .from(incidentNotifyState)
    .where(eq(incidentNotifyState.incidentId, incidentId));
  return row ? toNotifyState(row) : null;
}

/** Pages queued or sent to each person since `since` (for the per-person rate limit). */
export async function recentPageCounts(db: DbOrTx, since: Date): Promise<Map<number, number>> {
  const rows = await db
    .select({ personId: notifications.personId, n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        inArray(notifications.kind, ['sms', 'pushover']),
        inArray(notifications.status, ['queued', 'sent']),
        gte(notifications.createdAt, since),
      ),
    )
    .groupBy(notifications.personId);
  return new Map(rows.filter((r) => r.personId !== null).map((r) => [r.personId!, r.n]));
}

// ---------------------------------------------------------------------------------------------
// Recording plans
// ---------------------------------------------------------------------------------------------

function rowsFor(messages: PlannedMessage[], incidentId: number | null, now: Date) {
  return messages.map((m) => ({
    incidentId,
    purpose: m.purpose,
    kind: m.kind,
    channelKey: m.channelKey,
    personId: m.personId,
    recipient: m.recipient,
    payload: m.payload,
    status: (m.suppressReason ? 'suppressed' : 'queued') as 'suppressed' | 'queued',
    suppressReason: m.suppressReason,
    shadow: m.shadow,
    createdAt: now,
    nextAttemptAt: m.suppressReason ? null : now,
  }));
}

export async function recordMessages(
  tx: DbOrTx,
  incidentId: number | null,
  messages: PlannedMessage[],
  now: Date,
): Promise<number[]> {
  if (!messages.length) return [];
  const rows = await tx
    .insert(notifications)
    .values(rowsFor(messages, incidentId, now))
    .returning({ id: notifications.id });
  return rows.map((r) => r.id);
}

async function saveState(tx: DbOrTx, incidentId: number, st: NotifyState, now: Date) {
  const values = { ...st, updatedAt: now };
  await tx
    .insert(incidentNotifyState)
    .values({ incidentId, ...values })
    .onConflictDoUpdate({ target: incidentNotifyState.incidentId, set: values });
}

async function cancelPending(tx: DbOrTx, incidentId: number, reason: string, now: Date) {
  await tx
    .update(escalations)
    .set({ cancelledAt: now, cancelReason: reason })
    .where(
      and(
        eq(escalations.incidentId, incidentId),
        isNull(escalations.firedAt),
        isNull(escalations.cancelledAt),
      ),
    );
}

export async function persistDispatch(
  tx: Tx,
  incidentId: number,
  plan: DispatchPlan,
  afterMin: number,
  now: Date,
): Promise<number[]> {
  const ids = await recordMessages(tx, incidentId, plan.messages, now);
  await saveState(tx, incidentId, plan.state, now);
  if (plan.cancelEscalations) await cancelPending(tx, incidentId, plan.cancelEscalations, now);
  if (plan.scheduleEscalations.length) {
    await cancelPending(tx, incidentId, 'rescheduled', now);
    await tx.insert(escalations).values(
      plan.scheduleEscalations.map((e) => ({
        incidentId,
        level: e.level,
        afterMin,
        dueAt: e.dueAt,
        createdAt: now,
      })),
    );
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------------------------

export type EscalationRow = typeof escalations.$inferSelect;

export async function dueEscalations(db: DbOrTx, now: Date, limit = 50): Promise<EscalationRow[]> {
  return db
    .select()
    .from(escalations)
    .where(
      and(
        isNull(escalations.firedAt),
        isNull(escalations.cancelledAt),
        lte(escalations.dueAt, now),
      ),
    )
    .orderBy(asc(escalations.dueAt))
    .limit(limit);
}

export async function finishEscalation(
  tx: DbOrTx,
  id: number,
  now: Date,
  cancelReason: string | null,
): Promise<void> {
  await tx
    .update(escalations)
    .set(cancelReason ? { cancelledAt: now, cancelReason } : { firedAt: now })
    .where(eq(escalations.id, id));
}

export async function saveNotifyState(
  tx: DbOrTx,
  incidentId: number,
  st: NotifyState,
  now: Date,
): Promise<void> {
  await saveState(tx, incidentId, st, now);
}

export async function pendingEscalations(db: DbOrTx, incidentId: number) {
  return db
    .select()
    .from(escalations)
    .where(eq(escalations.incidentId, incidentId))
    .orderBy(asc(escalations.dueAt));
}

// ---------------------------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------------------------

/** Retry schedule after a retryable failure (attempt 1 failed → wait 30 s, …). */
export const RETRY_BACKOFF_SEC = [30, 60, 120, 300, 600];
export const MAX_ATTEMPTS = RETRY_BACKOFF_SEC.length + 1;

/**
 * Claim due queued messages: each gets a short lease (next_attempt_at pushed forward) so a
 * crashed sender's messages are retried, never lost; a send is at-least-once.
 */
export async function claimOutbox(
  db: Db,
  now: Date,
  limit = 25,
  leaseMs = 120_000,
): Promise<NotificationRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.status, 'queued'), lte(notifications.nextAttemptAt, now)))
      .orderBy(asc(notifications.nextAttemptAt), asc(notifications.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(notifications)
      .set({
        attempts: sql`${notifications.attempts} + 1`,
        nextAttemptAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      })
      .where(
        inArray(
          notifications.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });
}

export async function markNotificationSent(
  db: DbOrTx,
  id: number,
  now: Date,
  ref: { providerRef: string | null; threadRef: string | null },
): Promise<void> {
  await db
    .update(notifications)
    .set({
      status: 'sent',
      sentAt: now,
      nextAttemptAt: null,
      lastError: null,
      ...ref,
      updatedAt: now,
    })
    .where(eq(notifications.id, id));
}

/** A failed attempt: requeue with backoff while retryable and attempts remain, else failed. */
export async function markNotificationFailed(
  db: DbOrTx,
  row: Pick<NotificationRow, 'id' | 'attempts'>,
  now: Date,
  error: string,
  retryable: boolean,
): Promise<'retry' | 'failed'> {
  const wait = RETRY_BACKOFF_SEC[row.attempts - 1];
  const retry = retryable && wait !== undefined;
  await db
    .update(notifications)
    .set({
      status: retry ? 'queued' : 'failed',
      lastError: error.slice(0, 500),
      nextAttemptAt: retry ? new Date(now.getTime() + wait * 1000) : null,
      updatedAt: now,
    })
    .where(eq(notifications.id, row.id));
  return retry ? 'retry' : 'failed';
}

export async function suppressNotification(
  db: DbOrTx,
  id: number,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .update(notifications)
    .set({ status: 'suppressed', suppressReason: reason, nextAttemptAt: null, updatedAt: now })
    .where(eq(notifications.id, id));
}

export async function outboxStats(db: DbOrTx, now: Date) {
  const [r] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${notifications.status} = 'queued')::int`,
      overdue: sql<number>`count(*) filter (where ${notifications.status} = 'queued' and ${notifications.nextAttemptAt} < ${new Date(now.getTime() - 5 * 60_000)})::int`,
    })
    .from(notifications);
  return { queued: r?.queued ?? 0, overdue: r?.overdue ?? 0 };
}

/** A message that is not about an incident (test-send, MAS self-alert). */
export async function recordStandalone(
  db: DbOrTx,
  m: PlannedMessage & { purpose: NotificationPurpose },
  now: Date,
): Promise<number> {
  const [id] = await recordMessages(db, null, [m], now);
  return id!;
}

export async function getNotification(db: DbOrTx, id: number) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
  return row;
}

export async function notificationsForIncident(db: DbOrTx, incidentId: number) {
  return db
    .select({
      id: notifications.id,
      purpose: notifications.purpose,
      kind: notifications.kind,
      recipient: notifications.recipient,
      status: notifications.status,
      suppressReason: notifications.suppressReason,
      shadow: notifications.shadow,
      attempts: notifications.attempts,
      lastError: notifications.lastError,
      createdAt: notifications.createdAt,
      sentAt: notifications.sentAt,
    })
    .from(notifications)
    .where(eq(notifications.incidentId, incidentId))
    .orderBy(desc(notifications.id))
    .limit(200);
}

// ---------------------------------------------------------------------------------------------
// Notifier health
// ---------------------------------------------------------------------------------------------

export type NotifierHealthRow = typeof notifierHealth.$inferSelect;

export async function recordNotifierResult(
  db: DbOrTx,
  key: string,
  now: Date,
  error: string | null,
): Promise<void> {
  const ok = error === null;
  await db
    .insert(notifierHealth)
    .values({
      key,
      consecutiveFailures: ok ? 0 : 1,
      lastSuccessAt: ok ? now : null,
      lastFailureAt: ok ? null : now,
      lastError: ok ? null : error.slice(0, 500),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: notifierHealth.key,
      set: ok
        ? { consecutiveFailures: 0, lastSuccessAt: now, updatedAt: now }
        : {
            consecutiveFailures: sql`${notifierHealth.consecutiveFailures} + 1`,
            lastFailureAt: now,
            lastError: error.slice(0, 500),
            updatedAt: now,
          },
    });
}

export async function listNotifierHealth(db: DbOrTx): Promise<NotifierHealthRow[]> {
  return db.select().from(notifierHealth).orderBy(asc(notifierHealth.key));
}

export async function markNotifierAlerted(db: DbOrTx, key: string, now: Date): Promise<void> {
  await db.update(notifierHealth).set({ lastAlertedAt: now }).where(eq(notifierHealth.key, key));
}

// ---------------------------------------------------------------------------------------------
// Short links
// ---------------------------------------------------------------------------------------------

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () =>
  Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** The /i/<code> link for an incident (one per incident, renewed when it expires). */
export async function ensureShortLink(
  db: DbOrTx,
  incidentId: number,
  now: Date,
  ttlDays = 30,
): Promise<string> {
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);
  const [existing] = await db
    .select()
    .from(shortLinks)
    .where(eq(shortLinks.incidentId, incidentId));
  if (existing && existing.expiresAt.getTime() > now.getTime() + 86_400_000) return existing.code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const rows = await db
      .insert(shortLinks)
      .values({ code, incidentId, createdAt: now, expiresAt })
      .onConflictDoUpdate({ target: shortLinks.incidentId, set: { code, expiresAt } })
      .returning({ code: shortLinks.code })
      .catch((err: unknown) => {
        // A clash on the code itself (primary key): try another one.
        if (String(err).includes('short_links_pkey')) return [];
        throw err;
      });
    if (rows[0]) return rows[0].code;
  }
  throw new Error('could not allocate a short link');
}

export async function resolveShortLink(db: DbOrTx, code: string, now = new Date()) {
  if (!/^[2-9A-HJ-NP-Z]{6}$/i.test(code)) return null;
  const [row] = await db
    .select({ incidentId: shortLinks.incidentId, expiresAt: shortLinks.expiresAt })
    .from(shortLinks)
    .where(eq(shortLinks.code, code.toUpperCase()));
  return row && row.expiresAt.getTime() > now.getTime() ? row.incidentId : null;
}

/** Claim one queued message by id (test-sends deliver immediately instead of waiting a tick). */
export async function claimNotification(
  db: DbOrTx,
  id: number,
  now: Date,
  leaseMs = 120_000,
): Promise<NotificationRow | null> {
  const [row] = await db
    .update(notifications)
    .set({
      attempts: sql`${notifications.attempts} + 1`,
      nextAttemptAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'queued')))
    .returning();
  return row ?? null;
}

/** The incident with its site and division, as the notification planner needs it. */
export async function loadIncidentForNotify(db: DbOrTx, id: number) {
  const [row] = await db
    .select({ incident: incidents, site: sites, divisionName: divisions.name })
    .from(incidents)
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .leftJoin(divisions, eq(divisions.code, incidents.divisionCode))
    .where(eq(incidents.id, id));
  return row ?? null;
}
