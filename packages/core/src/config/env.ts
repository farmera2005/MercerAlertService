import { z } from 'zod';
import { resolveFileEnv, SECRET_ENV_PREFIXES } from './file-env';

const bool = (def: boolean) => z.stringbool().default(def);
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const str = (def: string) => z.string().default(def);

/** Raw env schema (flat, as written in .env / compose). Defaults are the documented placeholders. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_TIMEZONE: str('America/New_York'),
  APP_BASE_URL: str('http://localhost:3000'),
  APP_VERSION: str('dev'),

  /** Docker: DATABASE_URL_FILE written by `init`. Outside production defaults to the dev database. */
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: int(10, 1),

  // --- SWIS ---
  SWIS_HOST: str('orion.mercer.local'),
  SWIS_PORT: int(17774, 1),
  /** Full override, e.g. http://mock-swis:17774 for local dev. Wins over SWIS_HOST/PORT. */
  SWIS_BASE_URL: z.string().optional(),
  SWIS_USERNAME: str(''),
  SWIS_PASSWORD: str(''),
  SWIS_CA_CERT_PATH: z.string().optional(),
  /** PEM content (set from the web setup wizard). Used in addition to SWIS_CA_CERT_PATH. */
  SWIS_CA_CERT_PEM: z.string().optional(),
  SWIS_TLS_SERVERNAME: z.string().optional(),
  SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY: bool(false),
  SWIS_TIMEOUT_MS: int(20_000, 1000),
  SWIS_MAX_RETRIES: int(3),
  SWIS_RETRY_BASE_MS: int(500, 1),
  SWIS_RETRY_MAX_MS: int(8_000, 1),
  SWIS_BREAKER_THRESHOLD: int(5, 1),
  SWIS_BREAKER_COOLDOWN_MS: int(30_000, 1000),
  SWIS_PAGE_SIZE: int(1000, 1),
  SWIS_INCREMENTAL_PAGE_SIZE: int(2000, 1),
  SWIS_EVENTS_BACKFILL: int(2000),
  SWIS_NAIVE_TIMEZONE: str('UTC'),
  SWIS_STALE_AFTER_SEC: int(120, 10),
  SWIS_POLL_ALERTS_SEC: int(30, 5),
  SWIS_POLL_NODES_SEC: int(60, 10),
  SWIS_POLL_INTERFACES_SEC: int(180, 30),
  SWIS_POLL_EVENTS_SEC: int(300, 30),
  SWIS_POLL_TOPOLOGY_SEC: int(3600, 60),
  SWIS_WRITEBACK_ENABLED: bool(false),
  SWIS_WRITE_USERNAME: z.string().optional(),
  SWIS_WRITE_PASSWORD: z.string().optional(),

  // --- Site / division mapping (Admin UI overrides these via app_settings) ---
  CP_SITE_FIELD: str('Site'),
  CP_DIVISION_FIELD: str('Division'),
  CP_CITY_FIELD: str('City'),
  CP_ROLE_FIELD: str(''),
  SITE_FROM_CAPTION_REGEX: str('^([A-Za-z]{3,5})[-_]'),
  SITE_AUTO_CREATE: bool(true),

  // --- Retention ---
  RETENTION_RAW_DAYS: int(90, 1),
  RETENTION_POLL_RUNS_DAYS: int(30, 1),
  RETENTION_INCIDENT_DAYS: int(730, 30),
  RETENTION_AUDIT_DAYS: int(730, 30),
  RETENTION_CRON: str('15 3 * * *'),

  // --- Worker runtime ---
  WORKER_HEALTH_PORT: int(9090, 1),
  WORKER_HEARTBEAT_SEC: int(15, 5),
  DEADMAN_PING_URL: z.string().optional(),

  // --- Web ---
  HEALTH_WORKER_STALE_SEC: int(60, 10),

  // --- Bootstrap / security ---
  /** 32-byte base64 key that encrypts secrets stored in the database. Usually MAS_MASTER_KEY_FILE. */
  MAS_MASTER_KEY: z.string().optional(),
  /** Where a generated master key is kept when none is supplied (local development). */
  MAS_DATA_DIR: z.string().optional(),
  /** Set by the web setup wizard's final step; polling starts once true. */
  MAS_SETUP_COMPLETE: bool(false),
});

export type RawEnv = z.infer<typeof envSchema>;

