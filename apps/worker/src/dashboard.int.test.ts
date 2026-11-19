/**
 * Dashboard data and user actions against real pipeline output: mock SWIS → pollers →
 * correlation → the repositories the web app reads. Requires DATABASE_URL_TEST (wiped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildTimeline, generateMasterKey, initLogger, loadConfig, siteHealth } from '@mercer/core';
import {
  applyIncidentAction,
  createDb,
  createKioskToken,
  findKioskToken,
  getIncidentDetail,
  loadOverview,
  nodeMetricSeries,
  revokeKioskToken,
  rotateKioskToken,
  searchIncidents,
  seedReferenceData,
  touchKioskToken,
  updateKioskToken,
  updateSite,
  upsertEntraUser,
  CORRELATION_LOCK_KEY,
  type DbHandle,
} from '@mercer/db';
import { runMigrations } from '@mercer/db/migrate';
import { startMockSwis, type MockSwis } from '@mercer/mock-swis';
import { createWorker, type Worker } from './worker';
import { runWritebackAck, runWritebackNote } from './writeback';

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

const actor = {
  actorType: 'user' as const,
  actorId: 'local:1',
  actorLabel: 'local:e2e',
  display: 'Pat Doe',
  ip: '10.0.0.5',
  userAgent: 'vitest',
};

describe.skipIf(!url)('dashboard data and incident actions (integration)', () => {
  let mock: MockSwis;
  let worker: Worker;
  let h: DbHandle;
  let p1Id = 0;
  let env: Record<string, string | undefined> = {};
  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.pool.query(text, values)).rows as T[];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;',
    );
    await admin.end();
    await runMigrations(url!);
    h = createDb({ url: url!, poolMax: 4 });
    await seedReferenceData(h.db);
    mock = await startMockSwis({ port: 0 });
    env = {
      DATABASE_URL: url,
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

  it('colours Rockford red on the overview and keeps unaffected sites out of it', async () => {
    const o = await loadOverview(h.db);
    const rock = o.sites.find((s) => s.name === 'Rockford Elevator')!;
    const health = (siteId: number) =>
      siteHealth(
        o.nodes
          .filter((n) => n.siteId === siteId)
          .map((n) => ({
            statusNorm: n.statusNorm as never,
            role: n.role as never,
            unmanaged: n.unmanaged,
          })),
        o.openIncidents.filter(
          (i) => i.primarySiteId === siteId || i.affectedSiteIds.includes(siteId),
        ),
      );
    expect(health(rock.id)).toMatchObject({ level: 'bad', worstPriority: 'P1' });
    const quiet = o.sites.filter((s) => s.id !== rock.id && o.nodes.some((n) => n.siteId === s.id));
    expect(quiet.length).toBeGreaterThan(3);
    expect(quiet.every((s) => health(s.id).level !== 'bad')).toBe(true);
  });

  it('filters the incident list', async () => {
    const active = await searchIncidents(h.db, { status: 'active' });
    const p1 = active.rows.filter((r) => r.priority === 'P1');
    expect(p1).toHaveLength(1);
    p1Id = p1[0]!.id;
    expect(active.rows[0]!.id).toBe(p1Id); // P1 first
    const rockId = (
      await q<{ id: number }>(`select id from sites where name='Rockford Elevator'`)
    )[0]!.id;
    const bySite = await searchIncidents(h.db, { status: 'active', siteId: rockId });
    expect(bySite.rows.map((r) => r.id)).toContain(p1Id);
    expect((await searchIncidents(h.db, { status: 'all', q: `INC-${p1Id}` })).rows).toHaveLength(1);
    expect((await searchIncidents(h.db, { status: 'all', q: 'site down' })).rows[0]!.id).toBe(p1Id);
    expect((await searchIncidents(h.db, { status: 'resolved' })).rows).toHaveLength(0);
    const paged = await searchIncidents(h.db, { status: 'all', limit: 1 });
    expect(paged.nextBeforeId).not.toBeNull();
  });

  it('stores several divisions per site, and filters and names incidents by any of them', async () => {
    const [rock] = await q<{ id: number }>(`select id from sites where name='Rockford Elevator'`);
    const saved = await updateSite(
      h.db,
      rock!.id,
      { divisionCodes: ['agronomy', 'grain', 'nope'] },
      actor,
    );
    // Known codes only, in divisions order.
    expect(saved?.divisionCodes).toEqual(['grain', 'agronomy']);
    const o = await loadOverview(h.db);
    expect(o.sites.find((x) => x.id === rock!.id)!.divisionName).toBe('Grain, Agronomy');

    // An incident at the site carries its divisions (set by correlation; see engine tests).
    await h.pool.query(`update incidents set division_codes = '{grain,agronomy}' where id = $1`, [
      p1Id,
    ]);
    const agronomy = await searchIncidents(h.db, { status: 'active', division: 'agronomy' });
    expect(agronomy.rows.map((r) => r.id)).toEqual([p1Id]);
    expect(agronomy.rows[0]!.divisionName).toBe('Grain, Agronomy');
    const feed = await searchIncidents(h.db, { status: 'active', division: 'feed' });
    expect(feed.rows.map((r) => r.id)).not.toContain(p1Id);
    expect((await getIncidentDetail(h.db, p1Id))!.divisionName).toBe('Grain, Agronomy');

    await updateSite(h.db, rock!.id, { divisionCodes: ['grain'] }, actor);
    await h.pool.query(`update incidents set division_codes = '{grain}' where id = $1`, [p1Id]);
  });

  it('builds the incident detail with members, affected devices and a merged timeline', async () => {
    const d = (await getIncidentDetail(h.db, p1Id))!;
    expect(d.site?.name).toBe('Rockford Elevator');
    expect(d.members.length).toBeGreaterThanOrEqual(31);
    expect(d.members[0]!.role).toBe('root');
    expect(d.affectedNodes.some((n) => n.node.deviceRole === 'firewall')).toBe(true);
    const tl = buildTimeline(d.timelineInput);
    // Real time: the storm joins the wan2 incident seeded moments earlier, which becomes the P1.
    expect(tl.some((e) => e.source === 'mas' && e.text.includes('P1'))).toBe(true);
    expect(d.incident.seeded).toBe(false);
    expect(tl.some((e) => e.source === 'alert' && e.text.includes('raised'))).toBe(true);
    expect(tl.some((e) => e.source === 'status' && e.text.includes('→ down'))).toBe(true);
  });

  it('acknowledges with an audit row and an event, and correlation does not undo it', async () => {
    const r = await applyIncidentAction(h.db, p1Id, { action: 'ack', text: 'driving over' }, actor);
    expect(r).toMatchObject({ ok: true, status: 'acknowledged' });
    expect(r.ok && r.activeOrionAlerts).toBeGreaterThan(0);
    const [audit] = await q<{ action: string; actor_label: string; ip: string; after: unknown }>(
      `select action, actor_label, ip, after from audit_log where target_type='incident' and target_id=$1`,
      [String(p1Id)],
    );
    expect(audit).toMatchObject({
      action: 'incident.ack',
      actor_label: 'local:e2e',
      ip: '10.0.0.5',
    });
    const [ev] = await q<{ type: string; actor: string; message: string }>(
      `select type, actor, message from incident_events where incident_id=$1 and type='acked'`,
      [p1Id],
    );
    expect(ev).toEqual({
      type: 'acked',
      actor: 'user:Pat Doe',
      message: 'Acknowledged by Pat Doe: driving over',
    });

    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
    const [inc] = await q<{ status: string; acknowledged_by: string }>(
      'select status, acknowledged_by from incidents where id=$1',
      [p1Id],
    );
    expect(inc).toEqual({ status: 'acknowledged', acknowledged_by: 'Pat Doe' });
    expect(await applyIncidentAction(h.db, p1Id, { action: 'ack' }, actor)).toEqual({
      ok: false,
      error: 'Already acknowledged.',
    });
  });

  it('adds incident notes to the alerts in Orion when write-back is on', async () => {
    const cfg = loadConfig({
      ...env,
      SWIS_WRITEBACK_ENABLED: 'true',
      SWIS_WRITE_USERNAME: 'mas',
      SWIS_WRITE_PASSWORD: 'mas',
    });
    const job = { incidentId: p1Id, by: 'Pat Doe', text: 'Spectrum ticket 4471' };
    expect((await runWritebackNote(job, loadConfig(env), h.db, silent)).alerts).toBe(0);
    const before = mock.world.alertHistory.length;
    const r = await runWritebackNote(job, cfg, h.db, silent);
    expect(r.alerts).toBeGreaterThan(20);
    const notes = mock.world.alertHistory.slice(before).filter((x) => x.EventType === 3);
    expect(notes).toHaveLength(r.alerts);
    expect(notes[0]!.Message).toBe(
      `Spectrum ticket 4471\n— Pat Doe in MercerAlertService (INC-${p1Id})`,
    );
    const [ev] = await q<{ message: string }>(
      `select message from incident_events where incident_id=$1 and type='orion_note'`,
      [p1Id],
    );
    expect(ev!.message).toBe(`Note added to ${r.alerts} alerts in Orion`);
    const [audit] = await q<{ after: { onBehalfOf: string } }>(
      `select after from audit_log where action='orion.writeback.note'`,
    );
    expect(audit!.after.onBehalfOf).toBe('Pat Doe');
  });

  it('acknowledges the alerts in Orion when write-back is on', async () => {
    const off = await runWritebackAck(
      { incidentId: p1Id, by: 'Pat Doe' },
      loadConfig(env),
      h.db,
      silent,
    );
    expect(off.acknowledged).toBe(0);
    const cfg = loadConfig({
      ...env,
      SWIS_WRITEBACK_ENABLED: 'true',
      SWIS_WRITE_USERNAME: 'mas',
      SWIS_WRITE_PASSWORD: 'mas',
    });
    const r = await runWritebackAck({ incidentId: p1Id, by: 'Pat Doe' }, cfg, h.db, silent);
    expect(r.acknowledged).toBeGreaterThan(20);
    expect(mock.world.alertActive.filter((a) => a.Acknowledged).length).toBeGreaterThanOrEqual(
      r.acknowledged,
    );
    const [ev] = await q<{ message: string }>(
      `select message from incident_events where incident_id=$1 and type='orion_ack'`,
      [p1Id],
    );
    expect(ev!.message).toBe(`Acknowledged ${r.acknowledged} alerts in Orion`);
    const [audit] = await q<{ actor_label: string; after: { onBehalfOf: string } }>(
      `select actor_label, after from audit_log where action='orion.writeback.ack'`,
    );
    expect(audit).toMatchObject({ actor_label: 'writeback:mas', after: { onBehalfOf: 'Pat Doe' } });
    // Once the next poll sees the acks, there is nothing left to acknowledge.
    await worker.pollOnce('alerts');
    await worker.correlateOnce({ reconcile: false });
    expect(
      (await runWritebackAck({ incidentId: p1Id, by: 'x' }, cfg, h.db, silent)).acknowledged,
    ).toBe(0);
  });

  it('waits for a running correlation cycle instead of racing it', async () => {
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('select pg_advisory_xact_lock($1)', [CORRELATION_LOCK_KEY]);
    let done = false;
    const pending = applyIncidentAction(
      h.db,
      p1Id,
      { action: 'note', text: 'RMA filed' },
      actor,
    ).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    await holder.query('COMMIT');
    await holder.end();
    expect(await pending).toMatchObject({ ok: true });
  });

  it('snoozes, then resolves manually while alerts are still active', async () => {
    expect(
      await applyIncidentAction(h.db, p1Id, { action: 'snooze', minutes: 60 }, actor),
    ).toMatchObject({
      ok: true,
    });
    const r = await applyIncidentAction(h.db, p1Id, { action: 'resolve' }, actor);
    expect(r).toMatchObject({ ok: true, status: 'resolved' });
    const [inc] = await q<{ resolved_by: string; snoozed_until: Date | null }>(
      'select resolved_by, snoozed_until from incidents where id=$1',
      [p1Id],
    );
    expect(inc).toEqual({ resolved_by: 'user:Pat Doe', snoozed_until: null });
    const [ev] = await q<{ message: string }>(
      `select message from incident_events where incident_id=$1 and type='resolved' order by id desc limit 1`,
      [p1Id],
    );
    expect(ev!.message).toMatch(/^Resolved by Pat Doe \(\d+ alerts were still active in Orion\)$/);
    expect((await applyIncidentAction(h.db, 999_999, { action: 'ack' }, actor)).ok).toBe(false);
  });

  it('manages kiosk tokens without ever storing or auditing the token', async () => {
    const { row, token } = await createKioskToken(
      h.db,
      { name: 'NOC TV', allowedCidrs: ['10.20.0.0/24'], expiresAt: null },
      actor,
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await findKioskToken(h.db, token))?.id).toBe(row.id);
    expect(
      await findKioskToken(h.db, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')),
    ).toBeNull();
    await touchKioskToken(h.db, (await findKioskToken(h.db, token))!, '10.20.0.9');
    expect(
      (await q<{ last_used_ip: string }>('select last_used_ip from kiosk_tokens'))[0]!.last_used_ip,
    ).toBe('10.20.0.9');

    const rotated = (await rotateKioskToken(h.db, row.id, actor))!;
    expect(await findKioskToken(h.db, token)).toBeNull();
    expect((await findKioskToken(h.db, rotated.token))?.id).toBe(row.id);

    await updateKioskToken(
      h.db,
      row.id,
      { name: 'NOC TV', allowedCidrs: [], expiresAt: new Date(Date.now() - 1000) },
      actor,
    );
    expect(await findKioskToken(h.db, rotated.token)).toBeNull(); // expired
    expect(await revokeKioskToken(h.db, row.id, actor)).toBe(true);
    expect(await revokeKioskToken(h.db, row.id, actor)).toBe(false);

    const audit = await q<{ action: string; blob: string }>(
      `select action, coalesce(before::text,'') || coalesce(after::text,'') as blob from audit_log where action like 'kiosk.%' order by id`,
    );
    expect(audit.map((a) => a.action)).toEqual([
      'kiosk.create',
      'kiosk.rotate',
      'kiosk.update',
      'kiosk.revoke',
    ]);
    for (const a of audit) {
      expect(a.blob).not.toContain(token);
      expect(a.blob).not.toContain(rotated.token);
    }
  });

  it('records Entra users and admin changes', async () => {
    const u1 = await upsertEntraUser(
      h.db,
      { oid: 'oid-1', email: 'pat@mercer.example', name: 'Pat', isAdmin: false },
      { ip: null },
    );
    const u2 = await upsertEntraUser(
      h.db,
      { oid: 'oid-1', email: 'pat@mercer.example', name: 'Pat Doe', isAdmin: true },
      { ip: null },
    );
    expect(u2.id).toBe(u1.id);
    expect(u2).toMatchObject({ name: 'Pat Doe', isAdmin: true });
    const rows = await q<{ action: string; before: unknown; after: unknown }>(
      `select action, before, after from audit_log where target_type='user' order by id`,
    );
    expect(rows).toEqual([
      { action: 'auth.first_login', before: null, after: { isAdmin: false } },
      { action: 'auth.login', before: { isAdmin: false }, after: { isAdmin: true } },
    ]);
  });

  it('returns node metric series from the rollups', async () => {
    const [{ node_id }] = (await q<{ node_id: number }>(
      `select node_id from node_metrics_5m order by node_id limit 1`,
    )) as [{ node_id: number }];
    const series = await nodeMetricSeries(h.db, node_id, '24h');
    expect(series.length).toBeGreaterThan(0);
    expect(series[0]!.t).toBeInstanceOf(Date);
    expect((await nodeMetricSeries(h.db, node_id, '30d')).length).toBeGreaterThan(0);
  });
});
