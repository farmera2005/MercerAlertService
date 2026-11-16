import { eq, inArray, sql } from 'drizzle-orm';
import { isSecretSetting, type SecretBox } from '@mercer/core';
import { appSettings } from '../schema';
import type { Db, DbOrTx } from '../client';
import { writeAudit, type AuditEntry } from './audit';
import { publishEvent } from './events-bus';

/**
 * Settings are stored as {"v": "..."} (plain) or {"enc": "v1:..."} (secrets). Wrapping avoids
 * jsonb scalar ambiguity ("45" vs 45) when the driver round-trips values.
 */
type StoredValue =
  { v: string } | { enc: string } | string | number | boolean | Record<string, unknown>;

function decode(
  v: StoredValue,
  box: SecretBox,
): { value?: string; secret: boolean; undecryptable?: boolean } {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    return { value: String(v), secret: false };
  if (v && typeof v === 'object') {
    if (typeof (v as { v?: unknown }).v === 'string')
      return { value: (v as { v: string }).v, secret: false };
    if (typeof (v as { enc?: unknown }).enc === 'string') {
      try {
        return { value: box.open((v as { enc: string }).enc), secret: true };
      } catch {
        return { secret: true, undecryptable: true };
      }
    }
  }
  return { secret: false };
}

export interface LoadedSettings {
  /** Decrypted string values, keyed by setting (env) name. */
  values: Record<string, string>;
  /** Secrets that could not be decrypted (master key changed/lost) — treat as unset. */
  undecryptable: string[];
  updatedAt: Record<string, { at: Date; by: string | null }>;
}

export async function loadSettings(db: DbOrTx, box: SecretBox): Promise<LoadedSettings> {
  const rows = await db.select().from(appSettings);
  const out: LoadedSettings = { values: {}, undecryptable: [], updatedAt: {} };
  for (const r of rows) {
    if (r.key.startsWith('internal.')) continue;
    out.updatedAt[r.key] = { at: r.updatedAt, by: r.updatedBy };
    const d = decode(r.value as StoredValue, box);
    if (d.undecryptable) out.undecryptable.push(r.key);
    else if (d.value !== undefined) out.values[r.key] = d.value;
  }
  return out;
}

export interface SettingChange {
  key: string;
  /** null deletes the saved value (falls back to env/default). */
  value: string | null;
}

export interface Actor {
  actorType: AuditEntry['actorType'];
  actorId?: string | null;
  actorLabel: string;
  ip?: string | null;
  userAgent?: string | null;
}

const redact = (key: string, v: string | null | undefined) =>
  v === null || v === undefined
    ? null
    : isSecretSetting(key)
      ? '[secret]'
      : key.endsWith('_PEM')
        ? `[pem ${v.length} chars]`
        : v;

/**
 * Save settings atomically with an audit row (secrets redacted) and notify the worker.
 * Secrets are encrypted with the master key before they reach the database.
 */
export async function saveSettings(
  db: Db,
  changes: SettingChange[],
  actor: Actor,
  box: SecretBox,
): Promise<void> {
  if (!changes.length) return;
  await db.transaction(async (tx) => {
    const keys = changes.map((c) => c.key);
    const before = await tx.select().from(appSettings).where(inArray(appSettings.key, keys));
    const beforeMap = new Map(before.map((b) => [b.key, b.value as StoredValue]));
    const now = new Date();
    for (const c of changes) {
      if (c.value === null) {
        await tx.delete(appSettings).where(eq(appSettings.key, c.key));
        continue;
      }
      const value: StoredValue = isSecretSetting(c.key)
        ? { enc: box.seal(c.value) }
        : { v: c.value };
      await tx
        .insert(appSettings)
        .values({ key: c.key, value, updatedBy: actor.actorLabel, updatedAt: now })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value, updatedBy: actor.actorLabel, updatedAt: now },
        });
    }
    await writeAudit(tx, {
      ...actor,
      action: 'settings.update',
      targetType: 'settings',
      targetId: keys.join(','),
      before: Object.fromEntries(
        keys.map((k) => {
          const b = beforeMap.get(k);
          return [k, b === undefined ? null : redact(k, decode(b, box).value ?? '[secret]')];
        }),
      ),
      after: Object.fromEntries(changes.map((c) => [c.key, redact(c.key, c.value)])),
    });
    await publishEvent(tx, { t: 'config' });
  });
}

/** Internal JSON blobs (last discovery report, setup code, …) — not audited, not user settings. */
export async function getInternalSetting<T>(db: DbOrTx, key: string): Promise<T | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key));
  return (row?.value as T | undefined) ?? null;
}

export async function setInternalSetting(db: DbOrTx, key: string, value: unknown): Promise<void> {
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key, value: value as Record<string, unknown>, updatedBy: 'system', updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: value as Record<string, unknown>, updatedAt: now },
    });
}

export async function deleteInternalSetting(db: DbOrTx, key: string): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, key));
}

/** Cheap change detector for the worker's config watcher. */
export async function settingsFingerprint(db: DbOrTx): Promise<string> {
  const [r] = await db
    .select({
      n: sql<number>`count(*)::int`,
      at: sql<string | null>`max(${appSettings.updatedAt})::text`,
    })
    .from(appSettings)
    .where(sql`${appSettings.key} NOT LIKE 'internal.%'`);
  return `${r?.n ?? 0}:${r?.at ?? ''}`;
}
