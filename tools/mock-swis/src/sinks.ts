/**
 * Notification sinks for development and tests: a Teams Workflows webhook per name, and Twilio /
 * Pushover lookalikes. Everything posted is kept in memory and listed at GET /__mock/sink.
 * Not part of SWIS; it lives here so one dev service covers every outbound dependency.
 */
import { randomUUID } from 'node:crypto';

export interface SinkRecord {
  at: string;
  /** "teams:<name>", "twilio" or "pushover". */
  sink: string;
  contentType: string | null;
  authorization: string | null;
  body: unknown;
}

export interface Sinks {
  records: SinkRecord[];
  clear(): void;
  /** Make the next `times` requests to `sink` fail with `status`. */
  failNext(sink: string, status: number, times?: number): void;
  /** Returns [status, body] when `path` (after /__mock/) is a sink route, else null. */
  handle(
    method: string,
    path: string,
    headers: Record<string, string | string[] | undefined>,
    raw: string,
  ): [number, unknown] | null;
}

export function createSinks(): Sinks {
  const records: SinkRecord[] = [];
  const failures = new Map<string, { status: number; times: number }>();
  const header = (h: Record<string, string | string[] | undefined>, k: string) => {
    const v = h[k];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  };
  const route = (path: string): string | null => {
    const teams = /^sink\/([\w-]+)$/.exec(path);
    if (teams) return `teams:${teams[1]}`;
    if (/^twilio\/2010-04-01\/Accounts\/\w+\/Messages\.json$/.test(path)) return 'twilio';
    if (path === 'pushover/1/messages.json') return 'pushover';
    return null;
  };
  return {
    records,
    clear() {
      records.length = 0;
      failures.clear();
    },
    failNext(sink, status, times = 1) {
      failures.set(sink, { status, times });
    },
    handle(method, path, headers, raw) {
      if (path === 'sink' && method === 'GET') return [200, { records }];
      if (path === 'sink' && method === 'DELETE') {
        this.clear();
        return [200, { ok: true }];
      }
      if (path === 'sink-fail' && method === 'POST') {
        const b = JSON.parse(raw || '{}') as { sink?: string; status?: number; times?: number };
        this.failNext(String(b.sink), Number(b.status ?? 500), Number(b.times ?? 1));
        return [200, { ok: true }];
      }
      const sink = method === 'POST' ? route(path) : null;
      if (!sink) return null;
      const fail = failures.get(sink);
      if (fail && fail.times > 0) {
        fail.times--;
        return [fail.status, { error: 'injected failure' }];
      }
      const contentType = header(headers, 'content-type');
      const body = contentType?.includes('json')
        ? (JSON.parse(raw || 'null') as unknown)
        : Object.fromEntries(new URLSearchParams(raw));
      records.push({
        at: new Date().toISOString(),
        sink,
        contentType,
        authorization: header(headers, 'authorization'),
        body,
      });
      if (sink === 'twilio')
        return [201, { sid: `SM${randomUUID().replace(/-/g, '')}`, status: 'queued' }];
      if (sink === 'pushover') return [200, { status: 1, request: randomUUID() }];
      return [202, ''];
    },
  };
}
