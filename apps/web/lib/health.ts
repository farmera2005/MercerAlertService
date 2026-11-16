import 'server-only';
import { listHeartbeats, listPollerStates } from '@mercer/db';
import { server } from './server';
import { getSettingsState } from './settings';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down' | 'setup_required';
  checkedAt: string;
  db: 'ok' | 'error';
  worker: {
    status: 'ok' | 'stale' | 'missing';
    mode: string | null;
    lastBeatAt: string | null;
    ageSec: number | null;
  };
  swis: { status: string; lastAlertPollSuccessAt: string | null; tlsVerification: string | null };
  pollers: Array<{
    poller: string;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
    lastError: string | null;
  }>;
}

/**
 * Health used by /api/health and the dashboard banner. 503 when the DB is down or the worker
 * heartbeat is stale — point an Orion SAM HTTP monitor at it so SolarWinds watches the watcher.
 */
export async function getHealth(
  opts: { liveness?: boolean } = {},
): Promise<{ httpStatus: number; report: HealthReport }> {
  const { bootstrap, db } = server();
  const now = Date.now();
  const report: HealthReport = {
    status: 'ok',
    checkedAt: new Date(now).toISOString(),
    db: 'ok',
    worker: { status: 'missing', mode: null, lastBeatAt: null, ageSec: null },
    swis: { status: 'unknown', lastAlertPollSuccessAt: null, tlsVerification: null },
    pollers: [],
  };
  let setupComplete: boolean;
  try {
    const [beats, pollers, settings] = await Promise.all([
      listHeartbeats(db.db),
      listPollerStates(db.db),
      getSettingsState(),
    ]);
    const cfg = settings.cfg ?? bootstrap;
    setupComplete = cfg.setupComplete || cfg.envKeys.has('SWIS_PASSWORD');
    const w = beats.find((b) => b.component === 'worker');
    if (w) {
      const age = Math.round((now - w.lastBeatAt.getTime()) / 1000);
      report.worker = {
        status: age > cfg.web.workerStaleSec ? 'stale' : 'ok',
        mode: (w.details as { mode?: string }).mode ?? w.status,
        lastBeatAt: w.lastBeatAt.toISOString(),
        ageSec: age,
      };
    }
    const s = beats.find((b) => b.component === 'swis');
    if (s) {
      const d = s.details as Record<string, unknown>;
      report.swis = {
        status: s.status,
        lastAlertPollSuccessAt: (d.lastAlertPollSuccessAt as string | null) ?? null,
        tlsVerification: (d.tlsVerification as string | null) ?? null,
      };
    }
    report.pollers = pollers.map((p) => ({
      poller: p.poller,
      lastSuccessAt: p.lastSuccessAt?.toISOString() ?? null,
      consecutiveFailures: p.consecutiveFailures,
      lastError: p.lastError,
    }));
  } catch {
    report.db = 'error';
    report.status = 'down';
    return { httpStatus: 503, report };
  }
  // Liveness (Docker healthcheck): this process can serve and reach the DB. Readiness (default)
  // also requires a fresh worker heartbeat.
  if (opts.liveness) return { httpStatus: 200, report };
  if (report.worker.status !== 'ok') report.status = 'down';
  else if (!setupComplete) report.status = 'setup_required';
  else if (report.swis.status !== 'up') report.status = 'degraded';
  return { httpStatus: report.status === 'down' ? 503 : 200, report };
}
