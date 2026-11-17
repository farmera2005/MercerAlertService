/**
 * Notification configuration edited in Settings: Teams channels, routing rules, people and the
 * on-call schedule. Every change is audited in the same transaction; webhook URLs are sealed and
 * never returned or audited.
 */
import { and, asc, eq, gt, gte, lte, sql } from 'drizzle-orm';
import { DEFAULT_ROUTING_RULES, type RouteMatch, type SecretBox } from '@mercer/core';
import {
  notificationChannels,
  oncallOverrides,
  oncallWeeks,
  people,
  routingRules,
} from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit } from './audit';
import type { Actor } from './settings';

export type ChannelRow = Omit<typeof notificationChannels.$inferSelect, 'webhookUrlEnc'> & {
  configured: boolean;
};
export type RoutingRuleRow = typeof routingRules.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type OncallWeekRow = typeof oncallWeeks.$inferSelect;
export type OncallOverrideRow = typeof oncallOverrides.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Teams channels
// ---------------------------------------------------------------------------------------------

export const CHANNEL_KEY_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export async function listChannels(db: DbOrTx): Promise<ChannelRow[]> {
  const rows = await db.select().from(notificationChannels).orderBy(asc(notificationChannels.key));
  return rows.map(({ webhookUrlEnc, ...r }) => ({ ...r, configured: !!webhookUrlEnc }));
}

/** Channels with their decrypted webhook URLs, for the worker only. */
export async function loadChannelSecrets(
  db: DbOrTx,
  box: SecretBox,
): Promise<Map<string, { name: string; enabled: boolean; url: string | null; error?: string }>> {
  const out = new Map<
    string,
    { name: string; enabled: boolean; url: string | null; error?: string }
  >();
  for (const r of await db.select().from(notificationChannels)) {
    let url: string | null = null;
    let error: string | undefined;
    if (r.webhookUrlEnc) {
      try {
        url = box.open(r.webhookUrlEnc);
      } catch {
        error = 'cannot decrypt the webhook URL (master key changed?); enter it again';
      }
    }
    out.set(r.key, { name: r.name, enabled: r.enabled, url, error });
  }
  return out;
}

export interface ChannelInput {
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** undefined keeps the saved URL, null removes it. */
  webhookUrl?: string | null;
}

export async function saveChannel(
  db: Db,
  box: SecretBox,
  input: ChannelInput,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.key, input.key));
    const url =
      input.webhookUrl === undefined
        ? {}
        : { webhookUrlEnc: input.webhookUrl === null ? null : box.seal(input.webhookUrl) };
    const values = {
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      ...url,
      updatedAt: new Date(),
    };
    await tx
      .insert(notificationChannels)
      .values({ key: input.key, ...values })
      .onConflictDoUpdate({ target: notificationChannels.key, set: values });
    const urlChange =
      input.webhookUrl === undefined ? undefined : input.webhookUrl === null ? 'removed' : 'set';
    await writeAudit(tx, {
      ...actor,
      action: before ? 'notify.channel.update' : 'notify.channel.create',
      targetType: 'notification_channel',
      targetId: input.key,
      before: before
        ? {
            name: before.name,
            enabled: before.enabled,
            webhookUrl: before.webhookUrlEnc ? '[set]' : null,
          }
        : undefined,
      after: {
        name: input.name,
        enabled: input.enabled,
        ...(urlChange ? { webhookUrl: `[${urlChange}]` } : {}),
      },
    });
  });
}

export async function deleteChannel(db: Db, key: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const del = await tx
      .delete(notificationChannels)
      .where(eq(notificationChannels.key, key))
      .returning({ key: notificationChannels.key });
    if (del.length)
      await writeAudit(tx, {
        ...actor,
        action: 'notify.channel.delete',
        targetType: 'notification_channel',
        targetId: key,
      });
  });
}

// ---------------------------------------------------------------------------------------------
// Routing rules
// ---------------------------------------------------------------------------------------------

export async function listRoutingRules(db: DbOrTx): Promise<RoutingRuleRow[]> {
  return db.select().from(routingRules).orderBy(asc(routingRules.position), asc(routingRules.id));
}

export interface RoutingRuleInput {
  name: string;
  enabled: boolean;
  match: RouteMatch;
  channelKey: string | null;
  pageOncall: boolean;
  escalateAfterMin: number | null;
  stop: boolean;
}

const ruleAudit = (r: RoutingRuleInput | RoutingRuleRow) => ({
  name: r.name,
  enabled: r.enabled,
  match: r.match,
  channelKey: r.channelKey,
  pageOncall: r.pageOncall,
  escalateAfterMin: r.escalateAfterMin,
  stop: r.stop,
});

