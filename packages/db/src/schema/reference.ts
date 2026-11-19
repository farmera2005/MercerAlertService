import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { profileStatus, siteTier } from './enums';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export interface BusinessHours {
  /** ISO weekdays, 1 = Monday … 7 = Sunday */
  days: number[];
  /** "HH:MM" in APP_TIMEZONE */
  start: string;
  end: string;
}

export const divisions = pgTable('divisions', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  isAffiliate: boolean('is_affiliate').notNull().default(false),
  aliases: text('aliases')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  sortOrder: smallint('sort_order').notNull().default(100),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Where a site's map position came from (null: never placed, or placed before addresses). */
export const siteGeoStatus = pgEnum('site_geo_status', [
  'pending',
  'ok',
  'not_found',
  'failed',
  'manual',
]);

/** Site Profile. */
export const sites = pgTable('sites', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  /** Divisions served here (a grain elevator with an agronomy center has two); divisions order. */
  divisionCodes: text('division_codes')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** Street address; the worker places the site on the map from it (or from city and state). */
  address: text('address'),
  city: text('city'),
  state: text('state'),
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),
  /** Pixel coordinates for MAP_MODE=image. */
  mapX: integer('map_x'),
  mapY: integer('map_y'),
  tier: siteTier('tier').notNull().default('standard'),
  harvestCritical: boolean('harvest_critical').notNull().default(false),
  businessHours: jsonb('business_hours')
    .$type<BusinessHours>()
    .notNull()
    .default({ days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' }),
  harvestHours: jsonb('harvest_hours').$type<BusinessHours | null>(),
  ownerGroup: text('owner_group'),
  /** MAS-only notes; a site linked to a SolarWinds group uses the group description instead. */
  contactNotes: text('contact_notes'),
  /** The SolarWinds site group this site corresponds to (SITE_GROUP_PARENT / _PATTERN). */
  orionContainerId: integer('orion_container_id').unique(),
  aliases: text('aliases')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  profileStatus: profileStatus('profile_status').notNull().default('auto'),
  geoStatus: siteGeoStatus('geo_status'),
  /** The text last looked up (or the address when the coordinates were typed). */
  geoQuery: text('geo_query'),
  /** The place the lookup matched, e.g. "Rockford, Mercer County, Ohio, United States". */
  geoLabel: text('geo_label'),
  geoError: text('geo_error'),
  geocodedAt: ts('geocoded_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const nodeSiteOverrides = pgTable('node_site_overrides', {
  nodeId: integer('node_id').primaryKey(),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  divisionCode: text('division_code').references(() => divisions.code, { onUpdate: 'cascade' }),
  deviceRole: text('device_role'),
  reason: text('reason'),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const siteNotesWriteStatus = pgEnum('site_notes_write_status', [
  'pending',
  'ok',
  'conflict',
  'failed',
  'skipped',
]);

/**
 * Site notes edited in MAS for a site linked to a SolarWinds group. The worker writes them to
 * the group description with the write-back account, unless the description changed in
 * SolarWinds since the person loaded it (`base`): then the row ends as `conflict`.
 */
export const siteNotesWrites = pgTable(
  'site_notes_writes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    containerId: integer('container_id').notNull(),
    text: text('text').notNull(),
    base: text('base'),
    requestedBy: text('requested_by').notNull(),
    status: siteNotesWriteStatus('status').notNull().default('pending'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [index('site_notes_writes_site_idx').on(t.siteId, t.createdAt)],
);

export const siteGroupDecision = pgEnum('site_group_decision', ['site', 'not_site']);

/**
 * An admin's decision about one SolarWinds group ("Use as a site" / "Not a site" on Settings →
 * Mapping). It wins over automatic detection and the manual parent/pattern settings.
 */
export const siteGroupDecisions = pgTable('site_group_decisions', {
  containerId: integer('container_id').primaryKey(),
  decision: siteGroupDecision('decision').notNull(),
  /** The group's name when decided, for display if the group later disappears. */
  groupName: text('group_name').notNull(),
  decidedBy: text('decided_by').notNull(),
  decidedAt: ts('decided_at').notNull().defaultNow(),
});
