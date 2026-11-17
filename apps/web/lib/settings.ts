import 'server-only';
import { X509Certificate } from 'node:crypto';
import {
  ConfigError,
  envConfigKeys,
  envSchema,
  isSecretSetting,
  loadConfig,
  resolveFileEnv,
  SETTINGS,
  SETTINGS_BY_KEY,
  type AppConfig,
  type SettingDef,
  type SettingKind,
  type SettingSection,
} from '@mercer/core';
import { loadSettings, saveSettings, type LoadedSettings } from '@mercer/db';
import type { Actor } from './auth';
import { server } from './server';

export type FieldSource = 'env' | 'saved' | 'default';

/** What a settings form needs for one field. Secret values never leave the server. */
export interface FieldState {
  key: string;
  label: string;
  help?: string;
  kind: SettingKind;
  placeholder?: string;
  advanced?: boolean;
  danger?: boolean;
  min?: number;
  max?: number;
  options?: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  isSet: boolean;
  source: FieldSource;
  locked: boolean;
  undecryptable?: boolean;
}

export interface SettingsState {
  saved: LoadedSettings;
  envKeys: Set<string>;
  /** Effective configuration, or null when the saved settings are invalid. */
  cfg: AppConfig | null;
  configError: string | null;
}

function defaultValue(key: string): string {
  const shape = envSchema.shape as Record<
    string,
    { safeParse(v: unknown): { success: boolean; data?: unknown } }
  >;
  const r = shape[key]?.safeParse(undefined);
  if (!r?.success || r.data === undefined || r.data === null) return '';
  return String(r.data);
}

export async function getSettingsState(): Promise<SettingsState> {
  const { db, box } = server();
  const saved = await loadSettings(db.db, box);
  const envKeys = envConfigKeys();
  try {
    return { saved, envKeys, cfg: loadConfig(process.env, saved.values), configError: null };
  } catch (err) {
    return {
      saved,
      envKeys,
      cfg: null,
      configError: err instanceof Error ? err.message : String(err),
    };
  }
}

const g = globalThis as unknown as {
  __masSettings?: { at: number; state: Promise<SettingsState> };
};

/**
 * Settings for hot paths (every request checks sign-in and the client IP). A few seconds stale at
 * most; saving here or a `config` bus event (another web replica, the setup wizard) clears it.
 */
export function cachedSettingsState(maxAgeMs = 5000): Promise<SettingsState> {
  const c = g.__masSettings;
  if (c && Date.now() - c.at < maxAgeMs) return c.state;
  const state = getSettingsState();
  g.__masSettings = { at: Date.now(), state };
  state.catch(() => {
    if (g.__masSettings?.state === state) g.__masSettings = undefined;
  });
  return state;
}

export function invalidateSettingsCache(): void {
  g.__masSettings = undefined;
}

/** Effective config for hot paths, falling back to environment-only config if saved settings are invalid. */
export async function effectiveConfig(): Promise<AppConfig> {
  try {
    return (await cachedSettingsState()).cfg ?? server().bootstrap;
  } catch {
    return server().bootstrap;
  }
}

export function fieldState(def: SettingDef, state: SettingsState): FieldState {
  const env = resolveFileEnv(process.env, (k) => k === def.key);
  const locked = state.envKeys.has(def.key);
  const savedValue = state.saved.values[def.key];
  const secret = def.kind === 'secret';
  const source: FieldSource = locked ? 'env' : savedValue !== undefined ? 'saved' : 'default';
  const raw = locked ? (env[def.key] ?? '') : (savedValue ?? defaultValue(def.key));
  return {
    key: def.key,
    label: def.label,
    help: def.help,
    kind: def.kind,
    placeholder: def.placeholder,
    advanced: def.advanced,
    danger: def.danger,
    min: def.min,
    max: def.max,
    options: def.options,
    value: secret ? '' : raw,
    isSet: secret ? !!raw : raw !== '',
    source,
    locked,
    undecryptable: state.saved.undecryptable.includes(def.key) || undefined,
  };
}

export function sectionFields(section: SettingSection, state: SettingsState): FieldState[] {
  return SETTINGS.filter((d) => d.section === section).map((d) => fieldState(d, state));
}

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------

export type SaveResult =
  { ok: true; message?: string } | { ok: false; message: string; errors: Record<string, string> };

