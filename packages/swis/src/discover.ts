import { errorMessage, orionSeverity } from '@mercer/core';
import type { SwisClient } from './client';
import { buildPagedQuery, specFields } from './query-builder';
import {
  ALL_SPECS,
  ALERT_CONFIGS,
  CUSTOM_PROPERTY_PREFIX,
  DISCOVERY,
  NODES,
  probedEntities,
} from './queries';
import { SchemaProbe } from './probe';

export interface DiscoveryReport {
  baseUrl: string;
  generatedAt: string;
  serverTime?: { utcNow: unknown; localNow: unknown; sampleTriggeredDateTime?: unknown };
  entities: Array<{ entity: string; exists: boolean | 'unknown' }>;
  fields: Array<{
    query: string;
    entity: string;
    prop: string;
    required: boolean;
    present: boolean;
  }>;
  customProperties: Array<{
    field: string;
    dataType?: string;
    description?: string;
    distinctValues?: number;
    topValues?: Array<{ value: unknown; nodes: number }>;
  }>;
  vendors: Array<{ vendor: unknown; machineType: unknown; nodes: number }>;
  counts: Record<string, number | string>;
  alertConfigs: Array<{ alertId: number; name: string; severity: string; enabled: unknown }>;
  acknowledgeVerb: Array<{ verb: string; position: number; name: string; type: string }>;
  /** Orion.AlertActive.AppendNote, used to copy MAS incident notes onto alerts. */
  appendNoteVerb: Array<{ verb: string; position: number; name: string; type: string }>;
  /** Whether group properties (the description = site notes) can be written over SWIS. */
  groupsUpdatable: boolean | null;
  queryChecks: Array<{ query: string; ok: boolean; error?: string; sample?: unknown }>;
  errors: Array<{ step: string; error: string }>;
}

