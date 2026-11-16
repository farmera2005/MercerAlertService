/**
 * Event-bus payloads: the worker sends them with pg_notify on `mas_events`, the web process fans
 * them out over SSE, and browsers refetch what changed. Browser-safe (zod only), exported as
 * `@mercer/core/events` for client components.
 */
import { z } from 'zod';

export const EVENTS_CHANNEL = 'mas_events';

export const busEventSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('poll'),
    poller: z.string(),
    ok: z.boolean(),
    transitions: z.number().int().optional(),
  }),
  z.object({ t: z.literal('source'), status: z.enum(['up', 'down']) }),
  z.object({ t: z.literal('incident'), id: z.number().int(), change: z.string() }),
  z.object({ t: z.literal('heartbeat'), component: z.string() }),
  z.object({ t: z.literal('config') }),
]);
export type BusEvent = z.infer<typeof busEventSchema>;

/** What the SSE endpoint sends: bus events plus its own hello/resync frames. */
export const sseEventSchema = z.union([
  busEventSchema,
  z.object({ t: z.literal('hello'), serverTime: z.string() }),
  /** The web process lost and regained its LISTEN connection: events may have been missed. */
  z.object({ t: z.literal('resync'), serverTime: z.string() }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;

export function parseBusEvent(raw: string): BusEvent | null {
  try {
    const r = busEventSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function parseSseEvent(raw: string): SseEvent | null {
  try {
    const r = sseEventSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
