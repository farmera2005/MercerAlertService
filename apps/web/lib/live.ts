import 'server-only';
import pg from 'pg';
import { EVENTS_CHANNEL, errorMessage, parseBusEvent } from '@mercer/core';
import type { SseEvent } from '@mercer/core/events';
import { server } from './server';
import { invalidateSettingsCache } from './settings';

type Listener = (ev: SseEvent) => void;

interface Hub {
  listeners: Set<Listener>;
  client: pg.Client | null;
  connecting: boolean;
  everConnected: boolean;
  backoffMs: number;
}

const g = globalThis as unknown as { __masLive?: Hub };

function hub(): Hub {
  g.__masLive ??= {
    listeners: new Set(),
    client: null,
    connecting: false,
    everConnected: false,
    backoffMs: 1000,
  };
  return g.__masLive;
}

function broadcast(ev: SseEvent): void {
  for (const l of hub().listeners) {
    try {
      l(ev);
    } catch {
      // A broken stream is removed by its own abort handler.
    }
  }
}

/**
 * One LISTEN connection per web process (not per browser), fanned out to every SSE client. If it
 * drops, it reconnects with backoff and tells clients to resync, since events may have been missed.
 */
async function connect(): Promise<void> {
  const h = hub();
  if (h.client || h.connecting) return;
  h.connecting = true;
  const { bootstrap, log } = server();
  const client = new pg.Client({
    connectionString: bootstrap.database.url,
    application_name: 'mas-web-live',
  });
  const retry = () => {
    if (h.client === client) h.client = null;
    client.removeAllListeners();
    void client.end().catch(() => {});
    const wait = h.backoffMs;
    h.backoffMs = Math.min(h.backoffMs * 2, 30_000);
    setTimeout(() => void connect(), wait).unref();
  };
  try {
    await client.connect();
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    client.on('notification', (msg) => {
      const ev = msg.payload ? parseBusEvent(msg.payload) : null;
      if (!ev) return;
      if (ev.t === 'config') invalidateSettingsCache();
      broadcast(ev);
    });
    client.on('error', (err) => {
      log.warn({ err: errorMessage(err) }, 'live events connection lost; reconnecting');
      retry();
    });
    client.on('end', retry);
    h.client = client;
    h.backoffMs = 1000;
    if (h.everConnected) {
      invalidateSettingsCache();
      broadcast({ t: 'resync', serverTime: new Date().toISOString() });
    }
    h.everConnected = true;
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'cannot LISTEN for live events; retrying');
    retry();
  } finally {
    h.connecting = false;
  }
}

export const MAX_STREAMS = 200;

export function streamCount(): number {
  return hub().listeners.size;
}

export function subscribe(listener: Listener): () => void {
  const h = hub();
  h.listeners.add(listener);
  void connect();
  return () => h.listeners.delete(listener);
}
