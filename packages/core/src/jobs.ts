/** Jobs the web app queues for the worker (pg-boss), with their payload schemas. */
import { z } from 'zod';

export const WRITEBACK_ACK_QUEUE = 'swis.writeback.ack';

export const writebackAckSchema = z.object({
  incidentId: z.number().int().positive(),
  /** Display name of the person who acknowledged in MAS. */
  by: z.string().min(1).max(200),
});
export type WritebackAckJob = z.infer<typeof writebackAckSchema>;

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