/** Matches `pnpm dev:db`. Only used when NODE_ENV is not production. */
export const DEV_DATABASE_URL = 'postgres://mas:mas@localhost:5432/mas';

export interface SwisConfig {
  baseUrl: string;
  username: string;
  password: string;
  caCertPath?: string;
  caCertPem?: string;
  tlsServername?: string;
  insecureSkipVerify: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  pageSize: number;
  incrementalPageSize: number;
  eventsBackfill: number;
  naiveTimezone: string;
  staleAfterSec: number;
  pollSec: { alerts: number; nodes: number; interfaces: number; events: number; topology: number };
  writeback: { enabled: boolean; username?: string; password?: string };
}

export interface MappingConfig {
  siteField: string;
  divisionField: string;
  cityField: string;
  roleField: string;
  siteFromCaptionRegex: string | null;
  autoCreateSites: boolean;
}

export interface AppConfig {
  env: RawEnv['NODE_ENV'];
  logLevel: RawEnv['LOG_LEVEL'];
  timezone: string;
  baseUrl: string;
  version: string;
  database: { url: string; poolMax: number };
  swis: SwisConfig;
  mapping: MappingConfig;
  retention: {
    rawDays: number;
    pollRunsDays: number;
    incidentDays: number;
    auditDays: number;
    cron: string;
  };
  worker: { healthPort: number; heartbeatSec: number; deadmanPingUrl?: string };
  web: { workerStaleSec: number };
  setupComplete: boolean;
  /** Which keys came from the environment (and are therefore locked in the web UI). */
  envKeys: ReadonlySet<string>;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
  issues: ConfigIssue[] = [];
}

function assertTimezone(tz: string, key: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    const err = new ConfigError(`${key}="${tz}" is not a valid IANA time zone`);
    err.issues = [{ key, message: 'not a valid IANA time zone (e.g. America/New_York)' }];
    throw err;
  }
}

/** Keys of the env schema. */
export type ConfigKey = keyof RawEnv & string;

export function isConfigKey(k: string): k is ConfigKey {
  return k in envSchema.shape;
}

const knownEnv = (k: string) => isConfigKey(k) || SECRET_ENV_PREFIXES.some((p) => k.startsWith(p));

/** The schema keys explicitly present in the environment (after *_FILE resolution). */
export function envConfigKeys(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(Object.keys(resolveFileEnv(env, knownEnv)).filter(isConfigKey));
}

export interface ConfigIssue {
  key: string;
  message: string;
}

