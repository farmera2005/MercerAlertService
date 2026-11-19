import {
  createLogger,
  errorMessage,
  writebackAckSchema,
  writebackNoteSchema,
  writebackSiteNotesSchema,
  type AppConfig,
  type Logger,
} from '@mercer/core';
import {
  activeOrionAlertObjects,
  addIncidentSystemEvent,
  finishSiteNotesWrite,
  getSiteNotesWrite,
  publishEvent,
  setGroupMirrorDescription,
  writeAudit,
  type Db,
} from '@mercer/db';
import { SwisClient, WRITEBACK } from '@mercer/swis';

/** A client on the separate write-capable account; no retries (a write must not repeat). */
function writebackClient(cfg: AppConfig): SwisClient {
  const wb = cfg.swis.writeback;
  return new SwisClient({
    baseUrl: cfg.swis.baseUrl,
    username: wb.username!,
    password: wb.password!,
    caCertPath: cfg.swis.caCertPath,
    caCertPem: cfg.swis.caCertPem,
    tlsServername: cfg.swis.tlsServername,
    insecureSkipVerify: cfg.swis.insecureSkipVerify,
    timeoutMs: cfg.swis.timeoutMs,
    maxRetries: 0,
    retryBaseMs: cfg.swis.retryBaseMs,
    retryMaxMs: cfg.swis.retryMaxMs,
    breakerThreshold: 1000,
    breakerCooldownMs: cfg.swis.breakerCooldownMs,
    userAgent: `MercerAlertService/${cfg.version}`,
    logger: createLogger('swis-writeback'),
  });
}

const writebackOn = (cfg: AppConfig) =>
  cfg.swis.writeback.enabled && !!cfg.swis.writeback.username && !!cfg.swis.writeback.password;

/**
 * Optional write-back: acknowledge an incident's active alerts in Orion with the separate
 * write-capable account (Orion.AlertActive.Acknowledge). Off unless SWIS_WRITEBACK_ENABLED.
 * Errors propagate so pg-boss retries; each failure is also put on the incident timeline.
 */
export async function runWritebackAck(
  raw: unknown,
  cfg: AppConfig,
  db: Db,
  log: Logger,
): Promise<{ acknowledged: number }> {
  const job = writebackAckSchema.parse(raw);
  const wb = cfg.swis.writeback;
  if (!writebackOn(cfg)) {
    log.info({ incidentId: job.incidentId }, 'Orion write-back is off; nothing to do');
    return { acknowledged: 0 };
  }
  const objects = await activeOrionAlertObjects(db, job.incidentId);
  if (objects.length === 0) return { acknowledged: 0 };
  const ids = objects.map((o) => o.alertObjectId);
  const client = writebackClient(cfg);
  const note = `Acknowledged in MercerAlertService by ${job.by} (INC-${job.incidentId})`;
  try {
    await client.invoke('Orion.AlertActive', 'Acknowledge', [ids, note]);
  } catch (err) {
    await addIncidentSystemEvent(db, job.incidentId, {
      type: 'orion_ack_failed',
      message: `Could not acknowledge in Orion: ${errorMessage(err)}`,
    });
    throw err;
  } finally {
    await client.close();
  }
  await db.transaction(async (tx) => {
    await addIncidentSystemEvent(tx, job.incidentId, {
      type: 'orion_ack',
      message: `Acknowledged ${ids.length} alert${ids.length === 1 ? '' : 's'} in Orion`,
      details: { alertObjectIds: ids },
    });
    await writeAudit(tx, {
      actorType: 'system',
      actorLabel: `writeback:${wb.username}`,
      action: 'orion.writeback.ack',
      targetType: 'incident',
      targetId: job.incidentId,
      after: { alertObjectIds: ids, onBehalfOf: job.by },
    });
    await publishEvent(tx, { t: 'incident', id: job.incidentId, change: 'orion_ack' });
  });
  log.info({ incidentId: job.incidentId, alerts: ids.length }, 'acknowledged alerts in Orion');
  return { acknowledged: ids.length };
}

/**
 * A note added to a MAS incident, appended to its active alerts in Orion
 * (Orion.AlertActive.AppendNote), so the alert's history in SolarWinds shows it too.
 */
