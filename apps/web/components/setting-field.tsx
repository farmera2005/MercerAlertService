'use client';

import type { FieldState } from '@/lib/settings';
import { Badge, FieldShell, Input, Select, Textarea } from './ui';

const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['America/New_York', 'America/Chicago', 'UTC'];
  }
})();

function sourceBadge(f: FieldState) {
  if (f.locked) return <Badge tone="info">set by environment</Badge>;
  if (f.undecryptable) return <Badge tone="bad">cannot decrypt — re-enter</Badge>;
  if (f.source === 'default') return <Badge>default</Badge>;
  return null;
}

/**
 * One registry-driven input. Uncontrolled by default; pass `value`/`onValue` to control it
 * (the Orion panel fills the certificate fields from a fetched certificate).
 */
export function SettingField({
  field: f,
  error,
  value,
  onValue,
  submitted,
}: {
  field: FieldState;
  error?: string;
  /** Controlled mode (bool: 'true' | 'false'). */
  value?: string;
  onValue?: (v: string) => void;
  /** Values echoed back after a failed save, so React's post-action form reset keeps the user's edits. */
  submitted?: Record<string, string>;
}) {
  const id = `f-${f.key}`;
  const controlled = value !== undefined && onValue !== undefined;
  const common = {
    id,
    name: f.key,
    disabled: f.locked,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-error` : undefined,
  };
  const initial = submitted && f.key in submitted ? submitted[f.key]! : f.value;
  const valueProps = controlled
    ? { value, onChange: (e: { target: { value: string } }) => onValue!(e.target.value) }
    : { defaultValue: initial };
  const checkedProps = controlled
    ? {
        checked: value === 'true',
        onChange: (e: { target: { checked: boolean } }) =>
          onValue!(e.target.checked ? 'true' : 'false'),
      }
    : {
        defaultChecked:
          submitted && f.key in submitted ? submitted[f.key] === 'on' : f.value === 'true',
      };

  let input;
  switch (f.kind) {
    case 'bool':
      return (
        <div className="space-y-1">
          <input type="hidden" name={`present:${f.key}`} value="1" />
          <label
            htmlFor={id}
            className={`flex items-start gap-3 text-sm ${f.danger ? 'text-red-200' : 'text-slate-200'}`}
          >
            <input
              id={id}
              name={f.key}
              type="checkbox"
              disabled={f.locked}
              {...checkedProps}
              className="mt-0.5 h-4 w-4 rounded border-white/20 bg-slate-900 accent-sky-500"
            />
            <span>
              <span className="font-medium">{f.label}</span> {sourceBadge(f)}
              {f.help && <span className="block text-xs text-slate-400">{f.help}</span>}
            </span>
          </label>
          {error && <p className="text-xs text-red-300">{error}</p>}
        </div>
      );
    case 'secret':
      input = (
        <div className="space-y-1">
          <Input
            {...common}
            type="password"
            autoComplete="new-password"
            placeholder={
              f.locked
                ? 'set by environment'
                : f.isSet
                  ? '•••••••• saved — leave blank to keep'
                  : 'not set'
            }
            {...(controlled ? valueProps : {})}
          />
          {f.isSet && !f.locked && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" name={`clear:${f.key}`} className="accent-sky-500" /> Remove
              the saved value
            </label>
          )}
        </div>
      );
      break;
    case 'pem':
      input = (
        <Textarea
          {...common}
          rows={8}
          spellCheck={false}
          placeholder="-----BEGIN CERTIFICATE-----"
          {...valueProps}
        />
      );
      break;
    case 'timezone':
      input = (
        <Select {...common} {...valueProps}>
          {[...new Set([f.value, ...TIMEZONES])].filter(Boolean).map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </Select>
      );
      break;
    case 'select':
      input = (
        <Select {...common} {...valueProps}>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
      break;
    case 'int':
    case 'number':
      input = (
        <Input
          {...common}
          type="number"
          inputMode={f.kind === 'int' ? 'numeric' : 'decimal'}
          step={f.kind === 'int' ? 1 : 0.05}
          min={f.min}
          max={f.max}
          placeholder={f.placeholder}
          {...valueProps}
        />
      );
      break;
    default:
      input = (
        <Input
          {...common}
          type={f.kind === 'url' ? 'url' : 'text'}
          placeholder={f.placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={f.kind === 'regex' || f.kind === 'cron' ? 'font-mono' : undefined}
          {...valueProps}
        />
      );
  }
  return (
    <FieldShell id={id} label={f.label} help={f.help} error={error} badge={sourceBadge(f)}>
      {!f.locked && <input type="hidden" name={`present:${f.key}`} value="1" />}
      {input}
    </FieldShell>
  );
}
