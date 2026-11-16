import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

const REDACT_PATHS = [
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
  'webhookUrl',
  '*.webhookUrl',
  'secret',
  '*.secret',
];

let root: Logger | undefined;

export interface RootLoggerOptions {
  level?: LoggerOptions['level'];
  service: string;
  version?: string;
}

/** Initialise the process-wide root logger once (JSON to stdout). */
export function initLogger(opts: RootLoggerOptions): Logger {
  root = pino({
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.service, version: opts.version, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
  return root;
}

/** Child logger for a component. Falls back to a default root if initLogger was not called. */
export function createLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  root ??= initLogger({ service: 'mas', level: process.env.LOG_LEVEL ?? 'info' });
  return root.child({ component, ...bindings });
}
