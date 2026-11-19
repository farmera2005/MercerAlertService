import { z } from 'zod';
import { isGuid, parseEmailList } from '../auth/entra';
import { parseQuietHours } from '../notify/quiet';
import { resolveFileEnv, SECRET_ENV_PREFIXES } from './file-env';

const bool = (def: boolean) => z.stringbool().default(def);
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const str = (def: string) => z.string().default(def);
const num = (def: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(def);

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
  RETENTION_CHAT_DAYS: int(90, 1),
  RETENTION_CRON: str('15 3 * * *'),

  // --- Worker runtime ---
  WORKER_HEALTH_PORT: int(9090, 1),
  WORKER_HEARTBEAT_SEC: int(15, 5),
  DEADMAN_PING_URL: z.string().optional(),

  // --- Web ---
  HEALTH_WORKER_STALE_SEC: int(60, 10),
  /** Believe X-Forwarded-For (from this many proxies, counted from the right). */
  TRUST_PROXY: bool(false),
  TRUST_PROXY_HOPS: int(1, 1),

  // --- Sign-in (Microsoft Entra ID) ---
  ENTRA_TENANT_ID: str(''),
  ENTRA_CLIENT_ID: str(''),
  ENTRA_CLIENT_SECRET: str(''),
  ENTRA_ALLOWED_GROUP_ID: str(''),
  ENTRA_ADMIN_GROUP_ID: str(''),
  /** Comma-separated e-mail addresses that are admins even without the admin group. */
  BOOTSTRAP_ADMIN_EMAILS: str(''),

  // --- Map & wall display ---
  MAP_MODE: z.enum(['tiles', 'image']).default('tiles'),
  MAP_TILE_URL: str('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
  MAP_ATTRIBUTION: str('© OpenStreetMap contributors'),
  WALL_ROTATE_SEC: int(20, 5),
  WALL_SHOW_MAP: bool(true),
  /** Stay on the incident list while any P1 is open. */
  WALL_PIN_P1: bool(true),

  // --- Correlation ---
  CORRELATION_WINDOW_SEC: int(180, 30),
  RESOLVE_HOLDDOWN_SEC: int(300, 0),
  REOPEN_WINDOW_SEC: int(900, 0),
  FLAP_COUNT: int(4, 2),
  FLAP_WINDOW_MIN: int(20, 1),
  /** Pending transitions older than this (e.g. after an upgrade or long outage) are not replayed. */
  CORRELATION_MAX_AGE_SEC: int(3600, 60),
  UPS_ALERT_REGEX: str('battery|utility power|on bypass|\\bups\\b'),

  // --- Priority scoring ---
  SCORING_P1_MIN: int(70, 1),
  SCORING_P2_MIN: int(50, 1),
  SCORING_P3_MIN: int(30, 1),
  SCORING_TIER_CRITICAL: num(1.4, 0.5, 3),
  SCORING_TIER_HIGH: num(1.2, 0.5, 3),
  SCORING_HARVEST_GRAIN_MULT: num(1.2, 1, 3),
  SCORING_AFTER_HOURS_MULT: num(0.8, 0.1, 1),
  RECOVERY_TARGET_HARVEST_MIN: int(240, 15),
  RECOVERY_TARGET_DEFAULT_MIN: int(480, 15),

  // --- Notifications ---
  /** Every message goes to the shadow Teams channel and nobody is paged (pilot / cut-over). */
  NOTIFY_SHADOW_MODE: bool(true),
  NOTIFY_SHADOW_CHANNEL: str('mas-shadow'),
  /** Let shadow mode page the on-call person anyway (to test paging during the pilot). */
  SHADOW_ALLOW_PAGING: bool(false),
  /** "22:00-06:00" in APP_TIMEZONE; empty = no quiet hours. */
  NOTIFY_QUIET_HOURS: str(''),
  NOTIFY_QUIET_MIN_PRIORITY: z.enum(['P1', 'P2', 'P3', 'P4']).default('P2'),
  ESCALATE_AFTER_MIN: int(15, 1),
  PAGE_RATE_LIMIT_PER_15MIN: int(5, 1),
  ONCALL_HANDOFF_DAY: z.coerce.number().int().min(1).max(7).default(1),
  ONCALL_HANDOFF_TIME: str('08:00'),
  NOTIFY_SELF_ALERT_CHANNEL: str('net-critical'),
  /** Accept http:// webhook URLs (a local mock only; real Teams webhooks are https). */
  NOTIFY_ALLOW_HTTP: bool(false),
  TWILIO_ACCOUNT_SID: str(''),
  TWILIO_AUTH_TOKEN: str(''),
  /** E.164 number (+1419…) or a Messaging Service SID (MG…). */
  TWILIO_FROM: str(''),
  TWILIO_API_BASE: str('https://api.twilio.com'),
  PUSHOVER_APP_TOKEN: str(''),
  PUSHOVER_API_BASE: str('https://api.pushover.net'),

  // --- AI (Claude): enrichment only, never on the critical path ---
  ANTHROPIC_API_KEY: str(''),
  /** Only a local mock changes this. */
  ANTHROPIC_BASE_URL: str('https://api.anthropic.com'),
  /** Master switch; AI also stays off while no API key is set. */
  AI_ENABLED: bool(true),
  AI_MODEL_FAST: str('claude-haiku-5-5'),
  AI_MODEL_STRONG: str('claude-opus-5-5'),
  /** Per-task overrides; empty = AI_MODEL_FAST (severity) or AI_MODEL_STRONG (the others). */
  AI_MODEL_SEVERITY: str(''),
  AI_MODEL_SUMMARY: str(''),
  AI_MODEL_DIGEST: str(''),
  AI_MODEL_CHAT: str(''),
  /** "Ask the network" in the dashboard (needs AI). */
  AI_CHAT_ENABLED: bool(true),
  /** Questions per person per hour. */
  AI_CHAT_PER_HOUR: int(30, 1),
  /** Replace IPs, MACs and serial numbers with placeholders before anything is sent (E1). */
  AI_REDACT: bool(true),
  AI_DAILY_BUDGET_USD: num(5, 0, 10_000),
  AI_TIMEOUT_SEC: int(90, 10),
  /** Wait this long after a change before summarizing, so a storm yields one summary. */
  AI_SUMMARY_DEBOUNCE_SEC: int(45, 0),
  /** apply: the guarded ±1 step changes priority · suggest: shown only · off: not asked. */
  AI_PRIORITY_MODE: z.enum(['apply', 'suggest', 'off']).default('apply'),
  /** Post one follow-up Teams card when the first AI summary of an incident is ready. */
  AI_POST_SUMMARY_UPDATE: bool(true),
  /** Free text about the network added to every prompt (equipment, circuits, contacts). */
  AI_ENVIRONMENT_NOTES: str(''),

  // --- Digests ---
  DIGEST_ENABLED: bool(true),
  DIGEST_DAILY_CRON: str('0 7 * * *'),
  DIGEST_WEEKLY_CRON: str('30 7 * * 1'),
  DIGEST_CHANNEL: str('net-digest'),

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
    chatDays: number;
    cron: string;
  };
  worker: { healthPort: number; heartbeatSec: number; deadmanPingUrl?: string };
  web: { workerStaleSec: number; trustProxy: boolean; trustProxyHops: number };
  auth: {
    /** Null until tenant, client, secret and allowed group are all set. */
    entra: {
      tenantId: string;
      clientId: string;
      clientSecret: string;
      allowedGroupId: string;
      adminGroupId: string;
      bootstrapAdminEmails: string[];
    } | null;
  };
  map: { mode: 'tiles' | 'image'; tileUrl: string; attribution: string };
  notify: {
    shadow: { enabled: boolean; channelKey: string; allowPaging: boolean };
    quiet: {
      window: { start: string; end: string } | null;
      minPriority: 'P1' | 'P2' | 'P3' | 'P4';
    };
    escalateAfterMin: number;
    pageRateLimit: number;
    handoff: { isoWeekday: number; time: string };
    selfAlertChannel: string;
    allowHttp: boolean;
    /** Null until SID, token and sender are all set. */
    twilio: { accountSid: string; authToken: string; from: string; apiBase: string } | null;
    pushover: { appToken: string; apiBase: string } | null;
  };
  wall: { rotateSec: number; showMap: boolean; pinP1: boolean };
  ai: {
    /** AI_ENABLED and an API key is set. */
    enabled: boolean;
    apiKey: string;
    baseUrl: string;
    models: { severity: string; summary: string; digest: string; chat: string };
    chat: { enabled: boolean; perHour: number };
    redact: boolean;
    dailyBudgetUsd: number;
    timeoutMs: number;
    summaryDebounceSec: number;
    priorityMode: 'apply' | 'suggest' | 'off';
    postSummaryUpdate: boolean;
    environmentNotes: string;
  };
  digest: { enabled: boolean; dailyCron: string; weeklyCron: string; channelKey: string };
  correlation: {
    windowSec: number;
    holddownSec: number;
    reopenWindowSec: number;
    flapCount: number;
    flapWindowMin: number;
    maxAgeSec: number;
    upsAlertRegex: string;
  };
  scoring: {
    p1Min: number;
    p2Min: number;
    p3Min: number;
    tierCritical: number;
    tierHigh: number;
    harvestGrainMult: number;
    afterHoursMult: number;
    recoveryHarvestMin: number;
    recoveryDefaultMin: number;
  };
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
  if (!(e.SCORING_P1_MIN > e.SCORING_P2_MIN && e.SCORING_P2_MIN > e.SCORING_P3_MIN)) {
    const err = new ConfigError('Priority thresholds must satisfy P1 > P2 > P3');
    err.issues = [{ key: 'SCORING_P2_MIN', message: 'P1 > P2 > P3 is required' }];
    throw err;
  }
  try {
    new RegExp(e.UPS_ALERT_REGEX, 'i');
  } catch {
    const err = new ConfigError('UPS_ALERT_REGEX is not a valid regular expression');
    err.issues = [{ key: 'UPS_ALERT_REGEX', message: 'not a valid regular expression' }];
    throw err;
  }
  const entraFields = [
    e.ENTRA_TENANT_ID,
    e.ENTRA_CLIENT_ID,
    e.ENTRA_CLIENT_SECRET,
    e.ENTRA_ALLOWED_GROUP_ID,
  ];
  if (entraFields.some(Boolean)) {
    const issues: ConfigIssue[] = [];
    if (!e.ENTRA_TENANT_ID)
      issues.push({ key: 'ENTRA_TENANT_ID', message: 'required for Microsoft sign-in' });
    else if (!isGuid(e.ENTRA_TENANT_ID) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(e.ENTRA_TENANT_ID))
      issues.push({ key: 'ENTRA_TENANT_ID', message: 'use the Directory (tenant) ID, a GUID' });
    if (!e.ENTRA_CLIENT_ID)
      issues.push({ key: 'ENTRA_CLIENT_ID', message: 'required for Microsoft sign-in' });
    else if (!isGuid(e.ENTRA_CLIENT_ID))
      issues.push({ key: 'ENTRA_CLIENT_ID', message: 'use the Application (client) ID, a GUID' });
    if (!e.ENTRA_CLIENT_SECRET)
      issues.push({ key: 'ENTRA_CLIENT_SECRET', message: 'required for Microsoft sign-in' });
    if (!e.ENTRA_ALLOWED_GROUP_ID)
      issues.push({
        key: 'ENTRA_ALLOWED_GROUP_ID',
        message: 'required: only this group may sign in',
      });
    else if (!isGuid(e.ENTRA_ALLOWED_GROUP_ID))
      issues.push({ key: 'ENTRA_ALLOWED_GROUP_ID', message: 'use the group’s Object ID, a GUID' });
    if (e.ENTRA_ADMIN_GROUP_ID && !isGuid(e.ENTRA_ADMIN_GROUP_ID))
      issues.push({ key: 'ENTRA_ADMIN_GROUP_ID', message: 'use the group’s Object ID, a GUID' });
    if (issues.length) {
      const err = new ConfigError(
        `Microsoft sign-in settings are incomplete: ${issues.map((i) => i.key).join(', ')}`,
      );
      err.issues = issues;
      throw err;
    }
  }
  if (
    !/^https?:\/\//.test(e.MAP_TILE_URL) ||
    !['{z}', '{x}', '{y}'].every((p) => e.MAP_TILE_URL.includes(p))
  ) {
    const err = new ConfigError('MAP_TILE_URL must be an http(s) URL containing {z}, {x} and {y}');
    err.issues = [{ key: 'MAP_TILE_URL', message: 'an http(s) URL with {z}, {x} and {y}' }];
    throw err;
  }
  const fail = (key: string, message: string): never => {
    const err = new ConfigError(`${key}: ${message}`);
    err.issues = [{ key, message }];
    throw err;
  };
  let quietWindow: { start: string; end: string } | null = null;
  try {
    quietWindow = parseQuietHours(e.NOTIFY_QUIET_HOURS);
  } catch (err) {
    fail('NOTIFY_QUIET_HOURS', (err as Error).message);
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.ONCALL_HANDOFF_TIME))
    fail('ONCALL_HANDOFF_TIME', 'use HH:MM, e.g. 08:00');
  const twilioParts = [e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN, e.TWILIO_FROM];
  if (twilioParts.some(Boolean)) {
    if (!/^AC[0-9a-f]{32}$/i.test(e.TWILIO_ACCOUNT_SID))
      fail('TWILIO_ACCOUNT_SID', 'the Account SID starts with AC followed by 32 characters');
    if (!e.TWILIO_AUTH_TOKEN) fail('TWILIO_AUTH_TOKEN', 'required for Twilio');
    if (!/^(\+[1-9]\d{7,14}|MG[0-9a-f]{32})$/i.test(e.TWILIO_FROM))
      fail('TWILIO_FROM', 'an E.164 number (+14195550100) or a Messaging Service SID (MG…)');
  }
  for (const key of ['TWILIO_API_BASE', 'PUSHOVER_API_BASE', 'ANTHROPIC_BASE_URL'] as const)
    if (!/^https?:\/\//.test(e[key])) fail(key, 'an http(s) URL');
  for (const key of [
    'AI_MODEL_FAST',
    'AI_MODEL_STRONG',
    'AI_MODEL_SEVERITY',
    'AI_MODEL_SUMMARY',
    'AI_MODEL_DIGEST',
    'AI_MODEL_CHAT',
  ] as const)
    if (e[key] && !/^claude-[a-z0-9][a-z0-9.-]*$/.test(e[key]))
      fail(key, 'a Claude model ID such as claude-opus-5-5');
  if (e.ANTHROPIC_API_KEY && /\s/.test(e.ANTHROPIC_API_KEY))
    fail('ANTHROPIC_API_KEY', 'the key must not contain spaces or line breaks');
  for (const key of ['DIGEST_DAILY_CRON', 'DIGEST_WEEKLY_CRON', 'RETENTION_CRON'] as const)
    if (e[key].trim().split(/\s+/).length !== 5)
      fail(key, 'a 5-field cron expression, e.g. 0 7 * * *');
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(e.DIGEST_CHANNEL))
    fail('DIGEST_CHANNEL', 'a Teams channel key such as net-digest');
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
      chatDays: e.RETENTION_CHAT_DAYS,
      cron: e.RETENTION_CRON,
    },
    worker: {
      healthPort: e.WORKER_HEALTH_PORT,
      heartbeatSec: e.WORKER_HEARTBEAT_SEC,
      deadmanPingUrl: e.DEADMAN_PING_URL,
    },
    web: {
      workerStaleSec: e.HEALTH_WORKER_STALE_SEC,
      trustProxy: e.TRUST_PROXY,
      trustProxyHops: e.TRUST_PROXY_HOPS,
    },
    auth: {
      entra: e.ENTRA_CLIENT_ID
        ? {
            tenantId: e.ENTRA_TENANT_ID,
            clientId: e.ENTRA_CLIENT_ID,
            clientSecret: e.ENTRA_CLIENT_SECRET,
            allowedGroupId: e.ENTRA_ALLOWED_GROUP_ID,
            adminGroupId: e.ENTRA_ADMIN_GROUP_ID,
            bootstrapAdminEmails: parseEmailList(e.BOOTSTRAP_ADMIN_EMAILS),
          }
        : null,
    },
    map: { mode: e.MAP_MODE, tileUrl: e.MAP_TILE_URL, attribution: e.MAP_ATTRIBUTION },
    notify: {
      shadow: {
        enabled: e.NOTIFY_SHADOW_MODE,
        channelKey: e.NOTIFY_SHADOW_CHANNEL,
        allowPaging: e.SHADOW_ALLOW_PAGING,
      },
      quiet: { window: quietWindow, minPriority: e.NOTIFY_QUIET_MIN_PRIORITY },
      escalateAfterMin: e.ESCALATE_AFTER_MIN,
      pageRateLimit: e.PAGE_RATE_LIMIT_PER_15MIN,
      handoff: { isoWeekday: e.ONCALL_HANDOFF_DAY, time: e.ONCALL_HANDOFF_TIME },
      selfAlertChannel: e.NOTIFY_SELF_ALERT_CHANNEL,
      allowHttp: e.NOTIFY_ALLOW_HTTP,
      twilio: e.TWILIO_ACCOUNT_SID
        ? {
            accountSid: e.TWILIO_ACCOUNT_SID,
            authToken: e.TWILIO_AUTH_TOKEN,
            from: e.TWILIO_FROM,
            apiBase: e.TWILIO_API_BASE.replace(/\/+$/, ''),
          }
        : null,
      pushover: e.PUSHOVER_APP_TOKEN
        ? { appToken: e.PUSHOVER_APP_TOKEN, apiBase: e.PUSHOVER_API_BASE.replace(/\/+$/, '') }
        : null,
    },
    wall: { rotateSec: e.WALL_ROTATE_SEC, showMap: e.WALL_SHOW_MAP, pinP1: e.WALL_PIN_P1 },
    ai: {
      enabled: e.AI_ENABLED && !!e.ANTHROPIC_API_KEY,
      apiKey: e.ANTHROPIC_API_KEY,
      baseUrl: e.ANTHROPIC_BASE_URL.replace(/\/+$/, ''),
      models: {
        severity: e.AI_MODEL_SEVERITY || e.AI_MODEL_FAST,
        summary: e.AI_MODEL_SUMMARY || e.AI_MODEL_STRONG,
        digest: e.AI_MODEL_DIGEST || e.AI_MODEL_STRONG,
        chat: e.AI_MODEL_CHAT || e.AI_MODEL_STRONG,
      },
      chat: { enabled: e.AI_CHAT_ENABLED, perHour: e.AI_CHAT_PER_HOUR },
      redact: e.AI_REDACT,
      dailyBudgetUsd: e.AI_DAILY_BUDGET_USD,
      timeoutMs: e.AI_TIMEOUT_SEC * 1000,
      summaryDebounceSec: e.AI_SUMMARY_DEBOUNCE_SEC,
      priorityMode: e.AI_PRIORITY_MODE,
      postSummaryUpdate: e.AI_POST_SUMMARY_UPDATE,
      environmentNotes: e.AI_ENVIRONMENT_NOTES,
    },
    digest: {
      enabled: e.DIGEST_ENABLED,
      dailyCron: e.DIGEST_DAILY_CRON.trim(),
      weeklyCron: e.DIGEST_WEEKLY_CRON.trim(),
      channelKey: e.DIGEST_CHANNEL,
    },
    correlation: {
      windowSec: e.CORRELATION_WINDOW_SEC,
      holddownSec: e.RESOLVE_HOLDDOWN_SEC,
      reopenWindowSec: e.REOPEN_WINDOW_SEC,
      flapCount: e.FLAP_COUNT,
      flapWindowMin: e.FLAP_WINDOW_MIN,
      maxAgeSec: e.CORRELATION_MAX_AGE_SEC,
      upsAlertRegex: e.UPS_ALERT_REGEX,
    },
    scoring: {
      p1Min: e.SCORING_P1_MIN,
      p2Min: e.SCORING_P2_MIN,
      p3Min: e.SCORING_P3_MIN,
      tierCritical: e.SCORING_TIER_CRITICAL,
      tierHigh: e.SCORING_TIER_HIGH,
      harvestGrainMult: e.SCORING_HARVEST_GRAIN_MULT,
      afterHoursMult: e.SCORING_AFTER_HOURS_MULT,
      recoveryHarvestMin: e.RECOVERY_TARGET_HARVEST_MIN,
      recoveryDefaultMin: e.RECOVERY_TARGET_DEFAULT_MIN,
    },
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
