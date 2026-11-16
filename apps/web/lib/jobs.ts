import 'server-only';
import { PgBoss } from 'pg-boss';
import { errorMessage } from '@mercer/core';
import { getHeartbeat } from '@mercer/db';
import { server } from './server';

const g = globalThis as unknown as { __masBoss?: Promise<PgBoss> };

/** A send-only pg-boss client: the worker owns the schema, maintenance and schedules. */
function boss(): Promise<PgBoss> {
  g.__masBoss ??= (async () => {
    const b = new PgBoss({
      connectionString: server().bootstrap.database.url,
      application_name: 'mas-web-boss',
      max: 2,
      supervise: false,
      schedule: false,
      migrate: false,
    });
    b.on('error', (err) => server().log.warn({ err: errorMessage(err) }, 'pg-boss (web) error'));
    await b.start();
    return b;
  })().catch((err: unknown) => {
    g.__masBoss = undefined;
    throw err;
  });
  return g.__masBoss;
}

export type JobOutcome<T> =
  | { status: 'completed'; output: T }
  | { status: 'failed' | 'timeout' | 'no_worker'; message: string };

/**
 * Ask the worker to do something (test the Orion connection, run discovery, …) and wait for the
 * answer. The web app never talks to SWIS itself.
 */
export async function runWorkerJob<T>(
  queue: string,
  data: object,
  timeoutMs = 45_000,
): Promise<JobOutcome<T>> {
  const { db } = server();
  const hb = await getHeartbeat(db.db, 'worker');
  if (!hb || Date.now() - hb.lastBeatAt.getTime() > 90_000) {
    return {
      status: 'no_worker',
      message:
        'The worker is not running. Check `docker compose ps` and `docker compose logs worker`.',
    };
  }
  let b: PgBoss;
  try {
    b = await boss();
  } catch (err) {
    return { status: 'no_worker', message: `Job queue unavailable: ${errorMessage(err)}` };
  }
  const id = await b.send(queue, data, {
    retryLimit: 0,
    expireInSeconds: Math.ceil(timeoutMs / 1000) + 30,
  });
  if (!id) return { status: 'failed', message: 'The job could not be queued.' };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const [job] = await b.findJobs<object>(queue, { id });
    if (!job) continue;
    if (job.state === 'completed') return { status: 'completed', output: job.output as T };
    if (job.state === 'failed' || job.state === 'cancelled') {
      return {
        status: 'failed',
        message: errorMessage((job.output as { message?: string })?.message ?? 'job failed'),
      };
    }
  }
  return {
    status: 'timeout',
    message: 'The worker did not answer in time. It may still be busy; try again in a moment.',
  };
}

/** Queue a job for the worker without waiting for it (e.g. Orion write-back). */
export async function enqueueWorkerJob(queue: string, data: object): Promise<void> {
  const b = await boss();
  const id = await b.send(queue, data, { retryLimit: 2, retryDelay: 15, expireInSeconds: 300 });
  if (!id) throw new Error('the job could not be queued');
}
