import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startMockSwis, type MockSwis } from '@mercer/mock-swis';
import { SwisClient } from './client';
import {
  CircuitOpenError,
  SwisHttpError,
  SwisNetworkError,
  SwisSchemaError,
  SwisTimeoutError,
} from './errors';
import { SwisFetcher } from './fetch';
import { SchemaProbe } from './probe';
import { WRITEBACK } from './queries';

const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silent;
  },
} as never;

function client(mock: MockSwis, extra: Partial<ConstructorParameters<typeof SwisClient>[0]> = {}) {
  return new SwisClient({
    baseUrl: mock.url,
    username: 'mas',
    password: 'mas',
    timeoutMs: 2000,
    maxRetries: 2,
    retryBaseMs: 5,
    retryMaxMs: 20,
    breakerThreshold: 3,
    breakerCooldownMs: 200,
    logger: silent,
    ...extra,
  });
}

describe('SwisClient + SwisFetcher against mock SWIS', () => {
  let mock: MockSwis;
  beforeAll(async () => {
    mock = await startMockSwis({ port: 0 });
  });
  afterAll(async () => mock.close());
  afterEach(() => mock.reset());

  it('pages through snapshots with WITH ROWS and maps custom properties', async () => {
    const c = client(mock);
    const probe = new SchemaProbe(c, silent);
    await probe.refresh();
    expect(probe.customPropertyFields).toEqual(['City', 'Comments', 'Division', 'Site']);
    const f = new SwisFetcher(c, probe, {
      pageSize: 7,
      incrementalPageSize: 5,
      eventsBackfill: 100,
      naiveTimeZone: 'UTC',
      logger: silent,
    });
    const nodes = await f.nodes();
    expect(nodes.rows).toHaveLength(mock.world.nodes.length);
    expect(new Set(nodes.rows.map((n) => n.nodeId)).size).toBe(nodes.rows.length);
    const rock = nodes.rows.find((n) => n.caption === 'ROCK-FW01')!;
    expect(rock.customProperties).toMatchObject({ Site: 'Rockford', Division: 'Grain' });
    expect(rock.lastBoot).toBeInstanceOf(Date);
    const ifaces = await f.interfaces();
    expect(ifaces.rows).toHaveLength(mock.world.interfaces.length);
    const alerts = await f.activeAlerts();
    expect(alerts.rows.length).toBe(mock.world.alertActive.length);
    expect(alerts.rows[0]).toMatchObject({ alertName: 'Interface is down', severity: 1 });
    expect(alerts.rows[0]!.interfaceId).toBeGreaterThan(0);
    const [conns, deps, groups, members] = await Promise.all([
      f.topologyConnections(),
      f.dependencies(),
      f.groups(),
      f.groupMembers(),
    ]);
    expect(conns.rows.length).toBeGreaterThan(10);
    expect(deps.rows[0]!.childUri).toContain('ContainerID=');
    expect(groups.rows.length).toBe(13);
    expect(members.rows.length).toBeGreaterThan(30);
    await c.close();
  });

  it('fetches events incrementally with backfill and cursor', async () => {
    const c = client(mock);
    const probe = new SchemaProbe(c, silent);
    await probe.refresh();
    const f = new SwisFetcher(c, probe, {
      pageSize: 50,
      incrementalPageSize: 2,
      eventsBackfill: 100,
      naiveTimeZone: 'UTC',
      logger: silent,
    });
    const first = await f.events(null);
    expect(first.rows.length).toBe(mock.world.events.length);
    mock.applyScenario('flapping-ap', { flaps: 1 });
    const second = await f.events(first.cursor);
    expect(second.rows.map((e) => e.eventTypeName)).toContain('Node Down');
    expect(second.cursor).toBeGreaterThan(first.cursor);
    const history = await f.alertHistory(null);
    expect(history.rows.length).toBeGreaterThan(0);
    await c.close();
  });

  it('drops missing optional fields and fails loudly on missing required ones', async () => {
    const older = await startMockSwis({
      port: 0,
      dropFields: ['Orion.Nodes.PercentMemoryUsed', 'Orion.AlertObjects.TriggeredCount'],
    });
    const c = client(older);
    const probe = new SchemaProbe(c, silent);
    await probe.refresh();
    const f = new SwisFetcher(c, probe, {
      pageSize: 100,
      incrementalPageSize: 100,
      eventsBackfill: 10,
      naiveTimeZone: 'UTC',
      logger: silent,
    });
    const nodes = await f.nodes();
    expect(nodes.dropped).toEqual(['Orion.Nodes.PercentMemoryUsed']);
    expect(nodes.rows[0]!.percentMemoryUsed).toBeNull();
    expect((await f.activeAlerts()).dropped).toEqual(['Orion.AlertObjects.TriggeredCount']);
    await c.close();
    await older.close();

    const broken = await startMockSwis({ port: 0, dropFields: ['Orion.Nodes.Status'] });
    const c2 = client(broken);
    const p2 = new SchemaProbe(c2, silent);
    await p2.refresh();
    const f2 = new SwisFetcher(c2, p2, {
      pageSize: 100,
      incrementalPageSize: 100,
      eventsBackfill: 10,
      naiveTimeZone: 'UTC',
      logger: silent,
    });
    await expect(f2.nodes()).rejects.toBeInstanceOf(SwisSchemaError);
    await c2.close();
    await broken.close();
  });

  it('does not retry auth failures or SWQL errors, and SWQL errors do not trip the breaker', async () => {
    const bad = client(mock, { password: 'wrong' });
    await expect(bad.query('SELECT n.NodeID AS NodeID FROM Orion.Nodes n')).rejects.toMatchObject({
      status: 401,
    });
    await bad.close();
    const c = client(mock);
    const before = mock.stats.queries;
    for (let i = 0; i < 5; i++) {
      await expect(c.query('SELECT n.Nope AS Nope FROM Orion.Nodes n')).rejects.toBeInstanceOf(
        SwisHttpError,
      );
    }
    expect(mock.stats.queries - before).toBe(5);
    expect(c.breaker.snapshot().state).toBe('closed');
    await c.close();
  });

  it('retries 503s, opens the breaker, fails fast, then recovers via half-open', async () => {
    const c = client(mock);
    mock.setOutage('503');
    const q = () => c.query('SELECT n.NodeID AS NodeID FROM Orion.Nodes n');
    for (let i = 0; i < 3; i++) await expect(q()).rejects.toMatchObject({ status: 503 });
    expect(c.breaker.snapshot().state).toBe('open');
    const before = mock.stats.queries;
    await expect(q()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(mock.stats.queries).toBe(before); // failed fast, no request sent
    mock.setOutage('none');
    await new Promise((r) => setTimeout(r, 250));
    await expect(q()).resolves.toHaveLength(mock.world.nodes.length);
    expect(c.breaker.snapshot().state).toBe('closed');
    await c.close();
  });

  it('times out hung requests', async () => {
    const c = client(mock, { timeoutMs: 1000, maxRetries: 0 });
    mock.setOutage('timeout');
    await expect(c.query('SELECT n.NodeID AS NodeID FROM Orion.Nodes n')).rejects.toBeInstanceOf(
      SwisTimeoutError,
    );
    await c.close();
  });

  it('invokes the Acknowledge verb', async () => {
    const c = client(mock);
    const objectId = Number(mock.world.alertActive[0]!.AlertObjectID);
    await c.invoke('Orion.AlertActive', 'Acknowledge', [[objectId], 'ack from test']);
    expect(mock.world.alertActive[0]!.Acknowledged).toBe(true);
    await c.close();
  });

  it('updates a group description and reads it back', async () => {
    const c = client(mock);
    const g = mock.world.groups[0]!;
    await c.update(String(g.Uri), { Description: 'Generator on site' });
    const [row] = await c.query<{ Description: string }>(WRITEBACK.groupById, {
      id: Number(g.ContainerID),
    });
    expect(row!.Description).toBe('Generator on site');
    await expect(c.update('https://evil.example/x', { Description: 'x' })).rejects.toThrow(
      'invalid SWIS entity URI',
    );
    await c.close();
  });

  it('appends a note to active alerts', async () => {
    const c = client(mock);
    const objectId = Number(mock.world.alertActive[0]!.AlertObjectID);
    const before = mock.world.alertHistory.length;
    await c.invoke('Orion.AlertActive', 'AppendNote', [[objectId], 'note from test']);
    expect(mock.world.alertHistory.slice(before)).toMatchObject([
      { EventType: 3, Message: 'note from test' },
    ]);
    await c.close();
  });
});

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!haveOpenssl())('TLS with a custom CA bundle', () => {
  let mock: MockSwis;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mas-tls-'));
    const cnf = join(dir, 'cert.cnf');
    writeFileSync(
      cnf,
      '[req]\ndistinguished_name=dn\n[dn]\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n',
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-config',
        cnf,
        '-extensions',
        'ext',
      ],
      { stdio: 'ignore' },
    );
    mock = await startMockSwis({
      port: 0,
      tlsCert: join(dir, 'cert.pem'),
      tlsKey: join(dir, 'key.pem'),
    });
  });
  afterAll(async () => mock.close());

  it('rejects the self-signed Orion certificate by default, with a helpful hint', async () => {
    const c = client(mock, { maxRetries: 0 });
    const err = await c
      .query('SELECT n.NodeID AS NodeID FROM Orion.Nodes n')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwisNetworkError);
    expect(String((err as Error).message)).toMatch(/SWIS_CA_CERT_PATH/);
    await c.close();
  });

  it('trusts it when SWIS_CA_CERT_PATH points at the exported certificate', async () => {
    const c = client(mock, { caCertPath: join(dir, 'cert.pem') });
    await expect(c.query('SELECT n.NodeID AS NodeID FROM Orion.Nodes n')).resolves.not.toHaveLength(
      0,
    );
    await c.close();
  });
});
