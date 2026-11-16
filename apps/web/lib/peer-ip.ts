/**
 * Next.js keeps a client-supplied X-Forwarded-For as-is, so without a proxy in front the real
 * socket address is lost and any client could claim any IP (fatal for wall-display IP
 * allowlists). At server start we wrap http.Server#emit so every request carries the socket peer
 * in a header that is always overwritten, and a process flag says the header can be trusted.
 */
import http from 'node:http';

export const PEER_HEADER = 'x-mas-peer-ip';
const FLAG = Symbol.for('mas.peerIpHook');
type G = typeof globalThis & { [FLAG]?: boolean };

export function installPeerIpHook(): void {
  const g = globalThis as G;
  if (g[FLAG]) return;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function patched(
    this: http.Server,
    event: string,
    ...args: unknown[]
  ) {
    if (event === 'request') {
      const req = args[0] as http.IncomingMessage;
      req.headers[PEER_HEADER] = req.socket?.remoteAddress ?? '';
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  } as typeof emit;
  g[FLAG] = true;
}

/** The socket address, or null when the hook is not active in this process (never trust it then). */
export function peerIpFrom(headers: Headers): string | null {
  if (!(globalThis as G)[FLAG]) return null;
  return headers.get(PEER_HEADER) || null;
}
