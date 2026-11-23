import { describe, expect, it } from 'vitest';
import { loadConfig } from './config/env';
import {
  CLOUDFLARED_ENV,
  cloudflaredArgs,
  parseCloudflaredLine,
  parseTunnelReady,
  parseTunnelToken,
  tunnelClientIp,
  tunnelLogEvent,
  tunnelOriginHint,
  tunnelRouteProblems,
} from './tunnel';

const TUNNEL_ID = '2f3e8f6a-5c1b-4d7e-9a0b-1c2d3e4f5a6b';
const token = (o: Record<string, string> = {}) =>
  Buffer.from(
    JSON.stringify({
      a: '0123456789abcdef0123456789abcdef',
      t: TUNNEL_ID,
      s: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0',
      ...o,
    }),
  ).toString('base64');

describe('parseTunnelToken', () => {
  it('reads the tunnel ID from a token', () => {
    expect(parseTunnelToken(` ${token()} `)).toEqual({
      accountTag: '0123456789abcdef0123456789abcdef',
      tunnelId: TUNNEL_ID,
    });
  });
  it('refuses anything else', () => {
    expect(parseTunnelToken('')).toBeNull();
    expect(parseTunnelToken('cloudflared tunnel run --token abc')).toBeNull();
    expect(parseTunnelToken(token({ t: 'not-a-uuid' }))).toBeNull();
    expect(parseTunnelToken(Buffer.from('{"hello":1}'.repeat(5)).toString('base64'))).toBeNull();
  });
});

describe('connector', () => {
  it('keeps the token off the command line', () => {
    const args = cloudflaredArgs();
    expect(args).toEqual(['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20241', 'run']);
    expect(args.join(' ')).not.toMatch(/token/);
  });
  it('reads /ready', () => {
    expect(parseTunnelReady(200, { status: 200, readyConnections: 4, connectorId: 'c1' })).toEqual({
      connected: true,
      connections: 4,
      connectorId: 'c1',
    });
    expect(parseTunnelReady(503, { status: 503, readyConnections: 0 })).toMatchObject({
      connected: false,
      connections: 0,
    });
    expect(parseTunnelReady(200, 'nonsense')).toMatchObject({ connected: false });
  });
  it('reads log lines in either format', () => {
    expect(
      parseCloudflaredLine(
        '2026-11-19T20:00:00Z ERR Unable to establish connection error="dial tcp: i/o timeout"',
      ),
    ).toEqual({
      level: 'error',
      message: 'Unable to establish connection error="dial tcp: i/o timeout"',
      fields: { error: 'dial tcp: i/o timeout' },
    });
    expect(parseCloudflaredLine('2026-11-19T20:00:01Z INF Registered tunnel connection')).toEqual({
      level: 'info',
      message: 'Registered tunnel connection',
      fields: {},
    });
    expect(parseCloudflaredLine('plain text')).toEqual({
      level: 'info',
      message: 'plain text',
      fields: {},
    });
    // TUNNEL_LOG_OUTPUT=json, as cloudflared 2026.10 writes it.
    expect(
      parseCloudflaredLine(
        '{"error":"lookup cfd-features.argotunnel.com: no such host","level":"error","message":"Failed to fetch features, default to disable","time":"2026-11-23T20:51:58Z"}',
      ),
    ).toMatchObject({
      level: 'error',
      message:
        'Failed to fetch features, default to disable: lookup cfd-features.argotunnel.com: no such host',
    });
    expect(CLOUDFLARED_ENV.TUNNEL_LOG_OUTPUT).toBe('json');
  });
});

const ROUTES_JSON = JSON.stringify({
  ingress: [
    { hostname: 'mas.example.net', originRequest: {}, service: 'http://127.0.0.1:3000' },
    { service: 'http_status:404' },
  ],
  'warp-routing': { enabled: false },
});

