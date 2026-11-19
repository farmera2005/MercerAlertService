/**
 * Sites from SolarWinds groups, and site notes kept in the group description (mock SWIS → worker →
 * Postgres). Requires DATABASE_URL_TEST (a throwaway database; the public schema is dropped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { generateMasterKey, initLogger, loadConfig } from '@mercer/core';
import { createDb, requestSiteNotesWrite, seedReferenceData, type DbHandle } from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { startMockSwis, type MockSwis } from '@mercer/mock-swis';
import { createWorker, type Worker } from './worker';
import { runWritebackSiteNotes } from './writeback';

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

describe.skipIf(!url)('sites from SolarWinds groups (integration)', () => {
  let mock: MockSwis;
  let worker: Worker;
  let h: DbHandle;
  let env: Record<string, string>;
  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.pool.query(text, values)).rows as T[];
  const writebackCfg = () =>
    loadConfig({
      ...env,
      SWIS_WRITEBACK_ENABLED: 'true',
      SWIS_WRITE_USERNAME: 'mas',
      SWIS_WRITE_PASSWORD: 'mas',
    });

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
    env = {
      DATABASE_URL: url!,
      SWIS_BASE_URL: mock.url,
      SWIS_USERNAME: 'mas',
      SWIS_PASSWORD: 'mas',
      SWIS_MAX_RETRIES: '0',
      LOG_LEVEL: 'silent',
      MAS_MASTER_KEY: generateMasterKey(),
      // The mock names its site groups "Site - <name>".
      SITE_GROUP_PATTERN: '^Site - (.+)$',
    };
    worker = createWorker(loadConfig(env), { scheduling: false, log: silent, env });
    await worker.start();
    for (const p of ['topology', 'groups', 'nodes'] as const)
      expect(await worker.pollOnce(p), p).not.toBeNull();
  });

  afterAll(async () => {
    await worker?.stop();
    await mock?.close();
    await h?.close();
  });

  it('keeps one site per site group and places its devices by membership', async () => {
    const groups = mock.world.groups;
    const sites = await q<{ id: number; name: string; orion_container_id: number }>(
      'select id, name, orion_container_id from sites where orion_container_id is not null',
    );
    expect(sites).toHaveLength(groups.length);
    for (const g of groups) {
      const site = sites.find((s) => s.orion_container_id === Number(g.ContainerID));
      expect(site?.name).toBe(String(g.Name).replace(/^Site - /, ''));
    }
    // Members of a site group are placed by the group; the firewall (not a member in the mock)
    // still gets its site from the custom property.
    const g = groups[0]!;
    const site = sites.find((s) => s.orion_container_id === Number(g.ContainerID))!;
    const memberIds = mock.world.groupMembers
      .filter((m) => m.ContainerID === g.ContainerID)
      .map((m) => Number(m.MemberPrimaryID));
    const nodes = await q<{ node_id: number; site_id: number; site_source: string }>(
      'select node_id, site_id, site_source from orion_nodes where node_id = any($1)',
      [memberIds],
    );
    expect(nodes.length).toBe(memberIds.length);
    expect(nodes.every((n) => n.site_id === site.id && n.site_source === 'group')).toBe(true);
    const others = await q<{ n: number }>(
      `select count(*)::int as n from orion_nodes where site_id = $1 and site_source = 'custom_property'`,
      [site.id],
    );
    expect(others[0]!.n).toBeGreaterThan(0);
  });

  it('follows a renamed group and keeps the old name as an alias', async () => {
    const g = mock.world.groups[1]!;
    const [before] = await q<{ id: number; name: string }>(
      'select id, name from sites where orion_container_id = $1',
      [Number(g.ContainerID)],
    );
    g.Name = 'Site - Renamed Place';
    expect(await worker.pollOnce('groups')).not.toBeNull();
    const [site] = await q<{ name: string; aliases: string[] }>(
      'select name, aliases from sites where id = $1',
      [before!.id],
    );
    expect(site!.name).toBe('Renamed Place');
    expect(site!.aliases).toContain(before!.name);
    const audit = await q<{ after: { name: string } }>(
      `select after from audit_log where action = 'site.group_rename' and target_id = $1 order by id desc limit 1`,
      [String(before!.id)],
    );
    expect(audit[0]!.after.name).toBe('Renamed Place');
  });

  it('writes site notes to the group description, and refuses a stale edit', async () => {
    const g = mock.world.groups[2]!;
    const cid = Number(g.ContainerID);
    const [site] = await q<{ id: number }>('select id from sites where orion_container_id = $1', [
      cid,
    ]);
    const [mirror] = await q<{ description: string }>(
      'select description from orion_groups where container_id = $1',
      [cid],
    );
    expect(mirror!.description).toBe(g.Description);

    const text = 'Generator on site. Spectrum circuit 12345; LTE backup on the FortiGate.';
    const req = await requestSiteNotesWrite(
      h.db,
      { siteId: site!.id, text, base: mirror!.description },
      admin,
    );
    if (!req.ok) throw new Error(req.error);
    // A second edit while the first is pending is refused.
    expect(
      await requestSiteNotesWrite(h.db, { siteId: site!.id, text: 'x', base: null }, admin),
    ).toMatchObject({ ok: false });
    const r = await runWritebackSiteNotes({ writeId: req.writeId }, writebackCfg(), h.db, silent);
    expect(r.status).toBe('ok');
    expect(g.Description).toBe(text);
    const [after] = await q<{ description: string }>(
      'select description from orion_groups where container_id = $1',
      [cid],
    );
    expect(after!.description).toBe(text);
    const actions = await q<{ action: string }>(
      `select action from audit_log where action in ('site.notes.update', 'orion.writeback.site_notes') order by id`,
    );
    expect(actions.map((a) => a.action)).toEqual([
      'site.notes.update',
      'orion.writeback.site_notes',
    ]);

    // Someone edits the description in SolarWinds; a MAS edit based on the old text is refused.
    g.Description = 'Changed in SolarWinds';
    const stale = await requestSiteNotesWrite(
      h.db,
      { siteId: site!.id, text: 'My edit', base: text },
      admin,
    );
    if (!stale.ok) throw new Error(stale.error);
    const c = await runWritebackSiteNotes({ writeId: stale.writeId }, writebackCfg(), h.db, silent);
    expect(c.status).toBe('conflict');
    expect(g.Description).toBe('Changed in SolarWinds');
    const [write] = await q<{ status: string; error: string }>(
      'select status, error from site_notes_writes where id = $1',
      [stale.writeId],
    );
    expect(write).toMatchObject({ status: 'conflict' });
    const [mirrored] = await q<{ description: string }>(
      'select description from orion_groups where container_id = $1',
      [cid],
    );
    expect(mirrored!.description).toBe('Changed in SolarWinds');
  });

  it('records a skipped write when write-back is off', async () => {
    const [site] = await q<{ id: number }>(
      'select id from sites where orion_container_id is not null order by id limit 1',
    );
    const req = await requestSiteNotesWrite(
      h.db,
      { siteId: site!.id, text: 'x', base: null },
      admin,
    );
    if (!req.ok) throw new Error(req.error);
    const r = await runWritebackSiteNotes({ writeId: req.writeId }, loadConfig(env), h.db, silent);
    expect(r.status).toBe('skipped');
  });

  it('refuses notes for a site that is not linked to a group', async () => {
    const [site] = await q<{ id: number }>(
      `insert into sites (code, name) values ('unlinked-test', 'Unlinked Test') returning id`,
    );
    expect(
      await requestSiteNotesWrite(h.db, { siteId: site!.id, text: 'x', base: null }, admin),
    ).toMatchObject({ ok: false });
  });
});
