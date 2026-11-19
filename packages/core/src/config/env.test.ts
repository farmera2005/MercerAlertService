import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './env';

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(cfg.swis.baseUrl).toBe('https://orion.mercer.local:17774');
    expect(cfg.swis.pollSec).toEqual({
      alerts: 30,
      nodes: 60,
      interfaces: 180,
      events: 300,
      groups: 300,
      topology: 3600,
    });
    expect(cfg.mapping.siteGroupParent).toBeNull();
    expect(cfg.mapping.siteGroupPattern).toBeNull();
    expect(cfg.mapping.siteGroupAuto).toBe(true);
    expect(cfg.swis.insecureSkipVerify).toBe(false);
    expect(cfg.retention.rawDays).toBe(90);
    expect(cfg.timezone).toBe('America/New_York');
  });
  it('reads *_FILE secrets and ignores empty strings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mas-'));
    const f = join(dir, 'pw');
    writeFileSync(f, 's3cret\n');
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x', SWIS_PASSWORD_FILE: f, SWIS_PORT: '' });
    expect(cfg.swis.password).toBe('s3cret');
    expect(cfg.swis.baseUrl).toBe('https://orion.mercer.local:17774');
  });
  it('rejects bad values', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(loadConfig({}).database.url).toBe('postgres://mas:mas@localhost:5432/mas');
    expect(() => loadConfig({ DATABASE_URL: 'x', APP_TIMEZONE: 'Mars/Olympus' })).toThrow(
      /time zone/,
    );
    expect(() => loadConfig({ DATABASE_URL: 'x', SWIS_POLL_ALERTS_SEC: 'fast' })).toThrow(
      ConfigError,
    );
  });
  it('lets SWIS_BASE_URL override host/port', () => {
    expect(
      loadConfig({ DATABASE_URL: 'x', SWIS_BASE_URL: 'http://mock-swis:17774/' }).swis.baseUrl,
    ).toBe('http://mock-swis:17774');
  });
});

describe('resolveFileEnv scoping', () => {
  it('ignores *_FILE variables we do not own', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'x', SOME_TOOL_FILE: '/does/not/exist' }),
    ).not.toThrow();
  });
});
