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

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(10, 1),

  // --- SWIS ---
  SWIS_HOST: str('orion.mercer.local'),
  SWIS_PORT: int(17774, 1),
  /** Full override, e.g. http://mock-swis:17774 for local dev. Wins over SWIS_HOST/PORT. */
  SWIS_BASE_URL: z.string().optional(),
  SWIS_USERNAME: str(''),
  SWIS_PASSWORD: str(''),
  SWIS_CA_CERT_PATH: z.string().optional(),
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
});

export type RawEnv = z.infer<typeof envSchema>;

export interface SwisConfig {
  baseUrl: string;
  username: string;
  password: string;
  caCertPath?: string;
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
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function assertTimezone(tz: string, key: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ConfigError(`${key}="${tz}" is not a valid IANA time zone`);
  }
}

/** Parse and validate configuration from env (with *_FILE secrets). Throws ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const known = (k: string) =>
    k in envSchema.shape || SECRET_ENV_PREFIXES.some((p) => k.startsWith(p));
  const parsed = envSchema.safeParse(resolveFileEnv(env, known));
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  assertTimezone(e.APP_TIMEZONE, 'APP_TIMEZONE');
  assertTimezone(e.SWIS_NAIVE_TIMEZONE, 'SWIS_NAIVE_TIMEZONE');
  if (e.SITE_FROM_CAPTION_REGEX) {
    try {
      new RegExp(e.SITE_FROM_CAPTION_REGEX);
    } catch {
      throw new ConfigError(`SITE_FROM_CAPTION_REGEX is not a valid regular expression`);
    }
  }
  const baseUrl = (e.SWIS_BASE_URL ?? `https://${e.SWIS_HOST}:${e.SWIS_PORT}`).replace(/\/+$/, '');

  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    timezone: e.APP_TIMEZONE,
    baseUrl: e.APP_BASE_URL.replace(/\/+$/, ''),
    version: e.APP_VERSION,
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    swis: {
      baseUrl,
      username: e.SWIS_USERNAME,
      password: e.SWIS_PASSWORD,
      caCertPath: e.SWIS_CA_CERT_PATH,
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
  };
}

/** Extra validation for processes that talk to SWIS (worker, scripts). */
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
