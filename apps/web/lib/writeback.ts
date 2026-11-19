import 'server-only';
import {
  errorMessage,
  WRITEBACK_ACK_QUEUE,
  WRITEBACK_NOTE_QUEUE,
  WRITEBACK_SITE_NOTES_QUEUE,
  type WritebackAckJob,
  type WritebackNoteJob,
  type WritebackSiteNotesJob,
} from '@mercer/core';
import { finishSiteNotesWrite, requestSiteNotesWrite, type Actor } from '@mercer/db';
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

/** A note on a MAS incident: also append it to the incident's active alerts in Orion. */
export async function requestOrionNote(
  incidentId: number,
  by: string,
  text: string,
): Promise<string | null> {
  const cfg = await effectiveConfig();
  if (!cfg.swis.writeback.enabled) return null;
  try {
    const job: WritebackNoteJob = { incidentId, by, text: text.slice(0, 4000) };
    await enqueueWorkerJob(WRITEBACK_NOTE_QUEUE, job);
    return 'Adding it to the alerts in Orion as well.';
  } catch (err) {
    server().log.warn({ err: errorMessage(err), incidentId }, 'could not queue Orion note');
    return 'Could not ask the worker to add the note in Orion.';
  }
}

/**
 * Site notes of a site linked to a SolarWinds group: record the edit (audited) and ask the worker
 * to write it to the group description. `base` is the description the form was loaded with.
 */
export async function requestSiteNotesSave(
  siteId: number,
  text: string,
  base: string | null,
  actor: Actor,
): Promise<{ ok: boolean; message: string }> {
  const cfg = await effectiveConfig();
  if (!cfg.swis.writeback.enabled)
    return {
      ok: false,
      message:
        'Notes not saved: they live in SolarWinds. Turn on Orion write-back (Settings → SolarWinds) or edit the group description in SolarWinds.',
    };
  const { db, log } = server();
  const r = await requestSiteNotesWrite(db.db, { siteId, text, base }, actor);
  if (!r.ok) return { ok: false, message: r.error };
  try {
    const job: WritebackSiteNotesJob = { writeId: r.writeId };
    await enqueueWorkerJob(WRITEBACK_SITE_NOTES_QUEUE, job);
    return { ok: true, message: 'Saving the notes to SolarWinds…' };
  } catch (err) {
    log.warn({ err: errorMessage(err), siteId }, 'could not queue site notes write');
    await finishSiteNotesWrite(db.db, r.writeId, 'failed', 'The worker could not be reached.');
    return { ok: false, message: 'Could not ask the worker to save the notes; try again.' };
  }
}
