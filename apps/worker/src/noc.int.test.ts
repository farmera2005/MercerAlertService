/**
 * NOC boards: custom boards and wall links (Postgres), and the widget queries against a site
 * outage from mock SWIS. Requires DATABASE_URL_TEST (a throwaway database; the public schema is
 * dropped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { BUILTIN_BOARDS, generateMasterKey, initLogger, loadConfig } from '@mercer/core';
import {
  createDb,
  createKioskToken,
  deleteNocBoard,
  existingBoardRefs,
  nocActivity,
  nocAlertHourly,
  nocKpiIncidents,
  nocNotifySummary,
  nocWanSources,
  nodeHourly,
  saveNocBoard,
  seedReferenceData,
  setKioskBoards,
  type DbHandle,
} from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { startMockSwis, type MockSwis } from '@mercer/mock-swis';
import { createWorker, type Worker } from './worker';

const url = process.env.DATABASE_URL_TEST;
initLogger({ service: 'test', level: 'silent' });
const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  child() {
    return silent;
  },
} as never;
const admin = { actorType: 'user' as const, actorId: 'local:1', actorLabel: 'local:admin' };

describe.skipIf(!url)('NOC boards (integration)', () => {
  let mock: MockSwis;
  let worker: Worker;
  let h: DbHandle;
  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.pool.query(text, values)).rows as T[];

  beforeAll(async () => {
    const pgAdmin = new pg.Client({ connectionString: url });
    await pgAdmin.connect();
    await pgAdmin.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
    await pgAdmin.end();
    await runMigrations(url!);
    h = createDb({ url: url!, poolMax: 2 });
    await seedReferenceData(h.db);
    mock = await startMockSwis({ port: 0 });
    const env = {
      DATABASE_URL: url!,
      SWIS_BASE_URL: mock.url,
      SWIS_USERNAME: 'mas',
      SWIS_PASSWORD: 'mas',
      SWIS_MAX_RETRIES: '0',
      LOG_LEVEL: 'silent',
      MAS_MASTER_KEY: generateMasterKey(),
    };
    worker = createWorker(loadConfig(env), { scheduling: false, log: silent, env });
    await worker.start();
    for (const p of ['topology', 'groups', 'nodes', 'interfaces', 'alerts', 'events'] as const)
      await worker.pollOnce(p);
    await worker.correlateOnce({ reconcile: true });
    mock.applyScenario('site-wan-down', { site: 'ROCK', childAlerts: 30 });
    await worker.pollOnce('nodes');
    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
  });

  afterAll(async () => {
    await worker?.stop();
    await mock?.close();
    await h?.close();
  });

  it('saves custom boards only with a valid layout and a unique name', async () => {
    const def = { widgets: BUILTIN_BOARDS.mission.widgets, filters: { divisions: ['grain'] } };
    const ok = await saveNocBoard(h.db, { name: 'Grain', definition: def }, admin);
    expect(ok.ok).toBe(true);
    expect(await saveNocBoard(h.db, { name: 'Grain', definition: def }, admin)).toEqual({
      ok: false,
      error: 'A board with that name already exists.',
    });
    const overlap = await saveNocBoard(
      h.db,
      {
        name: 'Broken',
        definition: {
          widgets: [
            { type: 'map', col: 1, row: 1, w: 6, h: 4 },
            { type: 'incidents', col: 3, row: 2, w: 4, h: 4 },
          ],
        },
      },
      admin,
    );
    expect(overlap).toMatchObject({ ok: false, error: expect.stringMatching(/overlaps/) });
    expect(await saveNocBoard(h.db, { name: 'X', definition: { widgets: [] } }, admin)).toEqual({
      ok: false,
      error: 'The board is not valid.',
    });
  });

  it('puts boards on a wall link, and takes a deleted board off it', async () => {
    const [board] = await q<{ id: number }>(`select id from noc_boards where name = 'Grain'`);
    const id = board!.id;
    const { row } = await createKioskToken(
      h.db,
      { name: 'NOC TV', allowedCidrs: [], expiresAt: null },
      admin,
    );
    expect(
      await setKioskBoards(
        h.db,
        row.id,
        { boards: ['mission', `custom:${id}`, 'custom:999', 'nonsense'], rotateSec: 30 },
        admin,
      ),
    ).toBe(true);
    const [k] = await q<{ boards: string[]; board_rotate_sec: number }>(
      'select boards, board_rotate_sec from kiosk_tokens where id = $1',
      [row.id],
    );
    expect(k).toEqual({ boards: ['mission', `custom:${id}`, 'custom:999'], board_rotate_sec: 30 });
    // A board that doesn't exist is skipped when the wall is shown.
    expect(await existingBoardRefs(h.db, k!.boards)).toEqual(['mission', `custom:${id}`]);

    expect(await deleteNocBoard(h.db, id, admin)).toBe(true);
    const [after] = await q<{ boards: string[] }>('select boards from kiosk_tokens where id = $1', [
      row.id,
    ]);
    expect(after!.boards).toEqual(['mission', 'custom:999']);
    const audit = await q<{ action: string }>(
      `select action from audit_log where action like 'noc_board.%' or action = 'kiosk.boards' order by id`,
    );
    expect(audit.map((a) => a.action)).toEqual([
      'noc_board.create',
      'kiosk.boards',
      'noc_board.delete',
    ]);
  });

  it('feeds the widgets from the outage', async () => {
    const since = new Date(Date.now() - 86_400_000);
    const activity = await nocActivity(h.db, since);
    expect(activity.some((a) => a.kind === 'opened' && /Rockford/.test(a.title ?? ''))).toBe(true);
    expect(activity.find((a) => a.kind === 'opened')!.siteIds.length).toBeGreaterThan(0);

    const kpi = await nocKpiIncidents(h.db, since);
    expect(kpi.filter((i) => !i.seeded).length).toBeGreaterThan(0);

    const alerts = await nocAlertHourly(h.db, since, null);
    expect(alerts.reduce((a, r) => a + r.n, 0)).toBeGreaterThanOrEqual(30);
    const [rock] = await q<{ id: number }>(`select id from sites where name = 'Rockford Elevator'`);
    const atRock = await nocAlertHourly(h.db, since, [rock!.id]);
    expect(atRock.reduce((a, r) => a + r.n, 0)).toBeGreaterThan(0);
    expect(await nocAlertHourly(h.db, since, [])).toEqual([]);

    const wan = await nocWanSources(h.db);
    const rockFw = wan.firewalls.find((f) => f.siteId === rock!.id);
    expect(rockFw).toMatchObject({ statusNorm: 'down' });
    expect(wan.interfaces.some((i) => i.nodeId === rockFw!.nodeId)).toBe(true);
    expect(Array.isArray(await nodeHourly(h.db, [rockFw!.nodeId], since))).toBe(true);

    expect(await nocNotifySummary(h.db, since)).toMatchObject({ pages: 0, escalations: 0 });
  });
});
