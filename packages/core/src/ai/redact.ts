/**
 * Redaction before anything leaves for the Anthropic API (AI_REDACT, on by default).
 *
 * IPv4/IPv6 addresses, MAC addresses and serial-number-like tokens are replaced with stable
 * placeholders such as `[IP-3]`: the same value always gets the same placeholder within one
 * request, so the model can still reason ("[IP-1] and [IP-2] are on the same link"). The answer
 * comes back with placeholders, and `restore()` puts the real values back locally for display.
 * Hostnames and site names are sent (decision E1).
 */
import { addressPatterns } from '../dashboard/text';

export type RedactionKind = 'IP' | 'MAC' | 'SERIAL';

/** "Serial: FGT60FTK2009ABCD", "S/N FOC1234X0YZ", "SN=5CD1234XYZ". */
const LABELLED_SERIAL =
  /\b(serial(?:\s*(?:number|no\.?|#))?|s\/n|sn)(\s*[:#=]?\s*)([A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9])\b/gi;
/**
 * Unlabelled tokens that look like vendor serials: 10–20 upper-case letters and digits with at
 * least 4 digits and 2 letters, no separators. Hostnames almost always contain a hyphen or are
 * shorter, so they survive.
 */
const BARE_SERIAL = /\b(?=[A-Z0-9]{10,20}\b)(?=(?:[A-Z]*\d){4})(?=(?:\d*[A-Z]){2})[A-Z0-9]+\b/g;

const PLACEHOLDER = /\[(IP|MAC|SERIAL)-(\d+)\]/g;

export interface RedactionStats {
  IP: number;
  MAC: number;
  SERIAL: number;
}

export class Redactor {
  private readonly byValue = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counts: RedactionStats = { IP: 0, MAC: 0, SERIAL: 0 };
  private readonly keep: Set<string>;

  /**
   * `keep`: words that look like serials but are known not to be, such as device models
   * ("CyberPower OR1500LCDRM1U") and hostnames from the incident's own data. Addresses are
   * always redacted.
   */
  constructor(
    readonly enabled = true,
    keep: Iterable<string> = [],
  ) {
    this.keep = new Set(
      [...keep]
        .flatMap((s) => s.split(/[\s,;/()[\]]+/))
        .filter(Boolean)
        .map((w) => w.toUpperCase()),
    );
  }

  private token(kind: RedactionKind, value: string): string {
    const key = `${kind}:${value.toLowerCase()}`;
    const known = this.byValue.get(key);
    if (known) return known;
    this.counts[kind] += 1;
    const ph = `[${kind}-${this.counts[kind]}]`;
    this.byValue.set(key, ph);
    this.byPlaceholder.set(ph, value);
    return ph;
  }

  /** Replace sensitive tokens in free text. A disabled redactor returns the text unchanged. */
  redact(text: string): string {
    if (!this.enabled || !text) return text;
    const p = addressPatterns();
    // MACs first: a colon-separated MAC must not be read as an IPv6 fragment.
    let out = text.replace(p.mac, (m) => this.token('MAC', m));
    out = out.replace(p.ipv4, (m) => this.token('IP', m));
    out = out.replace(p.ipv6, (m) => this.token('IP', m));
    out = out.replace(
      LABELLED_SERIAL,
      (_m, label: string, sep: string, value: string) =>
        `${label}${sep}${this.token('SERIAL', value)}`,
    );
    out = out.replace(BARE_SERIAL, (m) => (this.keep.has(m) ? m : this.token('SERIAL', m)));
    return out;
  }

  /** Redact every string inside a JSON-like value (object keys are left alone). */
  redactDeep<T>(value: T): T {
    if (!this.enabled) return value;
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.redactDeep(v)]),
      ) as T;
    }
    return value;
  }

  /** Put the real values back. Unknown placeholders (the model invented one) stay as written. */
  restore(text: string): string {
    if (!text) return text;
    return text.replace(PLACEHOLDER, (m) => this.byPlaceholder.get(m) ?? m);
  }

  restoreDeep<T>(value: T): T {
    if (typeof value === 'string') return this.restore(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.restoreDeep(v)) as T;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.restoreDeep(v)]),
      ) as T;
    }
    return value;
  }

  /** How many distinct values were replaced (recorded with each AI call). */
  get stats(): RedactionStats {
    return { ...this.counts };
  }

  get redactedAny(): boolean {
    return this.counts.IP + this.counts.MAC + this.counts.SERIAL > 0;
  }
}
