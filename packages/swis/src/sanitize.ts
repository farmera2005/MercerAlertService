import { createHash } from 'node:crypto';

/**
 * Deterministic sanitizer for recorded SWIS fixtures: same input → same pseudonym, so joins
 * between recorded queries still line up. Keeps site/division names and hostnames unless asked.
 */
export class FixtureSanitizer {
  private readonly ipMap = new Map<string, string>();
  private readonly nameMap = new Map<string, string>();
  constructor(private readonly opts: { hashHostnames?: boolean; salt?: string } = {}) {}

  private h(v: string): Buffer {
    return createHash('sha256')
      .update((this.opts.salt ?? 'mas') + v)
      .digest();
  }

  ipv4(ip: string): string {
    let out = this.ipMap.get(ip);
    if (!out) {
      const d = this.h(ip);
      out = `10.${d[0]! % 250}.${d[1]! % 250}.${(d[2]! % 250) + 1}`;
      this.ipMap.set(ip, out);
    }
    return out;
  }

  private pseudonym(kind: string, v: string): string {
    const key = `${kind}:${v}`;
    let out = this.nameMap.get(key);
    if (!out) {
      out = `${kind}-${this.h(key).toString('hex').slice(0, 6)}`;
      this.nameMap.set(key, out);
    }
    return out;
  }

  string(key: string, value: string): string {
    if (/serial/i.test(key)) return this.pseudonym('SERIAL', value);
    if (/^(AcknowledgedBy|AccountID|Contact)$/i.test(key)) return this.pseudonym('user', value);
    if (this.opts.hashHostnames && /^(DNS|SysName)$/i.test(key))
      return this.pseudonym('host', value);
    return value
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => this.ipv4(ip))
      .replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, (mac) =>
        this.pseudonym('MAC', mac.toLowerCase()),
      )
      .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, (v6) =>
        v6.includes('::') || v6.split(':').length > 3
          ? `fd00::${this.h(v6).toString('hex').slice(0, 4)}`
          : v6,
      )
      .replace(
        /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,
        (email) => this.pseudonym('user', email) + '@example.invalid',
      );
  }

  value(key: string, v: unknown): unknown {
    if (typeof v === 'string') return this.string(key, v);
    if (Array.isArray(v)) return v.map((x) => this.value(key, x));
    if (v && typeof v === 'object') return this.row(v as Record<string, unknown>);
    return v;
  }

  row(r: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = this.value(k, v);
    return out;
  }
}