export async function saveRoutingRule(
  db: Db,
  id: number | null,
  input: RoutingRuleInput,
  actor: Actor,
): Promise<number> {
  return db.transaction(async (tx) => {
    if (id) {
      const [before] = await tx.select().from(routingRules).where(eq(routingRules.id, id));
      if (!before) throw new Error('rule not found');
      await tx
        .update(routingRules)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(routingRules.id, id));
      await writeAudit(tx, {
        ...actor,
        action: 'notify.rule.update',
        targetType: 'routing_rule',
        targetId: id,
        before: ruleAudit(before),
        after: ruleAudit(input),
      });
      return id;
    }
    const [last] = await tx
      .select({ max: sql<number>`coalesce(max(${routingRules.position}), 0)::int` })
      .from(routingRules);
    const [row] = await tx
      .insert(routingRules)
      .values({ ...input, position: (last?.max ?? 0) + 10 })
      .returning({ id: routingRules.id });
    await writeAudit(tx, {
      ...actor,
      action: 'notify.rule.create',
      targetType: 'routing_rule',
      targetId: row!.id,
      after: ruleAudit(input),
    });
    return row!.id;
  });
}

export async function deleteRoutingRule(db: Db, id: number, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(routingRules).where(eq(routingRules.id, id)).returning();
    if (row)
      await writeAudit(tx, {
        ...actor,
        action: 'notify.rule.delete',
        targetType: 'routing_rule',
        targetId: id,
        before: ruleAudit(row),
      });
  });
}

/** Swap a rule with its neighbour (rules run top to bottom). */
export async function moveRoutingRule(
  db: Db,
  id: number,
  direction: 'up' | 'down',
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rules = await listRoutingRules(tx);
    const i = rules.findIndex((r) => r.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rules.length) return;
    const a = rules[i]!;
    const b = rules[j]!;
    // Renumber so positions stay distinct even if they were equal.
    const order = rules.map((r) => r.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    for (const [n, rid] of order.entries())
      await tx
        .update(routingRules)
        .set({ position: (n + 1) * 10 })
        .where(eq(routingRules.id, rid));
    await writeAudit(tx, {
      ...actor,
      action: 'notify.rule.move',
      targetType: 'routing_rule',
      targetId: id,
      after: { direction, swappedWith: b.id, name: a.name },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// People and on-call
// ---------------------------------------------------------------------------------------------

export async function listPeople(db: DbOrTx): Promise<PersonRow[]> {
  return db
    .select()
    .from(people)
    .orderBy(
      sql`${people.rotationPosition} IS NULL`,
      asc(people.rotationPosition),
      asc(people.name),
    );
}

export type PersonInput = Pick<
  typeof people.$inferInsert,
  | 'name'
  | 'email'
  | 'phoneE164'
  | 'pushoverUserKey'
  | 'pageVia'
  | 'isItLead'
  | 'active'
  | 'rotationPosition'
>;

/** Contact details are personal data: the audit row says what changed, not the numbers. */
const personAudit = (p: PersonInput | PersonRow) => ({
  name: p.name,
  pageVia: p.pageVia,
  isItLead: p.isItLead,
  active: p.active,
  rotationPosition: p.rotationPosition,
  phone: p.phoneE164 ? '[set]' : null,
  pushover: p.pushoverUserKey ? '[set]' : null,
});

export async function savePerson(
  db: Db,
  id: number | null,
  input: PersonInput,
  actor: Actor,
): Promise<number> {
  return db.transaction(async (tx) => {
    if (id) {
      const [before] = await tx.select().from(people).where(eq(people.id, id));
      if (!before) throw new Error('person not found');
      await tx
        .update(people)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(people.id, id));
      await writeAudit(tx, {
        ...actor,
        action: 'notify.person.update',
        targetType: 'person',
        targetId: id,
        before: personAudit(before),
        after: personAudit(input),
      });
      return id;
    }
    const [row] = await tx.insert(people).values(input).returning({ id: people.id });
    await writeAudit(tx, {
      ...actor,
      action: 'notify.person.create',
      targetType: 'person',
      targetId: row!.id,
      after: personAudit(input),
    });
    return row!.id;
  });
}

export async function deletePerson(db: Db, id: number, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(people).where(eq(people.id, id)).returning();
    if (row)
      await writeAudit(tx, {
        ...actor,
        action: 'notify.person.delete',
        targetType: 'person',
        targetId: id,
        before: personAudit(row),
      });
  });
}

export async function listOncallWeeks(db: DbOrTx, fromWeek: string): Promise<OncallWeekRow[]> {
  return db
    .select()
    .from(oncallWeeks)
    .where(gte(oncallWeeks.weekStart, fromWeek))
    .orderBy(asc(oncallWeeks.weekStart));
}

/** Assign a week explicitly, or (primary null) go back to the rotation for that week. */
export async function setOncallWeek(
  db: Db,
  weekStart: string,
  primaryPersonId: number | null,
  secondaryPersonId: number | null,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (primaryPersonId === null) {
      await tx.delete(oncallWeeks).where(eq(oncallWeeks.weekStart, weekStart));
    } else {
      await tx
        .insert(oncallWeeks)
        .values({ weekStart, primaryPersonId, secondaryPersonId })
        .onConflictDoUpdate({
          target: oncallWeeks.weekStart,
          set: { primaryPersonId, secondaryPersonId },
        });
    }
    await writeAudit(tx, {
      ...actor,
      action: 'notify.oncall.week',
      targetType: 'oncall_week',
      targetId: weekStart,
      after: { primaryPersonId, secondaryPersonId },
    });
  });
}