export async function runWritebackNote(
  raw: unknown,
  cfg: AppConfig,
  db: Db,
  log: Logger,
): Promise<{ alerts: number }> {
  const job = writebackNoteSchema.parse(raw);
  if (!writebackOn(cfg)) return { alerts: 0 };
  const objects = await activeOrionAlertObjects(db, job.incidentId);
  if (objects.length === 0) {
    log.info({ incidentId: job.incidentId }, 'no active Orion alerts left for the note');
    return { alerts: 0 };
  }
  const ids = objects.map((o) => o.alertObjectId);
  const note = `${job.text}\n— ${job.by} in MercerAlertService (INC-${job.incidentId})`;
  const client = writebackClient(cfg);
  try {
    await client.invoke('Orion.AlertActive', 'AppendNote', [ids, note]);
  } catch (err) {
    await addIncidentSystemEvent(db, job.incidentId, {
      type: 'orion_note_failed',
      message: `Could not add the note to the alerts in Orion: ${errorMessage(err)}`,
    });
    throw err;
  } finally {
    await client.close();
  }
  await db.transaction(async (tx) => {
    await addIncidentSystemEvent(tx, job.incidentId, {
      type: 'orion_note',
      message: `Note added to ${ids.length} alert${ids.length === 1 ? '' : 's'} in Orion`,
      details: { alertObjectIds: ids },
    });
    await writeAudit(tx, {
      actorType: 'system',
      actorLabel: `writeback:${cfg.swis.writeback.username}`,
      action: 'orion.writeback.note',
      targetType: 'incident',
      targetId: job.incidentId,
      after: { alertObjectIds: ids, onBehalfOf: job.by },
    });
    await publishEvent(tx, { t: 'incident', id: job.incidentId, change: 'orion_note' });
  });
  return { alerts: ids.length };
}

/** Compare descriptions the way people see them (Orion may store \r\n and trailing spaces). */
const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').replace(/\r\n/g, '\n').trim() === (b ?? '').replace(/\r\n/g, '\n').trim();

/**
 * Site notes edited in MAS → the description of the site's SolarWinds group. Refuses to
 * overwrite a description that changed in SolarWinds since the person loaded it. Never retried:
 * the outcome is stored on the write and shown next to the notes; saving again is the retry.
 */
export async function runWritebackSiteNotes(
  raw: unknown,
  cfg: AppConfig,
  db: Db,
  log: Logger,
): Promise<{ status: string }> {
  const job = writebackSiteNotesSchema.parse(raw);
  const w = await getSiteNotesWrite(db, job.writeId);
  if (!w || w.status !== 'pending') return { status: 'gone' };
  const done = async (status: 'ok' | 'conflict' | 'failed' | 'skipped', error: string | null) => {
    await finishSiteNotesWrite(db, w.id, status, error);
    // Pages showing the site refresh on a poll event with changes.
    await publishEvent(db, { t: 'poll', poller: 'groups', ok: true, transitions: 1 });
    return { status };
  };
  if (!writebackOn(cfg))
    return done('skipped', 'Orion write-back is off (Settings → SolarWinds → Orion write-back).');
  const client = writebackClient(cfg);
  try {
    const read = async () =>
      (
        await client.query<{ Description?: string | null; Uri?: string | null }>(
          WRITEBACK.groupById,
          { id: w.containerId },
          { label: 'groupById', retries: 0 },
        )
      )[0];
    const current = await read();
    if (!current) return await done('failed', 'The SolarWinds group no longer exists.');
    if (!sameText(current.Description, w.base)) {
      await setGroupMirrorDescription(db, w.containerId, current.Description ?? null);
      return await done(
        'conflict',
        'The notes were changed in SolarWinds after you opened them, so yours were not saved. Their current text is shown; make your change again.',
      );
    }
    const uri = current.Uri ?? w.groupUri;
    if (!uri) return await done('failed', 'SolarWinds did not return the group address.');
    await client.update(uri, { Description: w.text }, { label: 'groupDescription' });
    const after = await read();
    await db.transaction(async (tx) => {
      await setGroupMirrorDescription(tx, w.containerId, after?.Description ?? w.text);
      await writeAudit(tx, {
        actorType: 'system',
        actorLabel: `writeback:${cfg.swis.writeback.username}`,
        action: 'orion.writeback.site_notes',
        targetType: 'site',
        targetId: w.siteId,
        after: { containerId: w.containerId, onBehalfOf: w.requestedBy },
      });
    });
    log.info({ siteId: w.siteId, containerId: w.containerId }, 'site notes saved to SolarWinds');
    return await done('ok', null);
  } catch (err) {
    log.warn(
      { siteId: w.siteId, err: errorMessage(err) },
      'could not save site notes to SolarWinds',
    );
    return await done('failed', `SolarWinds refused the change: ${errorMessage(err)}`);
  } finally {
    await client.close();
  }
}
