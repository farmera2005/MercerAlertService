/**
 * List what our Orion instance exposes so field names can be confirmed before mapping.
 *
 *   pnpm swis:discover                    # human-readable report
 *   pnpm swis:discover --check-queries    # also run every production query with WITH ROWS 1 TO 1
 *   pnpm swis:discover --json out.json    # full report as JSON
 *
 * Uses SWIS_* settings from the environment / .env (read-only account).
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runDiscovery } from '@mercer/swis';
import { scriptClient } from './swis-client';

const { values } = parseArgs({
  options: {
    'check-queries': { type: 'boolean', default: false },
    json: { type: 'string' },
    top: { type: 'string', default: '25' },
  },
});

const { cfg, client } = scriptClient();
console.log(`\nSWIS discovery against ${cfg.swis.baseUrl} as ${cfg.swis.username}\n`);
const r = await runDiscovery(client, cfg.swis.baseUrl, {
  checkQueries: values['check-queries'],
  topValues: Number(values.top),
});
await client.close();

const h = (t: string) => console.log(`\n=== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`);

h('Server time');
console.log(r.serverTime ?? '(unavailable)');
console.log(
  '  If UtcNow and LocalNow differ and sample timestamps have no "Z", keep SWIS_NAIVE_TIMEZONE=UTC',
);
console.log(
  '  unless the values clearly match LocalNow (then set it to the Orion server time zone).',
);

h('Entities');
for (const e of r.entities) console.log(`  ${e.exists ? '✓' : '✗'} ${e.entity}`);

h('Fields used by MAS queries');
const missing = r.fields.filter((f) => !f.present);
if (!r.fields.length) console.log('  (schema probe failed — see errors)');
else if (!missing.length) console.log('  ✓ every field in the query catalog exists');
for (const f of missing)
  console.log(
    `  ${f.required ? '✗ REQUIRED' : '– optional'} ${f.entity}.${f.prop} (query ${f.query})`,
  );

h('Node custom properties');
const mapped = {
  Site: cfg.mapping.siteField,
  Division: cfg.mapping.divisionField,
  City: cfg.mapping.cityField,
  Role: cfg.mapping.roleField,
};
for (const [what, field] of Object.entries(mapped)) {
  if (!field) continue;
  const found = r.customProperties.find((c) => c.field === field);
  console.log(
    `  ${found ? '✓' : '✗'} ${what} → CP "${field}"${found ? '' : '  (not found — set CP_' + what.toUpperCase() + '_FIELD)'}`,
  );
}
for (const cp of r.customProperties) {
  console.log(
    `\n  ${cp.field} (${cp.dataType ?? '?'}) — ${cp.distinctValues ?? '?'} distinct values${cp.description ? ` — ${cp.description}` : ''}`,
  );
  for (const v of cp.topValues ?? [])
    console.log(
      `      ${String(v.nodes).padStart(5)}  ${v.value === null ? '(empty)' : JSON.stringify(v.value)}`,
    );
}

h('Vendors / machine types (for device-role rules)');
for (const v of r.vendors.slice(0, 60))
  console.log(`  ${String(v.nodes).padStart(5)}  ${v.vendor ?? '?'} — ${v.machineType ?? '?'}`);

h('Counts');
for (const [k, v] of Object.entries(r.counts)) console.log(`  ${k.padEnd(22)} ${v}`);
if (r.counts.dependencies === 0)
  console.log(
    '  ! No Orion dependencies: correlation will rely on topology and same-site grouping.',
  );
if (r.counts.topologyConnections === 0)
  console.log('  ! No topology connections: NPM topology (CDP/LLDP) may be disabled.');

h('Alert definitions');
for (const a of r.alertConfigs)
  console.log(
    `  #${String(a.alertId).padEnd(5)} ${a.enabled === false ? '(disabled) ' : ''}${a.name}  [${a.severity}]`,
  );

h('Orion.AlertActive.Acknowledge signature (write-back)');
for (const v of r.acknowledgeVerb) console.log(`  ${v.position}: ${v.name} ${v.type}`);

if (r.queryChecks.length) {
  h('Production query checks');
  for (const c of r.queryChecks)
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.query}${c.ok ? '' : ` — ${c.error}`}`);
}
if (r.errors.length) {
  h('Errors');
  for (const e of r.errors) console.log(`  ${e.step}: ${e.error}`);
}
if (values.json) {
  writeFileSync(values.json, JSON.stringify(r, null, 2));
  console.log(
    `\nFull report written to ${values.json} (contains hostnames/site names; do not commit).`,
  );
}
console.log('');
process.exit(r.fields.some((f) => f.required && !f.present) ? 2 : 0);
