import { describe, expect, it } from 'vitest';
import { envSchema, ConfigError, loadConfig } from './env';
import { SETTINGS, SETTING_SECTIONS } from './registry';

describe('settings registry', () => {
  it('only lists keys the config schema knows, each once, in a known section', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SETTINGS) {
      expect(s.key in envSchema.shape, s.key).toBe(true);
      expect(s.section in SETTING_SECTIONS).toBe(true);
    }
  });
  it('never exposes bootstrap secrets as editable settings', () => {
    const keys = new Set(SETTINGS.map((s) => s.key));
    for (const k of ['DATABASE_URL', 'MAS_MASTER_KEY', 'NODE_ENV', 'MAS_SETUP_COMPLETE'])
      expect(keys.has(k as never)).toBe(false);
  });
});

describe('loadConfig precedence', () => {
  it('uses saved settings when the environment is silent', () => {
    const cfg = loadConfig(
      { DATABASE_URL: 'x' },
      { SWIS_HOST: 'orion-a', SWIS_POLL_ALERTS_SEC: '45', CP_SITE_FIELD: 'Location_Site' },
    );
    expect(cfg.swis.baseUrl).toBe('https://orion-a:17774');
    expect(cfg.swis.pollSec.alerts).toBe(45);
    expect(cfg.mapping.siteField).toBe('Location_Site');
    expect(cfg.envKeys.has('SWIS_HOST')).toBe(false);
  });
  it('lets the environment win and reports locked keys', () => {
    const cfg = loadConfig(
      { DATABASE_URL: 'x', SWIS_HOST: 'orion-env' },
      { SWIS_HOST: 'orion-db' },
    );
    expect(cfg.swis.baseUrl).toBe('https://orion-env:17774');
    expect(cfg.envKeys.has('SWIS_HOST')).toBe(true);
  });
  it('ignores unknown and empty overrides', () => {
    const cfg = loadConfig(
      { DATABASE_URL: 'x' },
      { 'internal.setup_code': 'v1:abc', SWIS_PORT: '' },
    );
    expect(cfg.swis.baseUrl).toBe('https://orion.mercer.local:17774');
  });
  it('reports which saved setting is invalid', () => {
    try {
      loadConfig({ DATABASE_URL: 'x' }, { SWIS_POLL_ALERTS_SEC: '2' });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues[0]?.key).toBe('SWIS_POLL_ALERTS_SEC');
    }
  });
  it('carries the setup flag and CA PEM', () => {
    const cfg = loadConfig(
      { DATABASE_URL: 'x' },
      { MAS_SETUP_COMPLETE: 'true', SWIS_CA_CERT_PEM: '-----BEGIN CERTIFICATE-----' },
    );
    expect(cfg.setupComplete).toBe(true);
    expect(cfg.swis.caCertPem).toContain('BEGIN CERTIFICATE');
  });
});

describe('sign-in and map settings', () => {
  const G = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
  it('leaves Microsoft sign-in off until configured, then requires every field', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).auth.entra).toBeNull();
    try {
      loadConfig({ DATABASE_URL: 'x' }, { ENTRA_CLIENT_ID: G(1) });
      expect.fail('should throw');
    } catch (err) {
      expect((err as ConfigError).issues.map((i) => i.key).sort()).toEqual([
        'ENTRA_ALLOWED_GROUP_ID',
        'ENTRA_CLIENT_SECRET',
        'ENTRA_TENANT_ID',
      ]);
    }
    const cfg = loadConfig(
      { DATABASE_URL: 'x' },
      {
        ENTRA_TENANT_ID: G(1),
        ENTRA_CLIENT_ID: G(2),
        ENTRA_CLIENT_SECRET: 's3cret',
        ENTRA_ALLOWED_GROUP_ID: G(3),
        BOOTSTRAP_ADMIN_EMAILS: 'Lead@X.com, it@x.com',
      },
    );
    expect(cfg.auth.entra).toMatchObject({
      allowedGroupId: G(3),
      adminGroupId: '',
      bootstrapAdminEmails: ['lead@x.com', 'it@x.com'],
    });
  });
  it('rejects a group name where an Object ID is expected', () => {
    expect(() =>
      loadConfig(
        { DATABASE_URL: 'x' },
        {
          ENTRA_TENANT_ID: G(1),
          ENTRA_CLIENT_ID: G(2),
          ENTRA_CLIENT_SECRET: 's',
          ENTRA_ALLOWED_GROUP_ID: 'IT Team',
        },
      ),
    ).toThrow(ConfigError);
  });
  it('requires {z}/{x}/{y} in a custom tile URL', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'x' }, { MAP_TILE_URL: 'https://tiles.local/map.png' }),
    ).toThrow(/MAP_TILE_URL/);
    expect(loadConfig({ DATABASE_URL: 'x' }).map.mode).toBe('tiles');
  });
});
