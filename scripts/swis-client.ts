/** Shared bootstrap for the SWIS CLI scripts (no database needed). */
import { assertSwisConfigured, initLogger, loadConfig } from '@mercer/core';
import { SwisClient } from '@mercer/swis';

export function scriptClient() {
  const cfg = loadConfig({ DATABASE_URL: 'postgres://unused', ...process.env });
  initLogger({ service: 'mas-script', level: process.env.LOG_LEVEL ?? 'warn' });
  assertSwisConfigured(cfg.swis);
  const client = new SwisClient({
    baseUrl: cfg.swis.baseUrl,
    username: cfg.swis.username,
    password: cfg.swis.password,
    caCertPath: cfg.swis.caCertPath,
    tlsServername: cfg.swis.tlsServername,
    insecureSkipVerify: cfg.swis.insecureSkipVerify,
    timeoutMs: cfg.swis.timeoutMs,
    maxRetries: 1,
  });
  return { cfg, client };
}
