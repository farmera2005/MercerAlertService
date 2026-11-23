/**
 * NOC boards: the boards admins compose (Settings → NOC boards), the boards a wall link shows,
 * and the read-only queries behind the widgets. Every change is audited.
 */
import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  activityKindOf,
  boardDefinitionSchema,
  boardRefSchema,
  customBoardRef,
  layoutProblems,
  type ActivityIn,
  type BoardDefinition,
  type BoardRef,
  type KpiIncident,
  type WanInterfaceIn,
} from '@mercer/core/noc';
import {
  entityTransitions,
  escalations,
  incidentEvents,
  incidents,
  interfaceMetrics5m,
  kioskTokens,
  nocBoards,
  nodeMetrics5m,
  notifications,
  orionInterfaces,
  orionNodes,
  people,
  sites,
} from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import { isUniqueViolation } from './helpers';
import type { Actor } from './settings';

export type NocBoardRow = typeof nocBoards.$inferSelect;

export async function listNocBoards(db: DbOrTx): Promise<NocBoardRow[]> {
  return db.select().from(nocBoards).orderBy(asc(nocBoards.name));
}

export async function getNocBoard(db: DbOrTx, id: number): Promise<NocBoardRow | null> {
  const [row] = await db.select().from(nocBoards).where(eq(nocBoards.id, id));
  return row ?? null;
}

export type SaveBoardResult = { ok: true; board: NocBoardRow } | { ok: false; error: string };

/** Create (no id) or update a board; the layout must be on the grid with no overlaps. */
export async function saveNocBoard(
  db: Db,
  input: { id?: number; name: string; definition: unknown },
  actor: Actor,
): Promise<SaveBoardResult> {
  const name = input.name.trim().slice(0, 80);
  if (!name) return { ok: false, error: 'Give the board a name.' };
  const parsed = boardDefinitionSchema.safeParse(input.definition);
  if (!parsed.success) return { ok: false, error: 'The board is not valid.' };
  const problems = layoutProblems(parsed.data.widgets);
  if (problems.length) return { ok: false, error: problems.join(' ') };
  const definition: BoardDefinition = parsed.data;
  try {
    return await db.transaction(async (tx) => {
      if (input.id) {
        const [before] = await tx.select().from(nocBoards).where(eq(nocBoards.id, input.id));
        if (!before) return { ok: false as const, error: 'That board no longer exists.' };
        const [board] = await tx
          .update(nocBoards)
          .set({ name, definition, updatedBy: actor.actorLabel, updatedAt: new Date() })
          .where(eq(nocBoards.id, input.id))
          .returning();
        await writeAudit(tx, {
          ...actor,
          action: 'noc_board.update',
          targetType: 'noc_board',
          targetId: input.id,
          before: { name: before.name, definition: before.definition },
          after: { name, definition },
        });
        return { ok: true as const, board: board! };
      }
      const [board] = await tx
        .insert(nocBoards)
        .values({ name, definition, createdBy: actor.actorLabel, updatedBy: actor.actorLabel })
        .returning();
      await writeAudit(tx, {
        ...actor,
        action: 'noc_board.create',
        targetType: 'noc_board',
        targetId: board!.id,
        after: { name, definition },
      });
      return { ok: true as const, board: board! };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'noc_boards_name_unique'))
      return { ok: false, error: 'A board with that name already exists.' };
    throw err;
  }
}

/** Delete a board, and take it off every wall link that showed it. */
export async function deleteNocBoard(db: Db, id: number, actor: Actor): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx.delete(nocBoards).where(eq(nocBoards.id, id)).returning();
    if (!before) return false;
    const ref = customBoardRef(id);
    await tx
      .update(kioskTokens)
      .set({ boards: sql`array_remove(${kioskTokens.boards}, ${ref})` })
      .where(sql`${ref} = ANY(${kioskTokens.boards})`);
    await writeAudit(tx, {
      ...actor,
      action: 'noc_board.delete',
      targetType: 'noc_board',
      targetId: id,
      before: { name: before.name, definition: before.definition },
    });
    return true;
  });
}

