import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Local administrator accounts: created in the first-run setup wizard, used before Entra ID SSO
 * is configured and afterwards as break-glass access.
 */
export const localAccounts = pgTable('local_accounts', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastLoginAt: ts('last_login_at'),
  disabledAt: ts('disabled_at'),
  /** Authenticator-app secret, sealed with SecretBox ("v1:…"). Null: no authenticator app. */
  totpSecret: text('totp_secret'),
  totpEnabledAt: ts('totp_enabled_at'),
  /** The last time step used to sign in: a code works only once. */
  totpLastStep: integer('totp_last_step'),
});

/** One-time recovery codes for two-step sign-in. Only a SHA-256 of each code is stored. */
export const accountRecoveryCodes = pgTable(
  'account_recovery_codes',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => localAccounts.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    usedAt: ts('used_at'),
  },
  (t) => [unique('account_recovery_codes_uq').on(t.accountId, t.codeHash)],
);

/** Passkeys and security keys (WebAuthn) of local accounts, as the second sign-in step. */
export const accountPasskeys = pgTable(
  'account_passkeys',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => localAccounts.id, { onDelete: 'cascade' }),
    /** base64url credential ID. */
    credentialId: text('credential_id').notNull().unique(),
    /** COSE public key. */
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The address (WebAuthn RP ID) it was made on; it only works there. */
    rpId: text('rp_id').notNull(),
    name: text('name').notNull(),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('account_passkeys_account_idx').on(t.accountId)],
);

/**
 * Short-lived steps between the password and a session (kind 'sign_in'), and setups in progress
 * ('totp_setup', 'passkey_add'). Only the SHA-256 of the token is stored.
 */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: text('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => localAccounts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** The WebAuthn challenge for a passkey ceremony in progress. */
    webauthnChallenge: text('webauthn_challenge'),
    /** kind-specific: { next } for sign_in, { sealedSecret } for totp_setup. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('auth_challenges_expires_idx').on(t.expiresAt)],
);

/** Browser sessions. Only the SHA-256 of the cookie token is stored. */
export const webSessions = pgTable(
  'web_sessions',
  {
    id: text('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => localAccounts.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('web_sessions_account_idx').on(t.accountId),
    index('web_sessions_expires_idx').on(t.expiresAt),
  ],
);

/** People who signed in with Microsoft Entra ID (created on first sign-in). */
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  entraOid: text('entra_oid').notNull().unique(),
  email: text('email').notNull().default(''),
  name: text('name').notNull(),
  /** Re-evaluated from group membership at every sign-in. */
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastLoginAt: ts('last_login_at'),
  disabledAt: ts('disabled_at'),
});

/**
 * Wall-display (kiosk) links. Only the SHA-256 of the token is stored; the URL is shown once when
 * created or rotated.
 */
export const kioskTokens = pgTable(
  'kiosk_tokens',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** First characters of the token, so admins can tell links apart. */
    tokenPrefix: text('token_prefix').notNull(),
    allowedCidrs: text('allowed_cidrs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    rotatedAt: ts('rotated_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    revokedBy: text('revoked_by'),
    lastUsedAt: ts('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    /** NOC boards the screen rotates through ('mission', 'custom:3', …); empty: the classic wall. */
    boards: text('boards')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Seconds per board (null: WALL_ROTATE_SEC). */
    boardRotateSec: integer('board_rotate_sec'),
  },
  (t) => [index('kiosk_tokens_active_idx').on(t.revokedAt)],
);

/** Uploaded files that belong to settings, e.g. the offline map background (MAP_MODE=image). */
export const settingAssets = pgTable('setting_assets', {
  key: text('key').primaryKey(),
  contentType: text('content_type').notNull(),
  data: bytea('data').notNull(),
  width: integer('width'),
  height: integer('height'),
  sha256: text('sha256').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
