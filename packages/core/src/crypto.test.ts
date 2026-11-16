import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SecretBox,
  generateMasterKey,
  generateSetupCode,
  hashPassword,
  loadOrCreateMasterKey,
  normalizeSetupCode,
  verifyPassword,
} from './crypto';

describe('SecretBox', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const box = SecretBox.fromBase64(generateMasterKey());
    const a = box.seal('s3cret!');
    expect(a).toMatch(/^v1:/);
    expect(a).not.toBe(box.seal('s3cret!'));
    expect(box.open(a)).toBe('s3cret!');
  });
  it('rejects tampering and the wrong key', () => {
    const box = SecretBox.fromBase64(generateMasterKey());
    const sealed = box.seal('x');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = 'v1:' + raw.toString('base64');
    expect(() => box.open(tampered)).toThrow();
    expect(() => SecretBox.fromBase64(generateMasterKey()).open(sealed)).toThrow();
  });
  it('creates one shared key file when none is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mas-key-'));
    const a = loadOrCreateMasterKey({ MAS_DATA_DIR: dir });
    const b = loadOrCreateMasterKey({ MAS_DATA_DIR: dir });
    expect(b.box.open(a.box.seal('same'))).toBe('same');
    expect(readFileSync(join(dir, 'master.key'), 'utf8').trim()).toHaveLength(44);
  });
});

describe('passwords and setup codes', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('generates readable setup codes and tolerates typing variations', () => {
    const code = generateSetupCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeSetupCode(' k7qf 2m9x ')).toBe('K7QF2M9X');
    expect(normalizeSetupCode('O1L0')).toBe('0110');
  });
});
