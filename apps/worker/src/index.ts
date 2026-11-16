import { createLogger, errorMessage, initLogger, loadConfig } from '@mercer/core';
import { startHealthServer } from './health-server';
import { createWorker } from './worker';

const cfg = loadConfig();
initLogger({ service: 'mas-worker', level: cfg.logLevel, version: cfg.version });
const log = createLogger('main');

const worker = createWorker(cfg);
const health = startHealthServer(worker, cfg.worker.healthPort);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  health.close();
  await worker
    .stop()
    .catch((e: unknown) => log.error({ err: errorMessage(e) }, 'error during shutdown'));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) =>
  log.error({ err: errorMessage(err) }, 'unhandled rejection'),
);

try {
  await worker.start();
} catch (err) {
  log.fatal({ err: errorMessage(err) }, 'worker failed to start');
  process.exit(1);
}
