/**
 * Capture real SWQL responses as sanitized fixtures for mock-swis replay and tests.
 *
 *   pnpm swis:record                     # → fixtures/swis/recorded/<query>.json
 *   pnpm swis:record --rows 200 --hash-hostnames --out fixtures/swis/recorded
 *
 * IPs, MACs, serial numbers, e-mail addresses and account names are pseudonymised
 * deterministically (joins still line up). Review files before committing them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ALERT_HISTORY,
  ALERT_HISTORY_MAX_ID,
  ALL_SPECS,
  CUSTOM_PROPERTY_PREFIX,
  EVENTS,
  EVENTS_MAX_ID,
  FixtureSanitizer,
  NODE_CUSTOM_PROPERTIES,
  NODE_CUSTOM_PROPERTIES_TARGET,
  NODES,
  SchemaProbe,
  buildPagedQuery,
  probedEntities,
  schemaProbeQuery,
} from '@mercer/swis';
import { scriptClient } from './swis-client';

const { values } = parseArgs({
  options: {
    rows: { type: 'string', default: '500' },
    out: { type: 'string', default: 'fixtures/swis/recorded' },
    'hash-hostnames': { type: 'boolean', default: false },
  },
});
const rows = Number(values.rows);
const { client } = scriptClient();
const sanitizer = new FixtureSanitizer({ hashHostnames: values['hash-hostnames'] });
mkdirSync(values.out, { recursive: true });

const write = (name: string, entity: string, query: string, results: Record<string, unknown>[]) => {
  const file = join(values.out, `${name}.json`);
  const clean = results.map((r) => sanitizer.row(r));
  writeFileSync(
    file,
    JSON.stringify(
      { entity, query, recordedAt: new Date().toISOString(), results: clean },
      null,
      2,
    ),
  );
  console.log(`  ✓ ${name.padEnd(22)} ${String(clean.length).padStart(5)} rows → ${file}`);
};

const probe = new SchemaProbe(client);
await probe.refresh();

const entities = [...probedEntities(), NODE_CUSTOM_PROPERTIES_TARGET];
const probeSql = schemaProbeQuery(entities.length);
write(
  'schemaProbe',
  'Metadata.Property',
  probeSql,
  await client.query(probeSql, Object.fromEntries(entities.map((e, i) => [`e${i}`, e]))),
);
write(
  'customProperties',
  'Orion.CustomProperty',
  NODE_CUSTOM_PROPERTIES,
  await client.query(NODE_CUSTOM_PROPERTIES, { target: NODE_CUSTOM_PROPERTIES_TARGET }),
);

for (const spec of ALL_SPECS) {
  try {
    const extra =
      spec === NODES
        ? probe.customPropertyFields.map((f) => `cp.${f} AS ${CUSTOM_PROPERTY_PREFIX}${f}`)
        : [];
    const { build } = buildPagedQuery(spec, probe, extra);
    const sql = build(1, rows);
    // Incremental streams: record the newest `rows` entries rather than the oldest.
    const maxSql =
      spec === EVENTS ? EVENTS_MAX_ID : spec === ALERT_HISTORY ? ALERT_HISTORY_MAX_ID : null;
    const cursor = maxSql
      ? Math.max(0, Number((await client.query<{ MaxId: number }>(maxSql))[0]?.MaxId ?? 0) - rows)
      : null;
    const res = await client.query(sql, cursor === null ? {} : { cursor }, { label: spec.name });
    write(spec.name, Object.values(spec.entities)[0]!, sql, res);
  } catch (err) {
    console.log(`  ✗ ${spec.name}: ${(err as Error).message}`);
  }
}
await client.close();
console.log('\nReview the files, then run: pnpm dev:mock-swis -- --replay fixtures/swis/recorded');
