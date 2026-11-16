import { readFileSync } from 'node:fs';

/** Prefixes of secret-bearing variables defined outside the core schema (later milestones). */
export const SECRET_ENV_PREFIXES = [
  'TEAMS_WEBHOOK_',
  'AUTH_',
  'ANTHROPIC_',
  'TWILIO_',
  'PUSHOVER_',
  'SWIS_',
  'DATABASE_',
];

/**
 * Docker-secrets support: for every `FOO_FILE=/run/secrets/foo` (and no `FOO`), read the file
 * into `FOO` — only for variables we own (`isKnown`), so unrelated `*_FILE` vars are ignored.
 * Empty-string values are dropped so `FOO=` in a compose file means "unset".
 */
export function resolveFileEnv(
  env: NodeJS.ProcessEnv = process.env,
  isKnown: (key: string) => boolean = (k) => SECRET_ENV_PREFIXES.some((p) => k.startsWith(p)),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== '') out[k] = v;
  }
  for (const [k, v] of Object.entries(out)) {
    if (!k.endsWith('_FILE')) continue;
    const target = k.slice(0, -'_FILE'.length);
    if (out[target] !== undefined || !isKnown(target)) continue;
    try {
      out[target] = readFileSync(v, 'utf8').trim();
    } catch (err) {
      throw new Error(`Cannot read ${k}=${v}: ${(err as Error).message}`, { cause: err });
    }
  }
  return out;
}
