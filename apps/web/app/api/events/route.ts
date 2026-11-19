import type { NextRequest } from 'next/server';
import type { SseEvent } from '@mercer/core/events';
import { currentUser } from '@/lib/auth';
import { checkKioskToken } from '@/lib/kiosk';
import { MAX_STREAMS, streamCount, subscribe } from '@/lib/live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const enc = new TextEncoder();
const frame = (ev: SseEvent) => enc.encode(`data: ${JSON.stringify(ev)}\n\n`);

/**
 * Server-Sent Events for the dashboard (signed-in users) and the wall (`?k=<kiosk token>`).
 * Payloads are tiny change notices; pages refetch through their normal authenticated render.
 */
export async function GET(req: NextRequest) {
  const kiosk = req.nextUrl.searchParams.get('k');
  // Chat progress goes only to the person who asked; walls never get it.
  let chatOwner: string | null = null;
  if (kiosk) {
    const check = await checkKioskToken(kiosk, req.headers);
    if (!check.ok) return new Response(null, { status: 403 });
  } else {
    const user = await currentUser();
    if (!user) return new Response(null, { status: 401 });
    chatOwner = `${user.kind}:${user.id}`;
  }
  if (streamCount() >= MAX_STREAMS) return new Response(null, { status: 503 });

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (ev: SseEvent) => controller.enqueue(frame(ev));
      controller.enqueue(enc.encode('retry: 5000\n\n'));
      send({ t: 'hello', serverTime: new Date().toISOString() });
      const unsubscribe = subscribe((ev) => {
        if (ev.t === 'chat' && ev.user !== chatOwner) return;
        send(ev);
      });
      const ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 15_000);
      // A revoked or expired wall link stops streaming within a minute.
      const recheck = kiosk
        ? setInterval(async () => {
            const c = await checkKioskToken(kiosk, req.headers).catch(() => null);
            if (!c?.ok) cleanup();
          }, 60_000)
        : null;
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
        if (recheck) clearInterval(recheck);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener('abort', () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