/** Translate a submitted form into setting changes for the given keys. */
export function changesFromForm(form: FormData, keys: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) continue;
    if (!form.has(`present:${key}`)) continue; // field not rendered (e.g. locked)
    const raw = form.get(key);
    const value = typeof raw === 'string' ? raw : '';
    switch (def.kind) {
      case 'secret':
        if (form.get(`clear:${key}`) === 'on') out[key] = null;
        else if (value !== '') out[key] = value;
        break;
      case 'bool':
        out[key] = value === 'on' || value === 'true' ? 'true' : 'false';
        break;
      case 'pem':
        out[key] = value.trim() ? value.replace(/\r\n/g, '\n').trim() + '\n' : null;
        break;
      case 'textarea':
        out[key] = value.trim() ? value.replace(/\r\n/g, '\n').trim() : null;
        break;
      default:
        out[key] = value.trim() === '' ? null : value.trim();
    }
  }
  return out;
}

function validateKind(def: SettingDef, value: string): string | null {
  switch (def.kind) {
    case 'host':
      return /^[A-Za-z0-9.-]+$|^\[?[0-9a-fA-F:]+\]?$/.test(value)
        ? null
        : 'Enter a host name or IP address (no http://, no port).';
    case 'url':
      try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:'
          ? null
          : 'Use an http:// or https:// address.';
      } catch {
        return 'Enter a full address, e.g. https://netmon.mercer.local';
      }
    case 'pem':
      try {
        new X509Certificate(value);
        return null;
      } catch {
        return 'This is not a valid PEM certificate (-----BEGIN CERTIFICATE----- …).';
      }
    case 'int':
    case 'number': {
      const n = Number(value);
      if (def.kind === 'int' ? !Number.isInteger(n) : !Number.isFinite(n))
        return def.kind === 'int' ? 'Enter a whole number.' : 'Enter a number.';
      if (def.min !== undefined && n < def.min) return `Must be at least ${def.min}.`;
      if (def.max !== undefined && n > def.max) return `Must be at most ${def.max}.`;
      return null;
    }
    case 'select':
      return def.options?.some((o) => o.value === value) ? null : 'Choose one of the options.';
    case 'textarea':
      return value.length > 4000 ? 'Keep this under 4,000 characters.' : null;
    case 'cron':
      return value.trim().split(/\s+/).length === 5
        ? null
        : 'Use a 5-field cron expression, e.g. 15 3 * * *';
    default:
      return null;
  }
}

/**
 * Validate (field rules + the full config schema) and save. Environment-locked keys are ignored.
 * `extra` allows internal keys such as MAS_SETUP_COMPLETE.
 */
export async function saveChanges(
  changes: Record<string, string | null>,
  actor: Actor,
  extra: Record<string, string | null> = {},
): Promise<SaveResult> {
  const { db, box } = server();
  const state = await getSettingsState();
  const errors: Record<string, string> = {};
  const accepted: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (state.envKeys.has(key)) continue;
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) continue;
    if (value !== null) {
      const err = validateKind(def, value);
      if (err) {
        errors[key] = err;
        continue;
      }
    }
    accepted[key] = value;
  }
  if (Object.keys(errors).length)
    return { ok: false, message: 'Please fix the highlighted fields.', errors };

  const all = { ...accepted, ...extra };
  const candidate: Record<string, string> = { ...state.saved.values };
  for (const [k, v] of Object.entries(all)) {
    if (v === null) delete candidate[k];
    else candidate[k] = v;
  }
  try {
    loadConfig(process.env, candidate);
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const i of err.issues) errors[i.key] = i.message;
      return { ok: false, message: 'Please fix the highlighted fields.', errors };
    }
    throw err;
  }
  // A value equal to the built-in default is not stored (or is removed), so improved defaults in
  // a later release still apply to settings nobody changed.
  const list = Object.entries(all)
    .map(([k, v]): [string, string | null] => [
      k,
      v !== null && !isSecretSetting(k) && v === defaultValue(k) ? null : v,
    ])
    .filter(([k, v]) => (v === null ? k in state.saved.values : state.saved.values[k] !== v))
    .map(([key, value]) => ({ key, value }));
  await saveSettings(db.db, list, actor, box);
  invalidateSettingsCache();
  return { ok: true, message: list.length ? 'Saved.' : 'No changes.' };
}
