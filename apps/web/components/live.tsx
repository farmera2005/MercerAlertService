'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { parseSseEvent, type SseEvent } from '@mercer/core/events';

export type ChatEvent = Extract<SseEvent, { t: 'chat' }>;

/** Rendered by the server on every page load / refresh; the stream keeps it current in between. */
export interface LiveInitial {
  serverTime: string;
  workerBeatAt: string | null;
  pollOkAt: Record<string, string | null>;
  sourceDown: boolean;
  workerStaleSec: number;
  swisStaleSec: number;
}

export interface StaleInfo {
  any: boolean;
  worker: boolean;
  swis: boolean;
  connection: boolean;
  reason: string | null;
}

interface LiveValue {
  connected: boolean;
  /** Server-clock "now" (corrects for a wall PC whose clock is off), ticking every few seconds. */
  now: number;
  pollOkAt: Record<string, number | null>;
  workerBeatAt: number | null;
  stale: StaleInfo;
  /** "Ask the network" progress for the signed-in person (the server filters by owner). */
  subscribeChat: (listener: (ev: ChatEvent) => void) => () => void;
}

const LiveContext = createContext<LiveValue | null>(null);

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null);
const newer = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);
const ago = (sec: number) => (sec < 120 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);

const REFRESH_DEBOUNCE_MS = 1200;
const REFRESH_MAX_WAIT_MS = 4000;
const CONNECTION_GRACE_MS = 30_000;

export function LiveProvider({
  endpoint,
  initial,
  children,
}: {
  endpoint: string;
  initial: LiveInitial;
  children: ReactNode;
}) {
  const router = useRouter();
  const [offsetMs, setOffsetMs] = useState(() => ms(initial.serverTime)! - Date.now());
  const [tick, setTick] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);
  const [lostAt, setLostAt] = useState<number | null>(null);
  const [workerBeatAt, setWorkerBeatAt] = useState(() => ms(initial.workerBeatAt));
  const [pollOkAt, setPollOkAt] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(Object.entries(initial.pollOkAt).map(([k, v]) => [k, ms(v)])),
  );
  const [sourceDown, setSourceDown] = useState(initial.sourceDown);

  // A server refresh brings authoritative values; keep whichever is newer.
  useEffect(() => {
    setWorkerBeatAt((cur) => newer(cur, ms(initial.workerBeatAt)));
    setPollOkAt((cur) => {
      const next = { ...cur };
      for (const [k, v] of Object.entries(initial.pollOkAt)) next[k] = newer(cur[k] ?? null, ms(v));
      return next;
    });
    setSourceDown(initial.sourceDown);
    setOffsetMs(ms(initial.serverTime)! - Date.now());
  }, [initial]);

  const chatListeners = useRef(new Set<(ev: ChatEvent) => void>());
  const subscribeChat = useCallback((listener: (ev: ChatEvent) => void) => {
    chatListeners.current.add(listener);
    return () => {
      chatListeners.current.delete(listener);
    };
  }, []);

  const offsetMsRef = useRef(offsetMs);
  useEffect(() => {
    offsetMsRef.current = offsetMs;
  }, [offsetMs]);

  const timer = useRef<{ t: ReturnType<typeof setTimeout> | null; first: number | null }>({
    t: null,
    first: null,
  });
  const refreshSoon = useCallback(() => {
    const r = timer.current;
    const now = Date.now();
    r.first ??= now;
    if (r.t) clearTimeout(r.t);
    const wait = Math.max(0, Math.min(REFRESH_DEBOUNCE_MS, r.first + REFRESH_MAX_WAIT_MS - now));
    r.t = setTimeout(() => {
      r.t = null;
      r.first = null;
      router.refresh();
    }, wait);
  }, [router]);

  useEffect(() => {
    const es = new EventSource(endpoint);
    es.onopen = () => {
      setConnected(true);
      setLostAt(null);
    };
    es.onerror = () => {
      setConnected(false);
      setLostAt((cur) => cur ?? Date.now());
    };
    es.onmessage = (m: MessageEvent<string>) => {
      const ev = parseSseEvent(m.data);
      if (!ev) return;
      const serverNow = Date.now() + offsetMsRef.current;
      switch (ev.t) {
        case 'hello':
        case 'resync':
          setOffsetMs(ms(ev.serverTime)! - Date.now());
          if (ev.t === 'resync') refreshSoon();
          break;
        case 'heartbeat':
          if (ev.component === 'worker') setWorkerBeatAt(serverNow);
          break;
        case 'poll':
          if (ev.ok) setPollOkAt((cur) => ({ ...cur, [ev.poller]: serverNow }));
          if (!ev.ok || (ev.transitions ?? 0) > 0) refreshSoon();
          break;
        case 'source':
          setSourceDown(ev.status === 'down');
          refreshSoon();
          break;
        case 'incident':
        case 'config':
          refreshSoon();
          break;
        case 'chat':
          for (const l of chatListeners.current) l(ev);
          break;
      }
    };
    return () => es.close();
  }, [endpoint, refreshSoon]);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const value = useMemo<LiveValue>(() => {
    const now = tick + offsetMs;
    const workerAge = workerBeatAt === null ? Infinity : (now - workerBeatAt) / 1000;
    const alertsOk = pollOkAt.alerts ?? null;
    const swisAge = alertsOk === null ? Infinity : (now - alertsOk) / 1000;
    const worker = workerAge > initial.workerStaleSec;
    const swis = !worker && (sourceDown || swisAge > initial.swisStaleSec);
    const connection = !connected && lostAt !== null && tick - lostAt > CONNECTION_GRACE_MS;
    const reason = worker
      ? workerBeatAt === null
        ? 'The MAS worker is not running.'
        : `The MAS worker has not reported for ${ago(workerAge)}.`
      : swis
        ? sourceDown
          ? 'SolarWinds is unreachable.'
          : alertsOk === null
            ? 'No successful SolarWinds poll yet.'
            : `No successful SolarWinds poll for ${ago(swisAge)}.`
        : connection
          ? 'Lost the connection to the MAS server. Reconnecting…'
          : null;
    return {
      connected,
      now,
      pollOkAt,
      workerBeatAt,
      stale: { any: worker || swis || connection, worker, swis, connection, reason },
      subscribeChat,
    };
  }, [
    tick,
    offsetMs,
    workerBeatAt,
    pollOkAt,
    sourceDown,
    connected,
    lostAt,
    initial,
    subscribeChat,
  ]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveValue | null {
  return useContext(LiveContext);
}

export function LiveDot() {
  const live = useLive();
  if (!live) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-slate-400"
      title={live.connected ? 'Updates arrive as they happen' : 'Reconnecting to live updates'}
    >
      <span
        className={`h-2 w-2 rounded-full ${live.connected ? 'bg-emerald-400' : 'animate-pulse bg-amber-400'}`}
      />
      {live.connected ? 'Live' : 'Reconnecting'}
    </span>
  );
}