describe('tunnel routes', () => {
  it('reads the routes Cloudflare pushes, in either log format', () => {
    const want = {
      kind: 'routes',
      routes: [
        { hostname: 'mas.example.net', path: null, service: 'http://127.0.0.1:3000' },
        { hostname: null, path: null, service: 'http_status:404' },
      ],
    };
    const json = JSON.stringify({
      level: 'info',
      version: 3,
      config: ROUTES_JSON,
      time: '2026-11-23T20:44:00Z',
      message: 'Updated to new configuration',
    });
    expect(tunnelLogEvent(parseCloudflaredLine(json))).toEqual(want);
    const console = `2026-11-23T20:44:00Z INF Updated to new configuration config=${JSON.stringify(ROUTES_JSON)} version=3`;
    expect(tunnelLogEvent(parseCloudflaredLine(console))).toEqual(want);
    expect(
      tunnelLogEvent(
        parseCloudflaredLine(
          '{"level":"info","message":"Updated to new configuration","config":"{"}',
        ),
      ),
    ).toBeNull();
  });

  it('reads a request the connector could not pass on', () => {
    const error =
      'Unable to reach the origin service. The service may be down or it may not be responding to traffic from cloudflared: dial tcp 127.0.0.1:3000: connect: connection refused';
    const json = JSON.stringify({
      level: 'error',
      event: 1,
      connIndex: 0,
      originService: 'http://127.0.0.1:3000',
      ingressRule: 0,
      error,
      time: '2026-11-23T20:44:44Z',
    });
    expect(tunnelLogEvent(parseCloudflaredLine(json))).toEqual({
      kind: 'origin_error',
      service: 'http://127.0.0.1:3000',
      error,
    });
    // Without originService, the address comes from the error.
    expect(
      tunnelLogEvent(parseCloudflaredLine(JSON.stringify({ level: 'error', error }))),
    ).toMatchObject({ service: '127.0.0.1:3000' });
    expect(tunnelLogEvent(parseCloudflaredLine('2026-11-19T20:00:01Z INF Registered'))).toBeNull();
  });

  it('says what is wrong with a route', () => {
    const route = (service: string, hostname: string | null = 'mas.example.net') => ({
      hostname,
      path: null,
      service,
    });
    const catchAll = route('http_status:404', null);
    expect(tunnelRouteProblems([route('http://web:3000'), catchAll])).toEqual([]);
    for (const s of [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]:3000',
      'http://0.0.0.0:3000',
    ]) {
      const [p] = tunnelRouteProblems([route(s), catchAll]);
      expect(p).toMatch(/^mas\.example\.net sends requests to /);
      expect(p).toMatch(/worker itself/);
      expect(p).toMatch(/HTTP and the URL to web:3000/);
    }
    expect(tunnelRouteProblems([route('https://web:3000')])[0]).toMatch(/plain HTTP/);
    expect(tunnelRouteProblems([route('http://web:8080')])[0]).toMatch(/port 3000/);
    expect(tunnelRouteProblems([route('http://web')])[0]).toMatch(/port 3000/);
    expect(tunnelRouteProblems([route('ssh://web:22')])[0]).toMatch(/not MAS’s web app/);
    expect(tunnelRouteProblems([route('http_status:404')])[0]).toMatch(/not MAS’s web app/);
    // Another host may be deliberate (nginx on the VM, say): not flagged.
    expect(tunnelRouteProblems([route('http://10.20.0.5:443')])).toEqual([]);
    expect(tunnelRouteProblems([catchAll])[0]).toMatch(/no public hostname yet/);
    expect(tunnelRouteProblems([])[0]).toMatch(/no public hostname yet/);
  });

  it('suggests what to check after a failed request', () => {
    expect(tunnelOriginHint('http://127.0.0.1:3000')).toMatch(/worker itself/);
    expect(tunnelOriginHint('http://web:3000')).toMatch(/docker compose ps -a/);
    expect(tunnelOriginHint(null)).toMatch(/docker compose ps -a/);
    expect(tunnelOriginHint('')).toMatch(/docker compose ps -a/);
  });
});

describe('tunnelClientIp', () => {
  it('believes CF-Connecting-IP only from the connector', () => {
    const base = { connectorIps: ['172.18.0.5'], cfConnectingIp: '203.0.113.9' };
    expect(tunnelClientIp({ ...base, peer: '172.18.0.5' })).toBe('203.0.113.9');
    expect(tunnelClientIp({ ...base, peer: '::ffff:172.18.0.5' })).toBe('203.0.113.9');
    expect(tunnelClientIp({ ...base, peer: '172.18.0.1' })).toBeNull();
    expect(tunnelClientIp({ ...base, peer: '172.18.0.5', cfConnectingIp: 'evil' })).toBeNull();
    expect(tunnelClientIp({ ...base, peer: null })).toBeNull();
  });
});

describe('tunnel settings', () => {
  const env = { DATABASE_URL: 'postgres://x' };
  it('needs a valid token when turned on', () => {
    expect(() => loadConfig({ ...env, CF_TUNNEL_ENABLED: 'true' })).toThrow(/CF_TUNNEL_TOKEN/);
    expect(() => loadConfig({ ...env, CF_TUNNEL_ENABLED: 'true', CF_TUNNEL_TOKEN: 'abc' })).toThrow(
      /not a Cloudflare tunnel token/,
    );
    const cfg = loadConfig({ ...env, CF_TUNNEL_ENABLED: 'true', CF_TUNNEL_TOKEN: token() });
    expect(cfg.tunnel).toMatchObject({
      enabled: true,
      tunnelId: TUNNEL_ID,
      connectorHost: 'worker',
    });
  });
  it('is off by default', () => {
    expect(loadConfig(env).tunnel).toEqual({
      enabled: false,
      token: null,
      tunnelId: null,
      connectorHost: 'worker',
    });
  });
});
