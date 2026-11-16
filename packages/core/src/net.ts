/**
 * Client IP and CIDR allowlists for kiosk tokens. The peer address comes from the socket (see
 * apps/web/peer-ip.mjs); X-Forwarded-For is only believed behind a configured reverse proxy, and
 * then only the entry our own proxy appended (counting `hops` from the right).
 */
import { BlockList, isIP } from 'node:net';

/** Strip IPv6 zone ids, brackets and the IPv4-mapped prefix (::ffff:10.0.0.5 → 10.0.0.5). */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim().replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  return isIP(ip) ? ip : null;
}

export function clientIp(opts: {
  peer: string | null | undefined;
  forwardedFor: string | null | undefined;
  trustProxy: boolean;
  hops: number;
}): string | null {
  if (!opts.trustProxy) return normalizeIp(opts.peer);
  const list = (opts.forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return normalizeIp(opts.peer);
  const idx = Math.max(0, list.length - Math.max(1, opts.hops));
  return normalizeIp(list[idx]);
}

export interface CidrParse {
  cidrs: string[];
  errors: string[];
}

/** Parse a comma/space/newline separated list of IPs or CIDRs into canonical "addr/prefix". */
export function parseCidrList(text: string): CidrParse {
  const cidrs: string[] = [];
  const errors: string[] = [];
  for (const item of text.split(/[\s,]+/).filter(Boolean)) {
    const [addr, prefixRaw] = item.split('/');
    const ip = normalizeIp(addr);
    if (!ip) {
      errors.push(`"${item}" is not an IP address or CIDR range`);
      continue;
    }
    const max = isIP(ip) === 4 ? 32 : 128;
    const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      errors.push(`"${item}" has an invalid prefix length`);
      continue;
    }
    const canonical = `${ip}/${prefix}`;
    if (!cidrs.includes(canonical)) cidrs.push(canonical);
  }
  return { cidrs, errors };
}

/** An empty list allows any address; otherwise the IP must be known and inside one range. */
export function ipAllowed(ip: string | null, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return true;
  const addr = normalizeIp(ip);
  if (!addr) return false;
  const list = new BlockList();
  for (const c of cidrs) {
    const [a, p] = c.split('/');
    const family = isIP(a!) === 4 ? 'ipv4' : 'ipv6';
    list.addSubnet(a!, Number(p), family);
  }
  return list.check(addr, isIP(addr) === 4 ? 'ipv4' : 'ipv6');
}