/** "12 s ago", ticking. */
export function Ago({ at, fallback = '—' }: { at: string | number | null; fallback?: string }) {
  const live = useLive();
  if (at === null) return <>{fallback}</>;
  const t = typeof at === 'number' ? at : new Date(at).getTime();
  const sec = Math.max(0, ((live?.now ?? Date.now()) - t) / 1000);
  const text =
    sec < 60
      ? `${Math.round(sec)} s ago`
      : sec < 3600
        ? `${Math.round(sec / 60)} min ago`
        : sec < 172_800
          ? `${Math.round(sec / 3600)} h ago`
          : `${Math.round(sec / 86_400)} d ago`;
  return <span suppressHydrationWarning>{text}</span>;
}

/** Last successful poll per poller, kept current by the stream. */
export function PollAgo({ poller, initial }: { poller: string; initial: string | null }) {
  const live = useLive();
  return <Ago at={live?.pollOkAt[poller] ?? (initial ? new Date(initial).getTime() : null)} />;
}

export function StaleBanner({ variant = 'dashboard' }: { variant?: 'dashboard' | 'wall' }) {
  const live = useLive();
  if (!live?.stale.any) return null;
  if (variant === 'wall')
    return (
      <div
        role="alert"
        className="flex items-center justify-center gap-6 bg-red-600 px-8 py-5 text-center text-white"
      >
        <span className="text-[44px] font-black tracking-widest">DATA STALE</span>
        <span className="text-[30px] font-semibold">{live.stale.reason}</span>
      </div>
    );
  return (
    <div
      role="alert"
      className="border-b border-red-500/50 bg-red-600/90 px-6 py-2 text-sm text-white"
    >
      <b>Data may be out of date.</b> {live.stale.reason}
    </div>
  );
}