/**
 * Parse and validate configuration. Precedence: environment (incl. *_FILE) → `overrides`
 * (settings saved in the web UI, decrypted) → schema defaults. Throws ConfigError.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): AppConfig {
  const fromEnv = resolveFileEnv(env, knownEnv);
  const envKeys = new Set(Object.keys(fromEnv).filter(isConfigKey));
  const fromDb: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (isConfigKey(k) && !envKeys.has(k) && v !== '') fromDb[k] = v;
  }
  const parsed = envSchema.safeParse({ ...fromDb, ...fromEnv });
  if (!parsed.success) {
    const err = new ConfigError(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
    err.issues = parsed.error.issues.map((i) => ({
      key: String(i.path[0] ?? ''),
      message: i.message,
    }));
    throw err;
  }
  const e = parsed.data;
  const databaseUrl =
    e.DATABASE_URL ?? (e.NODE_ENV === 'production' ? undefined : DEV_DATABASE_URL);
  if (!databaseUrl) {
    const err = new ConfigError('DATABASE_URL (or DATABASE_URL_FILE) is required in production');
    err.issues = [{ key: 'DATABASE_URL', message: 'required' }];
    throw err;
  }
  assertTimezone(e.APP_TIMEZONE, 'APP_TIMEZONE');
  assertTimezone(e.SWIS_NAIVE_TIMEZONE, 'SWIS_NAIVE_TIMEZONE');
  if (e.SITE_FROM_CAPTION_REGEX) {
    try {
      new RegExp(e.SITE_FROM_CAPTION_REGEX);
    } catch {
      const err = new ConfigError(`SITE_FROM_CAPTION_REGEX is not a valid regular expression`);
      err.issues = [{ key: 'SITE_FROM_CAPTION_REGEX', message: 'not a valid regular expression' }];
      throw err;
    }
  }
  const baseUrl = (e.SWIS_BASE_URL ?? `https://${e.SWIS_HOST}:${e.SWIS_PORT}`).replace(/\/+$/, '');

  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    timezone: e.APP_TIMEZONE,
    baseUrl: e.APP_BASE_URL.replace(/\/+$/, ''),
    version: e.APP_VERSION,
    database: { url: databaseUrl, poolMax: e.DATABASE_POOL_MAX },
    swis: {
      baseUrl,
      username: e.SWIS_USERNAME,
      password: e.SWIS_PASSWORD,
      caCertPath: e.SWIS_CA_CERT_PATH,
      caCertPem: e.SWIS_CA_CERT_PEM,
      tlsServername: e.SWIS_TLS_SERVERNAME,
      insecureSkipVerify: e.SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY,
      timeoutMs: e.SWIS_TIMEOUT_MS,
      maxRetries: e.SWIS_MAX_RETRIES,
      retryBaseMs: e.SWIS_RETRY_BASE_MS,
      retryMaxMs: e.SWIS_RETRY_MAX_MS,
      breakerThreshold: e.SWIS_BREAKER_THRESHOLD,
      breakerCooldownMs: e.SWIS_BREAKER_COOLDOWN_MS,
      pageSize: e.SWIS_PAGE_SIZE,
      incrementalPageSize: e.SWIS_INCREMENTAL_PAGE_SIZE,
      eventsBackfill: e.SWIS_EVENTS_BACKFILL,
      naiveTimezone: e.SWIS_NAIVE_TIMEZONE,
      staleAfterSec: e.SWIS_STALE_AFTER_SEC,
      pollSec: {
        alerts: e.SWIS_POLL_ALERTS_SEC,
        nodes: e.SWIS_POLL_NODES_SEC,
        interfaces: e.SWIS_POLL_INTERFACES_SEC,
        events: e.SWIS_POLL_EVENTS_SEC,
        topology: e.SWIS_POLL_TOPOLOGY_SEC,
      },
      writeback: {
        enabled: e.SWIS_WRITEBACK_ENABLED,
        username: e.SWIS_WRITE_USERNAME,
        password: e.SWIS_WRITE_PASSWORD,
      },
    },
    mapping: {
      siteField: e.CP_SITE_FIELD,
      divisionField: e.CP_DIVISION_FIELD,
      cityField: e.CP_CITY_FIELD,
      roleField: e.CP_ROLE_FIELD,
      siteFromCaptionRegex: e.SITE_FROM_CAPTION_REGEX || null,
      autoCreateSites: e.SITE_AUTO_CREATE,
    },
    retention: {
      rawDays: e.RETENTION_RAW_DAYS,
      pollRunsDays: e.RETENTION_POLL_RUNS_DAYS,
      incidentDays: e.RETENTION_INCIDENT_DAYS,
      auditDays: e.RETENTION_AUDIT_DAYS,
      cron: e.RETENTION_CRON,
    },
    worker: {
      healthPort: e.WORKER_HEALTH_PORT,
      heartbeatSec: e.WORKER_HEARTBEAT_SEC,
      deadmanPingUrl: e.DEADMAN_PING_URL,
    },
    web: { workerStaleSec: e.HEALTH_WORKER_STALE_SEC },
    setupComplete: e.MAS_SETUP_COMPLETE,
    envKeys,
  };
}

/** True once the Orion connection has the minimum it needs (host or base URL, user, password). */
export function isSwisConfigured(cfg: SwisConfig): boolean {
  return !!cfg.baseUrl && !!cfg.username && !!cfg.password;
}

/** Extra validation for processes that talk to SWIS (scripts). */
export function assertSwisConfigured(cfg: SwisConfig): void {
  const missing: string[] = [];
  if (!cfg.username) missing.push('SWIS_USERNAME');
  if (!cfg.password) missing.push('SWIS_PASSWORD (or SWIS_PASSWORD_FILE)');
  if (missing.length) throw new ConfigError(`Missing SWIS configuration: ${missing.join(', ')}`);
  if (cfg.writeback.enabled && (!cfg.writeback.username || !cfg.writeback.password)) {
    throw new ConfigError(
      'SWIS_WRITEBACK_ENABLED=true requires SWIS_WRITE_USERNAME and SWIS_WRITE_PASSWORD (a separate write-capable account)',
    );
  }
}