export async function listOverrides(db: DbOrTx, now = new Date()): Promise<OncallOverrideRow[]> {
  return db
    .select()
    .from(oncallOverrides)
    .where(gt(oncallOverrides.endsAt, now))
    .orderBy(asc(oncallOverrides.startsAt));
}

export async function createOverride(
  db: Db,
  input: { personId: number; startsAt: Date; endsAt: Date; reason: string | null },
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(oncallOverrides)
      .values({ ...input, createdBy: actor.actorLabel })
      .returning({ id: oncallOverrides.id });
    await writeAudit(tx, {
      ...actor,
      action: 'notify.oncall.override',
      targetType: 'oncall_override',
      targetId: row!.id,
      after: {
        ...input,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
      },
    });
  });
}

export async function deleteOverride(db: Db, id: number, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(oncallOverrides).where(eq(oncallOverrides.id, id)).returning();
    if (row)
      await writeAudit(tx, {
        ...actor,
        action: 'notify.oncall.override_delete',
        targetType: 'oncall_override',
        targetId: id,
      });
  });
}

/** Overrides active at some point in [from, to]. */
export async function overridesBetween(db: DbOrTx, from: Date, to: Date) {
  return db
    .select()
    .from(oncallOverrides)
    .where(and(lte(oncallOverrides.startsAt, to), gt(oncallOverrides.endsAt, from)));
}

// ---------------------------------------------------------------------------------------------
// Defaults for a fresh install (open questions C1, C3, C6)
// ---------------------------------------------------------------------------------------------

export const DEFAULT_CHANNELS = [
  {
    key: 'net-critical',
    name: 'IT Network Alerts › net-critical',
    description: 'P1 and P2 incidents',
  },
  { key: 'net-alerts', name: 'IT Network Alerts › net-alerts', description: 'P3 and P4 incidents' },
  {
    key: 'net-digest',
    name: 'IT Network Alerts › net-digest',
    description: 'Daily and weekly digests (Milestone 5)',
  },
  {
    key: 'mas-shadow',
    name: 'IT Network Alerts › mas-shadow',
    description: 'Shadow mode: everything goes here',
  },
];

export const PLACEHOLDER_PEOPLE: PersonInput[] = [
  {
    name: 'On-call A (placeholder)',
    pageVia: 'pushover',
    isItLead: false,
    active: true,
    rotationPosition: 1,
  },
  {
    name: 'On-call B (placeholder)',
    pageVia: 'pushover',
    isItLead: false,
    active: true,
    rotationPosition: 2,
  },
  {
    name: 'On-call C (placeholder)',
    pageVia: 'pushover',
    isItLead: false,
    active: true,
    rotationPosition: 3,
  },
  {
    name: 'IT lead (placeholder)',
    pageVia: 'both',
    isItLead: true,
    active: true,
    rotationPosition: null,
  },
];

/** Seed channels, rules and placeholder people only into empty tables. */
export async function seedNotifyDefaults(tx: DbOrTx): Promise<void> {
  const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(notificationChannels);
  if ((c?.n ?? 0) === 0) await tx.insert(notificationChannels).values(DEFAULT_CHANNELS);
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(routingRules);
  if ((r?.n ?? 0) === 0) await tx.insert(routingRules).values(DEFAULT_ROUTING_RULES);
  const [p] = await tx.select({ n: sql<number>`count(*)::int` }).from(people);
  if ((p?.n ?? 0) === 0) await tx.insert(people).values(PLACEHOLDER_PEOPLE);
}
