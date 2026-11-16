import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
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

/** Site Profile. */
export const sites = pgTable('sites', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  divisionCode: text('division_code').references(() => divisions.code, { onUpdate: 'cascade' }),
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
  contactNotes: text('contact_notes'),
  aliases: text('aliases')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  profileStatus: profileStatus('profile_status').notNull().default('auto'),
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
