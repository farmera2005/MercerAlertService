'use client';

import { useActionState, useMemo, useState } from 'react';
import type { DiscoveryReport } from '@mercer/swis/setup-contract';
import {
  runDiscoveryAction,
  saveSectionsAction,
  type DiscoverState,
  type FormState,
} from '@/app/actions/settings';
import type { FieldState } from '@/lib/settings';
import { SettingField } from './setting-field';
import { Alert, Badge, Button, Card, FieldShell, Select } from './ui';

const norm = (v: string) =>
  v
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');

export interface SiteKey {
  key: string;
  name: string;
}

function CpSelect({
  field,
  options,
  error,
  onChange,
}: {
  field: FieldState;
  options: string[];
  error?: string;
  onChange?: (v: string) => void;
}) {
  const id = `f-${field.key}`;
  const all = [...new Set([...(field.value ? [field.value] : []), ...options])];
  return (
    <FieldShell
      id={id}
      label={field.label}
      help={field.help}
      error={error}
      badge={
        field.locked ? (
          <Badge tone="info">set by environment</Badge>
        ) : field.value && !options.includes(field.value) && options.length ? (
          <Badge tone="warn">not found in Orion</Badge>
        ) : null
      }
    >
      {!field.locked && <input type="hidden" name={`present:${field.key}`} value="1" />}
      <Select
        id={id}
        name={field.key}
        defaultValue={field.value}
        disabled={field.locked}
        onChange={(e) => onChange?.(e.target.value)}
      >
        <option value="">(none)</option>
        {all.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </FieldShell>
  );
}

export interface SiteGroupPreview {
  /** Groups in the last groups poll (0 = not polled yet). */
  groupsPolled: number;
  rows: Array<{ groupName: string; siteName: string; devices: number; linkedSite: string | null }>;
}

export function MappingPanel({
  fields,
  discovery,
  sites,
  siteGroups,
}: {
  fields: FieldState[];
  discovery: { at: string; report: DiscoveryReport } | null;
  sites: SiteKey[];
  siteGroups: SiteGroupPreview;
}) {
  const f = Object.fromEntries(fields.map((x) => [x.key, x])) as Record<string, FieldState>;
  const [discState, discAction, discovering] = useActionState<DiscoverState>(
    runDiscoveryAction,
    {},
  );
  const [saveState, saveAction, saving] = useActionState<FormState, FormData>(
    saveSectionsAction.bind(null, ['mapping']),
    {},
  );
  const [siteField, setSiteField] = useState(f.CP_SITE_FIELD?.value ?? '');
  const report = discovery?.report;
  const cps = report?.customProperties ?? [];
  const cpNames = cps.map((c) => c.field);
  const siteIndex = useMemo(() => new Map(sites.map((s) => [s.key, s.name])), [sites]);
  const values = cps.find((c) => c.field === siteField)?.topValues ?? [];
  const missingRequired = report?.fields.filter((x) => x.required && !x.present) ?? [];
  const missingOptional = report?.fields.filter((x) => !x.required && !x.present) ?? [];
  const failedChecks = report?.queryChecks.filter((q) => !q.ok) ?? [];

  return (
    <div className="space-y-6">
      <Card
        title="Discover your Orion"
        description="Reads entity fields, custom properties and counts so the mapping below uses your real names. Read-only."
        actions={
          <form action={discAction}>
            <Button type="submit" variant="secondary" disabled={discovering}>
              {discovering ? 'Running discovery…' : report ? 'Run again' : 'Run discovery'}
            </Button>
          </form>
        }
      >
        {discState.message && <Alert tone="info">{discState.message}</Alert>}
        {discState.result && !discState.result.ok && (
          <Alert tone="error" title="Discovery failed">
            {discState.result.hint ?? discState.result.error}
          </Alert>
        )}
        {!report && (
          <p className="text-sm text-slate-400">
            Not run yet. Save a working connection on the previous step first.
          </p>
        )}
        {report && (
          <div className="space-y-4 text-sm">
            <p className="text-slate-400">
              Last run {new Date(discovery!.at).toLocaleString('en-US')}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(report.counts).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-white/10 p-3">
                  <div className="text-xs text-slate-400">
                    {k.replace(/([A-Z])/g, ' $1').toLowerCase()}
                  </div>
                  <div className="text-xl font-semibold">
                    {typeof v === 'number' ? v.toLocaleString('en-US') : v}
                  </div>
                </div>
              ))}
            </div>
            {missingRequired.length > 0 ? (
              <Alert tone="error" title="Required fields missing in this Orion version">
                {missingRequired.map((m) => `${m.entity}.${m.prop}`).join(', ')}
              </Alert>
            ) : (
              <Alert tone="success">
                Every field MAS needs exists in this Orion.
                {missingOptional.length > 0 &&
                  ` ${missingOptional.length} optional fields are not available and will be skipped.`}
              </Alert>
            )}
            {failedChecks.length > 0 && (
              <Alert tone="warning" title="Some queries failed">
                {failedChecks.map((q) => `${q.query}: ${q.error}`).join(' · ')}
              </Alert>
            )}
            {report.counts.dependencies === 0 && (
              <Alert tone="warning">
                No Orion dependencies are configured. Correlation will rely on topology and
                same-site grouping.
              </Alert>
            )}
            {report.serverTime && (
              <p className="text-xs text-slate-400">
                Orion time — UTC: {String(report.serverTime.utcNow)} · local:{' '}
                {String(report.serverTime.localNow)} · sample alert time:{' '}
                {String(report.serverTime.sampleTriggeredDateTime ?? '—')}
              </p>
            )}
          </div>
        )}
      </Card>

      <form action={saveAction} className="space-y-6" noValidate>
        <Card
          title="Sites from SolarWinds groups"
          description="If each site is a group in SolarWinds, MAS keeps one site per group: same name, and the group description as the site notes. Devices go to the site whose group contains them; the custom properties below are the fallback."
        >
          <div className="grid gap-5 sm:grid-cols-2" data-testid="site-groups">
            {f.SITE_GROUP_PARENT && (
              <SettingField
                field={f.SITE_GROUP_PARENT}
                error={saveState.errors?.SITE_GROUP_PARENT}
              />
            )}
            {f.SITE_GROUP_PATTERN && (
              <SettingField
                field={f.SITE_GROUP_PATTERN}
                error={saveState.errors?.SITE_GROUP_PATTERN}
              />
            )}
          </div>
          {siteGroups.rows.length > 0 ? (
            <table className="mt-6 w-full text-left text-sm" data-testid="site-group-rows">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-1">SolarWinds group</th>
                  <th>Devices</th>
                  <th>Site in MAS</th>
                </tr>
              </thead>
              <tbody>
                {siteGroups.rows.map((r) => (
                  <tr key={r.groupName} className="border-t border-white/5">
                    <td className="py-1.5">{r.groupName}</td>
                    <td className="tabular-nums">{r.devices}</td>
                    <td className={r.linkedSite ? '' : 'text-amber-300'}>
                      {r.linkedSite ?? `“${r.siteName}” is created at the next groups poll`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-4 text-sm text-slate-400">
              {siteGroups.groupsPolled === 0
                ? 'No groups read from SolarWinds yet. The groups poll runs every few minutes once monitoring has started.'
                : (f.SITE_GROUP_PARENT?.value ?? '') || (f.SITE_GROUP_PATTERN?.value ?? '')
                  ? `None of the ${siteGroups.groupsPolled} SolarWinds groups match. Check the group name or pattern.`
                  : `Not used: ${siteGroups.groupsPolled} groups found in SolarWinds. Set the parent group or a name pattern to use them as sites.`}
            </p>
          )}
        </Card>

        <Card
          title="Site & division mapping"
          description="Pick the node custom properties that say where each device lives."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            {f.CP_SITE_FIELD && (
              <CpSelect
                field={f.CP_SITE_FIELD}
                options={cpNames}
                error={saveState.errors?.CP_SITE_FIELD}
                onChange={setSiteField}
              />
            )}
            {f.CP_DIVISION_FIELD && (
              <CpSelect
                field={f.CP_DIVISION_FIELD}
                options={cpNames}
                error={saveState.errors?.CP_DIVISION_FIELD}
              />
            )}
            {f.CP_CITY_FIELD && (
              <CpSelect
                field={f.CP_CITY_FIELD}
                options={cpNames}
                error={saveState.errors?.CP_CITY_FIELD}
              />
            )}
            {f.CP_ROLE_FIELD && (
              <CpSelect
                field={f.CP_ROLE_FIELD}
                options={cpNames}
                error={saveState.errors?.CP_ROLE_FIELD}
              />
            )}
            {f.SITE_FROM_CAPTION_REGEX && (
              <div className="sm:col-span-2">
                <SettingField
                  field={f.SITE_FROM_CAPTION_REGEX}
                  error={saveState.errors?.SITE_FROM_CAPTION_REGEX}
                />
              </div>
            )}
            {f.SITE_AUTO_CREATE && (
              <div className="sm:col-span-2">
                <SettingField field={f.SITE_AUTO_CREATE} />
              </div>
            )}
          </div>
          {values.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-medium text-slate-200">
                Values of “{siteField}” in Orion
              </h3>
              <table className="mt-2 w-full text-left text-sm">
                <thead className="text-xs text-slate-400">
                  <tr>
                    <th className="py-1">Value</th>
                    <th>Nodes</th>
                    <th>Site profile</th>
                  </tr>
                </thead>
                <tbody>
                  {values.map((v) => {
                    const label = v.value === null || v.value === '' ? null : String(v.value);
                    const match = label ? siteIndex.get(norm(label)) : undefined;
                    return (
                      <tr key={String(v.value)} className="border-t border-white/5">
                        <td className="py-1.5">
                          {label ?? <span className="text-slate-500">(empty)</span>}
                        </td>
                        <td>{v.nodes}</td>
                        <td>
                          {!label ? (
                            <span className="text-xs text-slate-400">
                              falls back to hostname prefix
                            </span>
                          ) : match ? (
                            <Badge tone="ok">{match}</Badge>
                          ) : (
                            <Badge tone="warn">no match — resolve on the Sites step</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {saveState.message && (
          <Alert tone={saveState.ok ? 'success' : 'error'}>{saveState.message}</Alert>
        )}
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save mapping'}
        </Button>
      </form>
    </div>
  );
}
