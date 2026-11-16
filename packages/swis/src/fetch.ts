import type { z } from 'zod';
import { createLogger, type Logger } from '@mercer/core';
import type { SwisClient, SwisRow } from './client';
import { SwisSchemaError } from './errors';
import { buildIncrementalQuery, buildPagedQuery, type QuerySpec } from './query-builder';
import {
  ACTIVE_ALERTS,
  ALERT_CONFIGS,
  ALERT_HISTORY,
  ALERT_HISTORY_MAX_ID,
  CUSTOM_PROPERTY_PREFIX,
  DEPENDENCIES,
  EVENTS,
  EVENTS_MAX_ID,
  GROUP_MEMBERS,
  GROUPS,
  INTERFACES,
  NODES,
  STATUS_INFO,
  TOPOLOGY_CONNECTIONS,
} from './queries';
import * as R from './rows';
import type { SchemaProbe } from './probe';

export interface FetcherOptions {
  pageSize: number;
  incrementalPageSize: number;
  eventsBackfill: number;
  naiveTimeZone: string;
  logger?: Logger;
}

export interface FetchResult<T> {
  rows: T[];
  /** Rows that failed schema validation and were skipped. */
  invalid: number;
  /** Optional fields dropped because this Orion version lacks them. */
  dropped: string[];
}

/**
 * High-level, typed SWIS reads. Each method returns the COMPLETE result set or throws — callers
 * rely on that to decide whether a snapshot may replace the mirror.
 */
export class SwisFetcher {
  private readonly log: Logger;
  private readonly warnedDropped = new Set<string>();

  constructor(
    private readonly client: SwisClient,
    private readonly probe: SchemaProbe,
    private readonly opts: FetcherOptions,
  ) {
    this.log = opts.logger ?? createLogger('swis-fetch');
  }

  activeAlerts() {
    return this.snapshot(ACTIVE_ALERTS, R.activeAlertRow, (r) => R.mapActiveAlert(r, this.ctx));
  }

  nodes() {
    const extra = this.probe.customPropertyFields.map(
      (f) => `cp.${f} AS ${CUSTOM_PROPERTY_PREFIX}${f}`,
    );
    return this.snapshot(NODES, R.nodeRow, (r) => R.mapNode(r, this.ctx), extra);
  }

  interfaces() {
    return this.snapshot(INTERFACES, R.interfaceRow, R.mapInterface);
  }

  topologyConnections() {
    return this.snapshot(TOPOLOGY_CONNECTIONS, R.topologyRow, R.mapTopology);
  }

  dependencies() {
    return this.snapshot(DEPENDENCIES, R.dependencyRow, R.mapDependency);
  }

  groups() {
    return this.snapshot(GROUPS, R.groupRow, R.mapGroup);
  }

  groupMembers() {
    return this.snapshot(GROUP_MEMBERS, R.groupMemberRow, R.mapGroupMember);
  }

  alertConfigs() {
    return this.snapshot(ALERT_CONFIGS, R.alertConfigRow, R.mapAlertConfig);
  }

  statusInfo() {
    return this.snapshot(STATUS_INFO, R.statusInfoRow, R.mapStatusInfo);
  }

  /** Events after `cursor`. With no cursor, starts `eventsBackfill` IDs before the newest event. */
  async events(cursor: number | null) {
    const start = cursor ?? (await this.backfillStart(EVENTS_MAX_ID, 'eventsMaxId'));
    return this.incremental(EVENTS, 'EventID', start, R.eventRow, (r) => R.mapEvent(r, this.ctx));
  }

  async alertHistory(cursor: number | null) {
    const start = cursor ?? (await this.backfillStart(ALERT_HISTORY_MAX_ID, 'alertHistoryMaxId'));
    return this.incremental(ALERT_HISTORY, 'AlertHistoryID', start, R.alertHistoryRow, (r) =>
      R.mapAlertHistory(r, this.ctx),
    );
  }

  // -------------------------------------------------------------------------------------------

  private get ctx(): R.ParseContext {
    return { naiveTimeZone: this.opts.naiveTimeZone };
  }

  private async backfillStart(sql: string, label: string): Promise<number> {
    const rows = await this.client.query<{ MaxId: number | null }>(sql, {}, { label });
    const max = Number(rows[0]?.MaxId ?? 0) || 0;
    return Math.max(0, max - this.opts.eventsBackfill);
  }

  private async snapshot<S extends z.ZodType, T>(
    spec: QuerySpec,
    schema: S,
    map: (row: z.infer<S>) => T,
    extra: string[] = [],
  ): Promise<FetchResult<T>> {
    const { build, dropped } = buildPagedQuery(spec, this.probe, extra);
    this.noteDropped(spec.name, dropped);
    const raw = await this.client.queryAllPages(build, {}, this.opts.pageSize, {
      label: spec.name,
    });
    return { ...this.parse(spec.name, raw, schema, map), dropped };
  }

  private async incremental<S extends z.ZodType, T>(
    spec: QuerySpec,
    cursorField: string,
    start: number,
    schema: S,
    map: (row: z.infer<S>) => T,
  ): Promise<FetchResult<T> & { cursor: number }> {
    const { build, dropped } = buildIncrementalQuery(spec, this.probe);
    this.noteDropped(spec.name, dropped);
    const { rows, cursor } = await this.client.queryIncremental(
      build,
      cursorField,
      start,
      this.opts.incrementalPageSize,
      {
        label: spec.name,
      },
    );
    return { ...this.parse(spec.name, rows, schema, map), dropped, cursor };
  }

  private parse<S extends z.ZodType, T>(
    name: string,
    raw: SwisRow[],
    schema: S,
    map: (row: z.infer<S>) => T,
  ): { rows: T[]; invalid: number } {
    const rows: T[] = [];
    let invalid = 0;
    let firstIssue: string | undefined;
    for (const r of raw) {
      const parsed = schema.safeParse(r);
      if (parsed.success) rows.push(map(parsed.data));
      else {
        invalid++;
        firstIssue ??= parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
      }
    }
    if (invalid > 0) {
      if (rows.length === 0) {
        throw new SwisSchemaError(`${name}: all ${invalid} rows failed validation (${firstIssue})`);
      }
      this.log.warn(
        { query: name, invalid, total: raw.length, firstIssue },
        'skipped invalid SWIS rows',
      );
    }
    return { rows, invalid };
  }

  private noteDropped(name: string, dropped: string[]): void {
    const key = `${name}:${dropped.join(',')}`;
    if (dropped.length && !this.warnedDropped.has(key)) {
      this.warnedDropped.add(key);
      this.log.warn(
        { query: name, dropped },
        'optional SWIS fields not present in this Orion version',
      );
    }
  }
}
