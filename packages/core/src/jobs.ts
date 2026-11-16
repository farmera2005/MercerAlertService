/** Jobs the web app queues for the worker (pg-boss), with their payload schemas. */
import { z } from 'zod';

export const WRITEBACK_ACK_QUEUE = 'swis.writeback.ack';

export const writebackAckSchema = z.object({
  incidentId: z.number().int().positive(),
  /** Display name of the person who acknowledged in MAS. */
  by: z.string().min(1).max(200),
});
export type WritebackAckJob = z.infer<typeof writebackAckSchema>;
