/**
 * Acceptance: every storm scenario produces the expected incidents end to end
 * (mock SWIS → pollers → Postgres → correlation). Requires DATABASE_URL_TEST (wiped per scenario).
 */
import { describe, expect, it } from 'vitest';
import { runScenario } from './run';
import { SCENARIOS } from './scenarios';

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)('scenario simulator', () => {
  for (const sim of SCENARIOS) {
    it(`${sim.id}: ${sim.description}`, async () => {
      const r = await runScenario(sim, url!);
      expect(
        r.failures,
        r.incidents.map((i) => `${i.priority} ${i.kind} ${i.title}`).join('\n'),
      ).toEqual([]);
    }, 120_000);
  }
});
