/** Jobs the web app queues for the worker (pg-boss), with their payload schemas. */
import { z } from 'zod';

export const WRITEBACK_ACK_QUEUE = 'swis.writeback.ack';

/** The groups poll; the web app queues one after a site-group decision so it applies at once. */
export const GROUPS_POLL_QUEUE = 'swis.poll.groups';

export const writebackAckSchema = z.object({
  incidentId: z.number().int().positive(),
  /** Display name of the person who acknowledged in MAS. */
  by: z.string().min(1).max(200),
});
export type WritebackAckJob = z.infer<typeof writebackAckSchema>;

/** A note added to a MAS incident, appended to its active alerts in Orion (AppendNote). */
export const WRITEBACK_NOTE_QUEUE = 'swis.writeback.note';
export const writebackNoteSchema = z.object({
  incidentId: z.number().int().positive(),
  by: z.string().min(1).max(200),
  text: z.string().min(1).max(4000),
});
export type WritebackNoteJob = z.infer<typeof writebackNoteSchema>;

/** Site notes edited in MAS, written to the site's SolarWinds group description. */
export const WRITEBACK_SITE_NOTES_QUEUE = 'swis.writeback.site-notes';
export const writebackSiteNotesSchema = z.object({
  /** Row in site_notes_writes holding the text, the value it replaces, and the outcome. */
  writeId: z.number().int().positive(),
});
export type WritebackSiteNotesJob = z.infer<typeof writebackSiteNotesSchema>;

/** Place a site on the map from its address (Settings → Sites; one lookup per second). */
export const GEOCODE_SITE_QUEUE = 'sites.geocode';
export const geocodeSiteSchema = z.object({ siteId: z.number().int().positive() });
export type GeocodeSiteJob = z.infer<typeof geocodeSiteSchema>;
export interface GeocodeSiteResult {
  status: 'ok' | 'not_found' | 'skipped';
  message: string;
  label?: string;
}

export const NOTIFY_TEST_QUEUE = 'notify.test';

/** Settings → Notifications "Send test": a Teams channel, or one person by SMS or Pushover. */
export const notifyTestSchema = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('teams'), channelKey: z.string().min(1).max(40) }),
    z.object({ kind: z.enum(['sms', 'pushover']), personId: z.number().int().positive() }),
  ]),
  by: z.string().min(1).max(200),
});
export type NotifyTestJob = z.infer<typeof notifyTestSchema>;
export interface NotifyTestResult {
  ok: boolean;
  message: string;
}

export const AI_TEST_QUEUE = 'ai.test';
/** Settings → AI "Test": one tiny call with the saved key and the given model. */
export const aiTestSchema = z.object({
  model: z
    .string()
    .regex(/^claude-[a-z0-9][a-z0-9.-]*$/)
    .optional(),
  by: z.string().min(1).max(200),
});
export type AiTestJob = z.infer<typeof aiTestSchema>;
export interface AiTestResult {
  ok: boolean;
  message: string;
}

export const DIGEST_QUEUES = { daily: 'ai.digest.daily', weekly: 'ai.digest.weekly' } as const;
/** Scheduled by cron; `manual` = Settings → Digests "Send now" (covers the period up to now). */
export const digestRunSchema = z.object({
  manual: z.boolean().optional(),
  by: z.string().max(200).optional(),
});
export type DigestRunJob = z.infer<typeof digestRunSchema>;
export interface DigestRunResult {
  ok: boolean;
  message: string;
  digestId?: number;
}

export const AI_CHAT_QUEUE = 'ai.chat';
/** "Ask the network": answer the pending message `answerId` in thread `threadId`. */
export const chatJobSchema = z.object({
  threadId: z.number().int().positive(),
  answerId: z.number().int().positive(),
});
export type ChatJob = z.infer<typeof chatJobSchema>;
