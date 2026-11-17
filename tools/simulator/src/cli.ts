/**
 * Replay synthetic alert storms through the real pipeline and check the outcome.
 *
 *   SIMULATOR_DATABASE_URL=postgres://mas:mas@localhost:5432/mas_sim pnpm simulate
 *   pnpm simulate wan-down-harvest flapping-ap
 *
 * The database's schemas are DROPPED for every scenario — use a throwaway database.
 */
import { runScenario } from './run';
import { SCENARIOS } from './scenarios';

const url = process.env.SIMULATOR_DATABASE_URL ?? process.env.DATABASE_URL_TEST;
if (!url) {
  console.error(
    'Set SIMULATOR_DATABASE_URL (or DATABASE_URL_TEST) to a THROWAWAY database: it is wiped for every scenario.',
  );
  process.exit(2);
}
const wanted = process.argv.slice(2);
const list = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;
if (wanted.length && list.length !== wanted.length) {
  console.error(`Unknown scenario. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

let failed = 0;
for (const sim of list) {
  const r = await runScenario(sim, url);
  const ok = r.failures.length === 0;
  if (!ok) failed++;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${sim.id} — ${sim.description}  (${r.ms} ms)`);
  for (const i of r.incidents) {
    console.log(
      `      #${i.id} ${i.seeded ? '(pre-existing) ' : ''}${i.priority} ${i.kind.padEnd(22)} ${i.status.padEnd(9)} ${String(i.alertCount).padStart(3)} alerts  ${i.title}`,
    );
  }
  console.log(
    `      noise: ${r.noise.rawAlerts} raw alert raises → ${r.noise.incidents} incident(s)${r.noise.ratio ? ` = ${r.noise.ratio}:1` : ''}`,
  );
  console.log(
    `      routing: Teams ${r.notify.channels.map((c) => `#${c}`).join(', ') || 'none'} · ${r.notify.pages} page(s)${r.notify.escalations ? ` · ${r.notify.escalations} escalation(s)` : ''}`,
  );
  console.log(
    `      AI: ${r.ai.summaries} summar${r.ai.summaries === 1 ? 'y' : 'ies'}, ${r.ai.priorityChecks} priority check(s), about US$${r.ai.costUsd.toFixed(3)} at list prices (fake model)`,
  );
  for (const f of r.failures) console.log(`      ✗ ${f}`);
}
console.log(`\n${list.length - failed}/${list.length} scenarios passed`);
process.exit(failed ? 1 : 0);
