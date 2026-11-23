import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  canRemoveFactor,
  formatTotpSecret,
  hashRecoveryCode,
  hotp,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  normalizeTotpCode,
  signInStep,
  totpUri,
  verifyTotp,
} from './two-factor';

// RFC 4226 / RFC 6238 test secret.
const KEY = Buffer.from('12345678901234567890');
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const at = (sec: number) => new Date(sec * 1000);

describe('base32', () => {
  it('round-trips and matches the RFC secret', () => {
    expect(base32Encode(KEY)).toBe(SECRET);
    expect(base32Decode(SECRET)).toEqual(KEY);
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq==')).toEqual(KEY);
    expect(base32Decode('not base32!')).toBeNull();
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(formatTotpSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});

describe('TOTP', () => {
  it('matches the RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 3, 9].map((c) => hotp(KEY, c))).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '520489',
    ]);
  });

  it('matches the RFC 6238 SHA-1 vectors (last six digits)', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];
    for (const [t, code] of vectors)
      expect(verifyTotp(SECRET, code, { now: at(t) })).toBe(Math.floor(t / 30));
  });

  it('accepts one step of drift, refuses more and refuses reuse', () => {
    const t = 1234567890; // step 41152263
    const code = '005924';
    expect(verifyTotp(SECRET, code, { now: at(t + 30) })).toBe(41152263);
    expect(verifyTotp(SECRET, code, { now: at(t - 30) })).toBe(41152263);
    expect(verifyTotp(SECRET, code, { now: at(t + 90) })).toBeNull();
    expect(verifyTotp(SECRET, code, { now: at(t), lastStep: 41152263 })).toBeNull();
    expect(verifyTotp(SECRET, '000000', { now: at(t) })).toBeNull();
    expect(verifyTotp(SECRET, '00592', { now: at(t) })).toBeNull();
    expect(verifyTotp('', code, { now: at(t) })).toBeNull();
  });

  it('reads codes as typed', () => {
    expect(normalizeTotpCode(' 005 924 ')).toBe('005924');
    expect(normalizeTotpCode('005-924')).toBe('005924');
    expect(normalizeTotpCode('5924')).toBeNull();
    expect(normalizeTotpCode('abcdef')).toBeNull();
  });

  it('builds the otpauth link for the QR code', () => {
    expect(totpUri({ secret: SECRET, account: 'admin', issuer: 'MercerAlertService' })).toBe(
      `otpauth://totp/MercerAlertService%3Aadmin?secret=${SECRET}&issuer=MercerAlertService&algorithm=SHA1&digits=6&period=30`,
    );
  });
});

describe('recovery codes', () => {
  it('generates ten distinct codes that read back as typed', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    const c = codes[0]!;
    const n = normalizeRecoveryCode(c)!;
    expect(normalizeRecoveryCode(c.toUpperCase().replace(/-/g, ' '))).toBe(n);
    expect(hashRecoveryCode(n)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(n)).not.toContain(n.toLowerCase());
  });
  it('forgives look-alike digits and refuses malformed input', () => {
    expect(normalizeRecoveryCode('abcd-efgh-ijkl-mnop')).toBe('ABCDEFGHIJKLMNOP');
    expect(normalizeRecoveryCode('abcd-efgh-1jkl-mn0p')).toBe('ABCDEFGHIJKLMNOP');
    expect(normalizeRecoveryCode('abcd-efgh')).toBeNull();
    expect(normalizeRecoveryCode('123456')).toBeNull();
  });
});

describe('when the second step is needed', () => {
  const none = { totp: false, passkeys: 0 };
  it('asks for it once an account has a second factor', () => {
    expect(signInStep(none, false)).toBe('done');
    expect(signInStep(none, true)).toBe('enroll');
    expect(signInStep({ totp: true, passkeys: 0 }, false)).toBe('verify');
    expect(signInStep({ totp: false, passkeys: 1 }, true)).toBe('verify');
  });
  it('keeps one factor while it is required', () => {
    expect(canRemoveFactor({ totp: true, passkeys: 0 }, true, 'totp')).toBe(false);
    expect(canRemoveFactor({ totp: true, passkeys: 0 }, false, 'totp')).toBe(true);
    expect(canRemoveFactor({ totp: true, passkeys: 1 }, true, 'totp')).toBe(true);
    expect(canRemoveFactor({ totp: false, passkeys: 1 }, true, 'passkey')).toBe(false);
    expect(canRemoveFactor({ totp: false, passkeys: 2 }, true, 'passkey')).toBe(true);
  });
});
