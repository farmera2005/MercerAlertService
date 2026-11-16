/**
 * On-demand jobs requested by the web setup wizard / Settings page. They run in the worker so the
 * web app never talks to SWIS itself (CLAUDE.md rule 1). Inputs may carry an unsaved candidate
 * connection; its password arrives sealed with the master key, never in plaintext.
 */
import {
  errorMessage,
  INTERNAL_SETTING_KEYS,
  type AppConfig,
  type Logger,
  type SecretBox,
} from '@mercer/core';
import { setInternalSetting, type Db } from '@mercer/db';
import {
  explainSwisError,
  fetchServerCertificate,
  runDiscovery,
  SwisClient,
  testSwisConnection,
  type CertJobOutput,
  type ConnectionInput,
  type ConnectionTestResult,
  type DiscoverJobOutput,
} from '@mercer/swis';

export { SETUP_QUEUES, type ConnectionInput } from '@mercer/swis';

interface Resolved {
  baseUrl: string;
  host: string;
  port: number;
  username: string;
  password: string;
  caCertPem?: string;
  servername?: string;
  insecure: boolean;
}

/** A field present in the input wins (an empty string means "cleared"); absent → saved value. */
const pick = (inputValue: string | undefined, saved: string | undefined) =>
  inputValue !== undefined ? inputValue.trim() || undefined : saved;

function resolveConnection(input: ConnectionInput, cfg: AppConfig, box: SecretBox): Resolved {
  const host = input.host?.trim() || new URL(cfg.swis.baseUrl).hostname;
  const port = input.port || Number(new URL(cfg.swis.baseUrl).port) || 17774;
  const baseUrl =
    input.baseUrl?.trim() || (input.host ? `https://${host}:${port}` : cfg.swis.baseUrl);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    host,
    port,
    username: input.username ?? cfg.swis.username,
    password: input.passwordSealed ? box.open(input.passwordSealed) : cfg.swis.password,
    caCertPem: pick(input.caCertPem, cfg.swis.caCertPem),
    servername: pick(input.servername, cfg.swis.tlsServername),
    insecure: input.insecure ?? cfg.swis.insecureSkipVerify,
  };
}

function clientFor(r: Resolved, cfg: AppConfig, log: Logger): SwisClient {
  return new SwisClient({
    baseUrl: r.baseUrl,
    username: r.username,
    password: r.password,
    caCertPem: r.caCertPem,
    caCertPath: cfg.swis.caCertPath,
    tlsServername: r.servername,
    insecureSkipVerify: r.insecure,
    timeoutMs: Math.min(cfg.swis.timeoutMs, 15_000),
    maxRetries: 0,
    breakerThreshold: 1000,
    userAgent: `MercerAlertService/${cfg.version} (setup)`,
    logger: log,
  });
}

export async function runCertJob(
  input: ConnectionInput,
  cfg: AppConfig,
  box: SecretBox,
): Promise<CertJobOutput> {
  const r = resolveConnection(input, cfg, box);
  if (r.baseUrl.startsWith('http:'))
    return {
      ok: false,
      error: 'The base URL uses plain HTTP, so there is no certificate to check.',
    };
  const url = new URL(r.baseUrl);
  try {
    const report = await fetchServerCertificate(url.hostname, Number(url.port) || 443, {
      servername: r.servername,
      trustedPem: r.caCertPem,
    });
    return { ok: true, report };
  } catch (err) {
    const e = explainSwisError(Object.assign(new Error(errorMessage(err)), err as object));
    return { ok: false, error: errorMessage(err), hint: e.hint };
  }
}

export async function runTestJob(
  input: ConnectionInput,
  cfg: AppConfig,
  box: SecretBox,
  db: Db,
  log: Logger,
): Promise<ConnectionTestResult> {
  const r = resolveConnection(input, cfg, box);
  if (!r.username || !r.password) {
    return {
      ok: false,
      ms: 0,
      error: 'Username and password are required.',
      field: r.username ? 'SWIS_PASSWORD' : 'SWIS_USERNAME',
    };
  }
  let client: SwisClient | null = null;
  try {
    client = clientFor(r, cfg, log);
    const result = await testSwisConnection(client);
    await setInternalSetting(db, INTERNAL_SETTING_KEYS.lastConnectionTest, {
      at: new Date().toISOString(),
      baseUrl: r.baseUrl,
      ...result,
    });
    return result;
  } catch (err) {
    return { ok: false, ms: 0, ...explainSwisError(err) };
  } finally {
    await client?.close();
  }
}

export async function runDiscoverJob(
  input: ConnectionInput,
  cfg: AppConfig,
  box: SecretBox,
  db: Db,
  log: Logger,
): Promise<DiscoverJobOutput> {
  const r = resolveConnection(input, cfg, box);
  const client = clientFor(r, cfg, log);
  try {
    const probe = await testSwisConnection(client);
    if (!probe.ok)
      return { ok: false, error: probe.error ?? 'connection failed', hint: probe.hint };
    const report = await runDiscovery(client, r.baseUrl, { checkQueries: true, topValues: 100 });
    const at = new Date().toISOString();
    await setInternalSetting(db, INTERNAL_SETTING_KEYS.lastDiscovery, { at, report });
    return { ok: true, at, report };
  } catch (err) {
    return { ok: false, ...explainSwisError(err), error: errorMessage(err) };
  } finally {
    await client.close();
  }
}