/** The boards a wall link rotates through (empty: the classic wall), audited. */
export async function setKioskBoards(
  db: Db,
  id: number,
  input: { boards: string[]; rotateSec: number | null },
  actor: Actor,
): Promise<boolean> {
  const boards = [...new Set(input.boards)].filter((b) => boardRefSchema.safeParse(b).success);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(kioskTokens).where(eq(kioskTokens.id, id));
    if (!before || before.revokedAt) return false;
    await tx
      .update(kioskTokens)
      .set({ boards, boardRotateSec: input.rotateSec })
      .where(eq(kioskTokens.id, id));
    await writeAudit(tx, {
      ...actor,
      action: 'kiosk.boards',
      targetType: 'kiosk_token',
      targetId: id,
      before: { boards: before.boards, rotateSec: before.boardRotateSec },
      after: { boards, rotateSec: input.rotateSec },
    });
    return true;
  });
}

/** Board refs that still exist (a wall link may name a deleted board). */
export async function existingBoardRefs(db: DbOrTx, refs: readonly string[]): Promise<BoardRef[]> {
  const ids = refs
    .map((r) => /^custom:(\d+)$/.exec(r)?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
  const found = ids.length
    ? new Set(
        (
          await db.select({ id: nocBoards.id }).from(nocBoards).where(inArray(nocBoards.id, ids))
        ).map((r) => customBoardRef(r.id)),
      )
    : new Set<string>();
  return refs.filter(
    (r): r is BoardRef =>
      boardRefSchema.safeParse(r).success && (!r.startsWith('custom:') || found.has(r)),
  );
}

// ---------------------------------------------------------------------------------------------
// Widget data (read-only)
// ---------------------------------------------------------------------------------------------

export type NocActivityRow = ActivityIn & { siteIds: number[] };

/** Incident events and pages since `since`, for the activity feed (with the incident's sites). */
export async function nocActivity(db: DbOrTx, since: Date, limit = 50): Promise<NocActivityRow[]> {
  const evs = await db
    .select({
      at: incidentEvents.at,
      type: incidentEvents.type,
      actor: incidentEvents.actor,
      incidentId: incidentEvents.incidentId,
      priority: incidents.priority,
      title: sql<string>`coalesce(${incidents.aiTitle}, ${incidents.title})`,
      site: sites.name,
      primarySiteId: incidents.primarySiteId,
      affectedSiteIds: incidents.affectedSiteIds,
    })
    .from(incidentEvents)
    .innerJoin(incidents, eq(incidents.id, incidentEvents.incidentId))
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .where(
      and(
        gte(incidentEvents.at, since),
        inArray(incidentEvents.type, [
          'opened',
          'acked',
          'resolved',
          'reopened',
          'priority_changed',
        ]),
        eq(incidents.seeded, false),
      ),
    )
    .orderBy(sql`${incidentEvents.at} desc`)
    .limit(limit);
  const pages = await db
    .select({
      at: sql<Date>`coalesce(${notifications.sentAt}, ${notifications.createdAt})`,
      purpose: notifications.purpose,
      incidentId: notifications.incidentId,
      who: people.name,
      primarySiteId: incidents.primarySiteId,
      affectedSiteIds: incidents.affectedSiteIds,
    })
    .from(notifications)
    .leftJoin(people, eq(people.id, notifications.personId))
    .leftJoin(incidents, eq(incidents.id, notifications.incidentId))
    .where(
      and(
        gte(notifications.createdAt, since),
        eq(notifications.status, 'sent'),
        inArray(notifications.kind, ['sms', 'pushover']),
        inArray(notifications.purpose, ['incident_open', 'incident_update', 'escalation']),
        eq(notifications.shadow, false),
      ),
    )
    .orderBy(sql`1 desc`)
    .limit(limit);
  const siteIds = (r: { primarySiteId: number | null; affectedSiteIds: number[] | null }) => [
    ...new Set([
      ...(r.primarySiteId !== null ? [r.primarySiteId] : []),
      ...(r.affectedSiteIds ?? []),
    ]),
  ];
  const out: NocActivityRow[] = [];
  for (const e of evs) {
    const kind = activityKindOf(e.type);
    if (!kind) continue;
    out.push({
      at: e.at,
      kind,
      incidentId: e.incidentId,
      priority: e.priority,
      title: kind === 'acked' ? null : e.title,
      site: e.site,
      // "acked" events name the person in the actor ("entra:jane@…" or a display name).
      who: kind === 'acked' ? displayActor(e.actor) : null,
      siteIds: siteIds(e),
    });
  }
  for (const p of pages)
    out.push({
      at: new Date(p.at),
      kind: p.purpose === 'escalation' ? 'escalated' : 'paged',
      incidentId: p.incidentId,
      priority: null,
      title: null,
      site: null,
      who: p.who,
      siteIds: siteIds(p),
    });
  return out;
}

function displayActor(actor: string): string | null {
  if (!actor || actor === 'system') return null;
  const m = /^(?:entra|local):(.+)$/.exec(actor);
  const v = (m?.[1] ?? actor).trim();
  // An e-mail address is shown by its name part only.
  return v.includes('@') ? v.split('@')[0]! : v;
}

/** Incidents opened, acknowledged or resolved since `since` (key figures). */
export async function nocKpiIncidents(
  db: DbOrTx,
  since: Date,
): Promise<Array<KpiIncident & { primarySiteId: number | null; affectedSiteIds: number[] }>> {
  return db
    .select({
      openedAt: incidents.openedAt,
      acknowledgedAt: incidents.acknowledgedAt,
      resolvedAt: incidents.resolvedAt,
      seeded: incidents.seeded,
      primarySiteId: incidents.primarySiteId,
      affectedSiteIds: incidents.affectedSiteIds,
    })
    .from(incidents)
    .where(
      or(
        gte(incidents.openedAt, since),
        gte(incidents.acknowledgedAt, since),
        gte(incidents.resolvedAt, since),
      ),
    );
}

export interface NocFirewall {
  nodeId: number;
  siteId: number;
  caption: string;
  statusNorm: string;
  responseTimeMs: number | null;
  percentLoss: number | null;
}

/** Firewalls (WAN edges) placed at a site, and their interfaces. */
export async function nocWanSources(db: DbOrTx): Promise<{
  firewalls: NocFirewall[];
  interfaces: WanInterfaceIn[];
}> {
  const firewalls = await db
    .select({
      nodeId: orionNodes.nodeId,
      siteId: sql<number>`${orionNodes.siteId}`,
      caption: orionNodes.caption,
      statusNorm: orionNodes.statusNorm,
      responseTimeMs: orionNodes.responseTimeMs,
      percentLoss: orionNodes.percentLoss,
    })
    .from(orionNodes)
    .where(
      and(
        eq(orionNodes.deviceRole, 'firewall'),
        isNull(orionNodes.removedAt),
        sql`${orionNodes.siteId} IS NOT NULL`,
        eq(orionNodes.unmanaged, false),
      ),
    );
  const ids = firewalls.map((f) => f.nodeId);
  const interfaces = ids.length
    ? await db
        .select({
          interfaceId: orionInterfaces.interfaceId,
          nodeId: orionInterfaces.nodeId,
          name: orionInterfaces.name,
          caption: orionInterfaces.caption,
          alias: orionInterfaces.alias,
          statusNorm: orionInterfaces.statusNorm,
          inPercentUtil: orionInterfaces.inPercentUtil,
          outPercentUtil: orionInterfaces.outPercentUtil,
          inBps: orionInterfaces.inBps,
          outBps: orionInterfaces.outBps,
        })
        .from(orionInterfaces)
        .where(
          and(
            inArray(orionInterfaces.nodeId, ids),
            isNull(orionInterfaces.removedAt),
            eq(orionInterfaces.unmanaged, false),
          ),
        )
    : [];
  return { firewalls, interfaces };
}

/** Hourly averages of latency and loss per node since `since`. */
export async function nodeHourly(
  db: DbOrTx,
  nodeIds: readonly number[],
  since: Date,
): Promise<Array<{ nodeId: number; hour: Date; rt: number | null; loss: number | null }>> {
  if (!nodeIds.length) return [];
  const hour = sql<Date>`date_trunc('hour', ${nodeMetrics5m.bucket})`;
  const rows = await db
    .select({
      nodeId: nodeMetrics5m.nodeId,
      hour,
      rt: sql<number | null>`avg(${nodeMetrics5m.rtAvg})::float8`,
      loss: sql<number | null>`avg(${nodeMetrics5m.lossAvg})::float8`,
    })
    .from(nodeMetrics5m)
    .where(and(inArray(nodeMetrics5m.nodeId, [...nodeIds]), gte(nodeMetrics5m.bucket, since)))
    .groupBy(nodeMetrics5m.nodeId, sql`2`);
  return rows.map((r) => ({ ...r, hour: new Date(r.hour) }));
}

/** Hourly peak utilization (the higher of in and out) per interface since `since`. */
export async function interfaceHourly(
  db: DbOrTx,
  interfaceIds: readonly number[],
  since: Date,
): Promise<Array<{ interfaceId: number; hour: Date; util: number | null }>> {
  if (!interfaceIds.length) return [];
  const hour = sql<Date>`date_trunc('hour', ${interfaceMetrics5m.bucket})`;
  const rows = await db
    .select({
      interfaceId: interfaceMetrics5m.interfaceId,
      hour,
      util: sql<
        number | null
      >`max(greatest(coalesce(${interfaceMetrics5m.inUtilAvg}, 0), coalesce(${interfaceMetrics5m.outUtilAvg}, 0)))::float8`,
    })
    .from(interfaceMetrics5m)
    .where(
      and(
        inArray(interfaceMetrics5m.interfaceId, [...interfaceIds]),
        gte(interfaceMetrics5m.bucket, since),
      ),
    )
    .groupBy(interfaceMetrics5m.interfaceId, sql`2`);
  return rows.map((r) => ({ ...r, hour: new Date(r.hour) }));
}

export interface NocNotifySummary {
  /** SMS and Pushover pages sent to people. */
  pages: number;
  escalations: number;
  /** Messages held back, by reason (maintenance, quiet hours, snoozed, …). */
  suppressed: Record<string, number>;
}

export async function nocNotifySummary(db: DbOrTx, since: Date): Promise<NocNotifySummary> {
  const [pages] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        gte(notifications.createdAt, since),
        eq(notifications.status, 'sent'),
        inArray(notifications.kind, ['sms', 'pushover']),
        eq(notifications.shadow, false),
      ),
    );
  const [esc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(escalations)
    .where(gte(escalations.firedAt, since));
  const held = await db
    .select({
      reason: sql<string>`coalesce(${notifications.suppressReason}, 'other')`,
      n: sql<number>`count(*)::int`,
    })
    .from(notifications)
    .where(and(gte(notifications.createdAt, since), eq(notifications.status, 'suppressed')))
    .groupBy(sql`1`);
  return {
    pages: pages?.n ?? 0,
    escalations: esc?.n ?? 0,
    suppressed: Object.fromEntries(held.map((h) => [h.reason, h.n])),
  };
}

/**
 * Orion alert raises per hour since `since` (UTC hours), optionally only for devices at the given
 * sites. Initial-sync rows are not raises.
 */
export async function nocAlertHourly(
  db: DbOrTx,
  since: Date,
  siteIds: readonly number[] | null,
): Promise<Array<{ hour: Date; n: number }>> {
  const hour = sql<Date>`date_trunc('hour', ${entityTransitions.observedAt})`;
  const where = [
    eq(entityTransitions.kind, 'alert'),
    inArray(entityTransitions.change, ['raised', 'retriggered']),
    gte(entityTransitions.observedAt, since),
    sql`coalesce((${entityTransitions.details}->>'initialSync')::boolean, false) = false`,
  ];
  if (siteIds) {
    if (!siteIds.length) return [];
    where.push(
      sql`${entityTransitions.nodeId} IN (select ${orionNodes.nodeId} from ${orionNodes} where ${inArray(orionNodes.siteId, [...siteIds])})`,
    );
  }
  const rows = await db
    .select({ hour, n: sql<number>`count(*)::int` })
    .from(entityTransitions)
    .where(and(...where))
    .groupBy(sql`1`);
  return rows.map((r) => ({ hour: new Date(r.hour), n: r.n }));
}
