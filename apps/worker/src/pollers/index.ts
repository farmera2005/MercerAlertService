import {
  getPollerState,
  insertAlertHistory,
  insertEvents,
  replaceStatusInfo,
  replaceTopology,
  upsertAlertConfigs,
  applyActiveAlertSnapshot,
  applyInterfaceSnapshot,
  applyNodeSnapshot,
  replaceGroupMirror,
  type PollerName,
  type TopologyBundle,
} from '@mercer/db';
import { errorMessage } from '@mercer/core';
import { SwisHttpError } from '@mercer/swis';
import type { PollFn } from './run-poll';

export const pollAlerts: PollFn = async (ctx, startedAt) => {
  const state = await getPollerState(ctx.db, 'alerts');
  try {
    const res = await ctx.swis.fetcher.activeAlerts();
    const r = await applyActiveAlertSnapshot(ctx.db, res.rows, startedAt, {
      initialSync: !state?.lastSuccessAt,
    });
    ctx.source.recordAlertPollSuccess(ctx.now());
    return {
      rows: res.rows.length,
      transitions: r.transitions,
      details: { ...r.changes, invalid: res.invalid },
    };
  } catch (err) {
    ctx.source.recordAlertPollFailure(err);
    throw err;
  } finally {
    await ctx.source
      .evaluate()
      .catch((e: unknown) => ctx.log.error({ err: errorMessage(e) }, 'source evaluation failed'));
  }
};

export const pollNodes: PollFn = async (ctx, startedAt) => {
  if (!ctx.swis.probe.loaded) await ctx.swis.probe.refresh();
  const res = await ctx.swis.fetcher.nodes();
  const resolved = await ctx.sites.resolveAll(res.rows);
  const r = await applyNodeSnapshot(ctx.db, resolved.rows, startedAt);
  return {
    rows: res.rows.length,
    transitions: r.transitions,
    details: {
      removed: r.removed,
      unmapped: resolved.unmapped,
      autoCreatedSites: resolved.autoCreated,
      invalid: res.invalid,
    },
  };
};

export const pollInterfaces: PollFn = async (ctx, startedAt) => {
  const res = await ctx.swis.fetcher.interfaces();
  const r = await applyInterfaceSnapshot(ctx.db, res.rows, startedAt);
  return {
    rows: res.rows.length,
    transitions: r.transitions,
    details: { removed: r.removed, invalid: res.invalid },
  };
};

export const pollEvents: PollFn = async (ctx) => {
  const state = await getPollerState(ctx.db, 'events');
  const cur = state?.cursor ?? {};
  const eventsCursor = typeof cur.eventId === 'number' ? cur.eventId : null;
  const historyCursor = typeof cur.alertHistoryId === 'number' ? cur.alertHistoryId : null;
  const events = await ctx.swis.fetcher.events(eventsCursor);
  const history = await ctx.swis.fetcher.alertHistory(historyCursor);
  const e = await insertEvents(ctx.db, events.rows);
  const h = await insertAlertHistory(ctx.db, history.rows);
  return {
    rows: e + h,
    transitions: 0,
    cursor: { eventId: events.cursor, alertHistoryId: history.cursor },
    details: { events: e, alertHistory: h },
  };
};

/**
 * Groups and members (every 5 minutes by default): the site groups that sites correspond to, and
 * their descriptions, which are the site notes. Links, creates and renames sites to match.
 */
export const pollGroups: PollFn = async (ctx, startedAt) => {
  const f = ctx.swis.fetcher;
  let groups;
  let members;
  try {
    groups = (await f.groups()).rows;
    members = (await f.groupMembers()).rows;
  } catch (err) {
    // An account that can't read groups: keep the previous mirror and the site links.
    if (err instanceof SwisHttpError && (err.status === 400 || err.status === 403)) {
      ctx.log.warn({ err: err.message }, 'groups unavailable; keeping previous data');
      return { rows: 0, transitions: 0, details: { unavailable: true } };
    }
    throw err;
  }
  const counts = await replaceGroupMirror(ctx.db, groups, members, startedAt);
  const sync = await ctx.sites.syncSiteGroups();
  return {
    rows: counts.groups + counts.members,
    transitions: counts.notesChanged + sync.linked + sync.renamed + sync.created,
    details: { ...counts, ...sync },
  };
};

/** Hourly: schema probe + custom-property list, topology, dependencies, alert definitions. */
export const pollTopology: PollFn = async (ctx, startedAt) => {
  await ctx.swis.probe.refresh();
  const f = ctx.swis.fetcher;
  // Optional parts: an entity we cannot read (403/400) leaves its table untouched.
  const optional = async <T>(
    name: string,
    fn: () => Promise<{ rows: T[] }>,
  ): Promise<T[] | undefined> => {
    try {
      return (await fn()).rows;
    } catch (err) {
      if (err instanceof SwisHttpError && (err.status === 400 || err.status === 403)) {
        ctx.log.warn(
          { part: name, err: err.message },
          'topology part unavailable; keeping previous data',
        );
        return undefined;
      }
      throw err;
    }
  };
  const bundle: TopologyBundle = {
    connections: await optional('topologyConnections', () => f.topologyConnections()),
    dependencies: await optional('dependencies', () => f.dependencies()),
  };
  const counts = await replaceTopology(ctx.db, bundle, startedAt);
  const configs = await f.alertConfigs();
  await upsertAlertConfigs(ctx.db, configs.rows, startedAt);
  const status = await optional('statusInfo', () => f.statusInfo());
  if (status) await replaceStatusInfo(ctx.db, status);
  ctx.sites.invalidate();
  const rows = Object.values(counts).reduce((a, b) => a + b, 0) + configs.rows.length;
  return {
    rows,
    transitions: 0,
    details: {
      ...counts,
      alertConfigs: configs.rows.length,
      customProperties: ctx.swis.probe.customPropertyFields.length,
    },
  };
};

export const POLLERS: Record<PollerName, PollFn> = {
  alerts: pollAlerts,
  nodes: pollNodes,
  interfaces: pollInterfaces,
  events: pollEvents,
  groups: pollGroups,
  topology: pollTopology,
};
