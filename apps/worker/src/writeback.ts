import {
  createLogger,
  errorMessage,
  writebackAckSchema,
  type AppConfig,
  type Logger,
} from '@mercer/core';
import {
  activeOrionAlertObjects,
  addIncidentSystemEvent,
  publishEvent,
  writeAudit,
  type Db,
} from '@mercer/db';
import { SwisClient } from '@mercer/swis';

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
  if (!wb.enabled || !wb.username || !wb.password) {
    log.info({ incidentId: job.incidentId }, 'Orion write-back is off; nothing to do');
    return { acknowledged: 0 };
  }
  const objects = await activeOrionAlertObjects(db, job.incidentId);
  if (objects.length === 0) return { acknowledged: 0 };
  const ids = objects.map((o) => o.alertObjectId);
  const client = new SwisClient({
    baseUrl: cfg.swis.baseUrl,
    username: wb.username,
    password: wb.password,
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
