import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

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
});

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
  },
  (t) => [index('kiosk_tokens_active_idx').on(t.revokedAt)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

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
