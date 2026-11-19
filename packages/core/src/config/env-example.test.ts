import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from './env';
import { SETTINGS } from './registry';

const example = readFileSync(
  fileURLToPath(new URL('../../../../.env.example', import.meta.url)),
  'utf8',
);
const listed = new Set([...example.matchAll(/^# ([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));

describe('.env.example', () => {
  it('lists every setting (run `pnpm env:example` after adding one)', () => {
    const missing = SETTINGS.map((d) => d.key).filter((k) => !listed.has(k));
    expect(missing).toEqual([]);
  });

  it('lists only variables MAS or Compose knows', () => {
    const compose = [
      'WEB_PORT',
      'DB_PORT',
      'APP_VERSION',
      'MAS_VERSION',
      'MAS_REGISTRY',
      'BACKUP_TIME',
      'BACKUP_KEEP_DAYS',
      'BACKUP_HOST_DIR',
      'POSTGRES_PASSWORD',
      'BUILD_CA_FILE',
    ];
    const known = new Set([...Object.keys(envSchema.shape), ...compose]);
    expect([...listed].filter((k) => !known.has(k))).toEqual([]);
  });

  it('never puts a comment after a setting (Compose would read it as the value)', () => {
    expect(example.split('\n').filter((l) => /^# [A-Z][A-Z0-9_]*=.*\s#/.test(l))).toEqual([]);
  });
});
