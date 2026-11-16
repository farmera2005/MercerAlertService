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
