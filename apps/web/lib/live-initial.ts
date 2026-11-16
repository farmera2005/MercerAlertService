import 'server-only';
import { listHeartbeats, listPollerStates } from '@mercer/db';
import type { LiveInitial } from '@/components/live';
import { server } from './server';
import { effectiveConfig } from './settings';

/** Starting point for the live status (stale banner, poll ages); the SSE stream updates it. */
export async function liveInitial(): Promise<LiveInitial> {
  const { db } = server();
  const cfg = await effectiveConfig();
  const [beats, pollers] = await Promise.all([listHeartbeats(db.db), listPollerStates(db.db)]);
  return {
    serverTime: new Date().toISOString(),
    workerBeatAt: beats.find((b) => b.component === 'worker')?.lastBeatAt.toISOString() ?? null,
    pollOkAt: Object.fromEntries(
      pollers.map((p) => [p.poller, p.lastSuccessAt?.toISOString() ?? null]),
    ),
    sourceDown: beats.find((b) => b.component === 'swis')?.status === 'down',
    workerStaleSec: cfg.web.workerStaleSec,
    swisStaleSec: cfg.swis.staleAfterSec,
  };
}
