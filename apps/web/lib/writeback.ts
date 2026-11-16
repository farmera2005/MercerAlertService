import 'server-only';
import { errorMessage, WRITEBACK_ACK_QUEUE, type WritebackAckJob } from '@mercer/core';
import { enqueueWorkerJob } from './jobs';
import { server } from './server';
import { effectiveConfig } from './settings';

/**
 * Optional Orion write-back: when enabled, ask the worker to acknowledge the incident's active
 * alerts in Orion too. Fire-and-forget; the result lands on the incident timeline.
 */
export async function requestOrionAck(incidentId: number, by: string): Promise<string | null> {
  const cfg = await effectiveConfig();
  if (!cfg.swis.writeback.enabled) return null;
  try {
    const job: WritebackAckJob = { incidentId, by };
    await enqueueWorkerJob(WRITEBACK_ACK_QUEUE, job);
    return 'Acknowledging the alerts in Orion as well.';
  } catch (err) {
    server().log.warn({ err: errorMessage(err), incidentId }, 'could not queue Orion write-back');
    return 'Could not ask the worker to acknowledge in Orion; acknowledge there manually.';
  }
}
