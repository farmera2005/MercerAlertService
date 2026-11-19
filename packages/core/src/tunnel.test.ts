import { describe, expect, it } from 'vitest';
import { loadConfig } from './config/env';
import {
  cloudflaredArgs,
  parseCloudflaredLine,
  parseTunnelReady,
  parseTunnelToken,
  tunnelClientIp,
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
  it('reads log lines', () => {
    expect(
      parseCloudflaredLine(
        '2026-11-19T20:00:00Z ERR Unable to establish connection error="dial tcp: i/o timeout"',
      ),
    ).toEqual({
      level: 'error',
      message: 'Unable to establish connection error="dial tcp: i/o timeout"',
    });
    expect(parseCloudflaredLine('2026-11-19T20:00:01Z INF Registered tunnel connection')).toEqual({
      level: 'info',
      message: 'Registered tunnel connection',
    });
    expect(parseCloudflaredLine('plain text')).toEqual({ level: 'info', message: 'plain text' });
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
