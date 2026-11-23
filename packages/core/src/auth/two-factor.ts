/**
 * Two-step sign-in for local accounts: authenticator-app codes (TOTP, RFC 6238), one-time
 * recovery codes, and the rules for when the second step is needed. Passkeys are checked in the
 * web app with @simplewebauthn/server; Microsoft sign-ins get their MFA from Entra ID.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Lenient: ignores case, spaces, dashes and padding. Null for anything else. */
export function base32Decode(text: string): Buffer | null {
  const s = text.toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]*$/.test(s)) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
/** Codes from one step either side are accepted, for clock drift and slow typing. */
const TOTP_WINDOW = 1;

/** A new authenticator secret: 160 random bits, base32 (what authenticator apps expect). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The secret in groups of four, for typing it into an app by hand. */
export function formatTotpSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

export function totpStep(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SEC);
}

/** HOTP (RFC 4226) for one counter value; TOTP uses the time step as the counter. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1]! & 0x0f;
  const bin =
    ((h[o]! & 0x7f) << 24) | ((h[o + 1]! & 0xff) << 16) | ((h[o + 2]! & 0xff) << 8) | h[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Digits only, without the spaces apps show ("123 456"); null unless it is six digits. */
export function normalizeTotpCode(input: string): string | null {
  const s = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

/**
 * Check a code against the secret. Returns the time step it matched, or null. A step at or
 * before `lastStep` (the last one used to sign in) is refused, so a code works only once.
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { now?: Date; lastStep?: number | null } = {},
): number | null {
  const key = base32Decode(secret);
  const want = normalizeTotpCode(code);
  if (!key || key.length === 0 || !want) return null;
  const current = totpStep(opts.now);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = current + d;
    if (opts.lastStep != null && step <= opts.lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(want))) return step;
  }
  return null;
}

/** The otpauth:// link the QR code holds (Key URI format, understood by every common app). */
export function totpUri(o: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${o.issuer}:${o.account}`);
  const q = new URLSearchParams({
    secret: o.secret,
    issuer: o.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// -------------------------------------------------------------------------------------------
// Recovery codes: ten one-time codes for a lost phone or key, 80 random bits each.
// -------------------------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, () =>
    base32Encode(randomBytes(10))
      .toLowerCase()
      .replace(/(.{4})(?=.)/g, '$1-'),
  );
}

/** As typed: any case, with or without dashes and spaces; 0/1/8 read as o/i/b. Null if malformed. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/8/g, 'B');
  return /^[A-Z2-7]{16}$/.test(s) ? s : null;
}

/** Stored instead of the code. 80 random bits make a plain hash enough. */
export function hashRecoveryCode(normalized: string): string {
  return createHash('sha256').update(`mas-recovery:${normalized}`).digest('hex');
}

// -------------------------------------------------------------------------------------------
// When the second step is needed
// -------------------------------------------------------------------------------------------

export interface SecondFactors {
  /** An authenticator app is set up. */
  totp: boolean;
  /** Passkeys registered (any address). */
  passkeys: number;
}

export function hasSecondFactor(f: SecondFactors): boolean {
  return f.totp || f.passkeys > 0;
}

/**
 * After the password: sign in now ('done'), ask for the second step ('verify'), or have the
 * account set one up first because Settings require it ('enroll').
 */
export function signInStep(f: SecondFactors, required: boolean): 'done' | 'verify' | 'enroll' {
  if (hasSecondFactor(f)) return 'verify';
  return required ? 'enroll' : 'done';
}

/** While two-step sign-in is required, an account keeps at least one second factor. */
export function canRemoveFactor(
  f: SecondFactors,
  required: boolean,
  remove: 'totp' | 'passkey',
): boolean {
  if (!required) return true;
  const left = remove === 'totp' ? { ...f, totp: false } : { ...f, passkeys: f.passkeys - 1 };
  return hasSecondFactor(left);
}

/** Wrong codes allowed for one password sign-in before it has to start again. */
export const SECOND_STEP_MAX_ATTEMPTS = 5;
/** How long the second step may take after the password. */
export const SECOND_STEP_TTL_MS = 10 * 60_000;