/** Read-only inventory of what our Orion instance exposes. Each step is isolated. */
export async function runDiscovery(
  client: SwisClient,
  baseUrl: string,
  opts: { checkQueries?: boolean; topValues?: number } = {},
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    baseUrl,
    generatedAt: new Date().toISOString(),
    entities: [],
    fields: [],
    customProperties: [],
    vendors: [],
    counts: {},
    alertConfigs: [],
    acknowledgeVerb: [],
    appendNoteVerb: [],
    groupsUpdatable: null,
    queryChecks: [],
    errors: [],
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      report.errors.push({ step: name, error: errorMessage(err) });
    }
  };
  const q = <T extends Record<string, unknown>>(sql: string, params = {}, label = 'discover') =>
    client.query<T>(sql, params, { label, retries: 0 });

  await step('serverTime', async () => {
    const [t] = await q<{ UtcNow: unknown; LocalNow: unknown }>(DISCOVERY.serverTime);
    const [a] = await q<{ TriggeredDateTime: unknown }>(DISCOVERY.sampleTimestamps).catch(() => []);
    report.serverTime = {
      utcNow: t?.UtcNow,
      localNow: t?.LocalNow,
      sampleTriggeredDateTime: a?.TriggeredDateTime,
    };
  });

  const entities = [...new Set([...probedEntities(), 'Orion.NodesCustomProperties'])];
  await step('entities', async () => {
    const rows = await q<{ FullName: string }>(
      DISCOVERY.entitiesExist(entities.length),
      Object.fromEntries(entities.map((e, i) => [`e${i}`, e])),
    );
    const found = new Set(rows.map((r) => r.FullName.toLowerCase()));
    report.entities = entities.map((entity) => ({
      entity,
      exists: found.has(entity.toLowerCase()),
    }));
  });

  const probe = new SchemaProbe(client);
  await step('schemaProbe', async () => {
    await probe.refresh();
    for (const spec of ALL_SPECS) {
      for (const f of specFields(spec)) {
        report.fields.push({
          query: spec.name,
          ...f,
          present: probe.loaded ? probe.has(f.entity, f.prop) : false,
        });
      }
    }
  });

  await step('customProperties', async () => {
    const details = await q<{ Field: string; DataType?: string; Description?: string }>(
      DISCOVERY.customPropertyDetails,
      { target: 'Orion.NodesCustomProperties' },
    ).catch(() => [] as Array<{ Field: string; DataType?: string; Description?: string }>);
    const byName = new Map(details.map((d) => [d.Field, d]));
    for (const field of probe.customPropertyFields) {
      const entry: DiscoveryReport['customProperties'][number] = {
        field,
        dataType: byName.get(field)?.DataType,
        description: byName.get(field)?.Description,
      };
      try {
        const values = await q<{ Value: unknown; Nodes: number }>(
          DISCOVERY.customPropertyValues(field),
        );
        values.sort((a, b) => Number(b.Nodes) - Number(a.Nodes));
        entry.distinctValues = values.length;
        entry.topValues = values
          .slice(0, opts.topValues ?? 50)
          .map((v) => ({ value: v.Value, nodes: Number(v.Nodes) }));
      } catch (err) {
        report.errors.push({ step: `customPropertyValues:${field}`, error: errorMessage(err) });
      }
      report.customProperties.push(entry);
    }
  });

  await step('vendors', async () => {
    const rows = await q<{ Vendor: unknown; MachineType: unknown; Nodes: number }>(
      DISCOVERY.vendors,
    );
    report.vendors = rows
      .map((r) => ({ vendor: r.Vendor, machineType: r.MachineType, nodes: Number(r.Nodes) }))
      .sort((a, b) => b.nodes - a.nodes);
  });

  for (const [name, sql] of Object.entries(DISCOVERY.counts)) {
    await step(`count:${name}`, async () => {
      const [r] = await q<{ N: number }>(sql);
      report.counts[name] = Number(r?.N ?? 0);
    });
  }

  await step('alertConfigs', async () => {
    const { build } = buildPagedQuery(ALERT_CONFIGS, probe);
    const rows = await client.queryAllPages<{
      AlertID: number;
      Name: string;
      Severity: number;
      Enabled?: unknown;
    }>(build, {}, 1000, { label: 'alertConfigs', retries: 0 });
    report.alertConfigs = rows.map((r) => ({
      alertId: r.AlertID,
      name: r.Name,
      severity: `${r.Severity} (${orionSeverity(r.Severity)})`,
      enabled: r.Enabled,
    }));
  });

  await step('acknowledgeVerb', async () => {
    const rows = await q<{ VerbName: string; Position: number; Name: string; Type: string }>(
      DISCOVERY.verbArguments,
      {
        entity: 'Orion.AlertActive',
      },
    );
    const pick = (verb: string) =>
      rows
        .filter((r) => r.VerbName === verb)
        .map((r) => ({ verb: r.VerbName, position: r.Position, name: r.Name, type: r.Type }));
    report.acknowledgeVerb = pick('Acknowledge');
    report.appendNoteVerb = pick('AppendNote');
  });

  await step('groupsUpdatable', async () => {
    const rows = await q<{ FullName: string; CanUpdate?: unknown }>(DISCOVERY.entityCanUpdate, {
      entity: 'Orion.Container',
    });
    const v = rows[0]?.CanUpdate;
    report.groupsUpdatable = v === undefined || v === null ? null : v === true || v === 'true';
  });

  if (opts.checkQueries) {
    for (const spec of ALL_SPECS) {
      await step(`check:${spec.name}`, async () => {
        try {
          const extra =
            spec === NODES
              ? probe.customPropertyFields.map((f) => `cp.${f} AS ${CUSTOM_PROPERTY_PREFIX}${f}`)
              : [];
          const sql = spec.where?.includes('@cursor')
            ? buildPagedQuery({ ...spec, where: spec.where }, probe).build(1, 1)
            : buildPagedQuery(spec, probe, extra).build(1, 1);
          const rows = await q(
            sql,
            spec.where?.includes('@cursor') ? { cursor: 0 } : {},
            spec.name,
          );
          report.queryChecks.push({ query: spec.name, ok: true, sample: rows[0] });
        } catch (err) {
          report.queryChecks.push({ query: spec.name, ok: false, error: errorMessage(err) });
        }
      });
    }
  }
  return report;
}
