import { jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import type { BoardDefinition } from '@mercer/core/noc';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Boards admins compose in Settings → NOC boards (the four built-in boards live in code). */
export const nocBoards = pgTable('noc_boards', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  /** Widgets on the 12 × 8 grid and the board's site filters (boardDefinitionSchema). */
  definition: jsonb('definition').$type<BoardDefinition>().notNull(),
  createdBy: text('created_by').notNull(),
  updatedBy: text('updated_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
