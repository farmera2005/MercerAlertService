'use client';

import { useActionState, useMemo, useState, useTransition } from 'react';
import type { DiscoveryReport } from '@mercer/swis/setup-contract';
import {
  runDiscoveryAction,
  saveSectionsAction,
  setSiteGroupDecisionAction,
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

type Decision = 'site' | 'not_site';

export interface SiteGroupPreview {
  mode: 'manual' | 'auto' | 'off';
  /** Groups in the last groups poll (0 = not polled yet). */
  groupsPolled: number;
  rows: Array<{
    containerId: number;
    /** An admin's choice for this group, if any. */
    decided: Decision | null;
    groupName: string;
    siteName: string;
    devices: number;
    linkedSite: string | null;
    /** Why automatic detection chose it. */
    reason: string | null;
  }>;
  /** Groups automatic detection did not use (or an admin marked), and why. */
  rejected: Array<{
    containerId: number;
    decided: Decision | null;
    groupName: string;
    reason: string;
  }>;
}

/**
 * One group's correction. A plain button calling the action (not a form submit), so unsaved edits
 * in the mapping form around it are kept.
 */
function DecisionButton({
  containerId,
  groupName,
  decision,
  label,
}: {
  containerId: number;
  groupName: string;
  decision: Decision | null;
  label: string;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      className="px-2 py-0.5 text-xs"
      disabled={pending}
      aria-label={`${label}: ${groupName}`}
      onClick={() => start(() => setSiteGroupDecisionAction(containerId, groupName, decision))}
    >
      {pending ? 'Saving…' : label}
    </Button>
  );
}

function siteGroupStatus(p: SiteGroupPreview): string {
  if (p.groupsPolled === 0)
    return 'No groups read from SolarWinds yet. Groups are read every few minutes once monitoring has started.';
  if (p.mode === 'off') return `Not used. ${p.groupsPolled} groups found in SolarWinds.`;
  if (p.mode === 'manual')
    return p.rows.length
      ? `Chosen by the group name or pattern below: ${p.rows.length} of ${p.groupsPolled} groups are sites.`
      : `None of the ${p.groupsPolled} groups match the group name or pattern below.`;
  return p.rows.length
    ? `Found automatically: ${p.rows.length} of ${p.groupsPolled} groups are sites.`
    : `None of the ${p.groupsPolled} groups look like sites, so devices are placed by custom property.`;
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
  const showWhy = siteGroups.mode === 'auto' || siteGroups.rows.some((r) => r.decided);

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
          <div className="space-y-4" data-testid="site-groups">
            {f.SITE_GROUP_AUTO && <SettingField field={f.SITE_GROUP_AUTO} />}
            <p className="text-sm text-slate-300" data-testid="site-group-status">
              {siteGroupStatus(siteGroups)}
            </p>
          </div>
          {siteGroups.rows.length > 0 && (
            <table className="mt-4 w-full text-left text-sm" data-testid="site-group-rows">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-1 pr-4">SolarWinds group</th>
                  <th className="py-1 pr-4 text-right">Devices</th>
                  <th className="py-1 pr-4">Site in MAS</th>
                  {showWhy && <th className="py-1 pr-4">Why it is a site</th>}
                  <th className="py-1">
                    <span className="sr-only">Change</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {siteGroups.rows.map((r) => (
                  <tr key={r.containerId} className="border-t border-white/5 align-top">
                    <td className="py-1.5 pr-4">{r.groupName}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{r.devices}</td>
                    <td className={`py-1.5 pr-4 ${r.linkedSite ? '' : 'text-amber-300'}`}>
                      {r.linkedSite ?? `“${r.siteName}”, at the next groups poll`}
                    </td>
                    {showWhy && (
                      <td className="py-1.5 pr-4 text-xs leading-5 text-slate-400">{r.reason}</td>
                    )}
                    <td className="py-1 text-right">
                      <DecisionButton
                        containerId={r.containerId}
                        groupName={r.groupName}
                        decision={r.decided === 'site' ? null : 'not_site'}
                        label={r.decided === 'site' ? 'Undo' : 'Not a site'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {siteGroups.mode !== 'off' && siteGroups.rejected.length > 0 && (
            <details className="mt-4 text-sm" data-testid="site-group-rejected">
              <summary className="cursor-pointer text-slate-300">
                Groups that are not sites ({siteGroups.rejected.length})
              </summary>
              <p className="mt-2 text-xs text-slate-400">
                If one of these is a site, choose “Use as a site”. Your choice is kept, and the site
                appears at once.
              </p>
              <ul className="mt-2 divide-y divide-white/5">
                {siteGroups.rejected.map((r) => (
                  <li key={r.containerId} className="flex items-start justify-between gap-4 py-1.5">
                    <span>
                      {r.groupName} <span className="text-xs text-slate-400">— {r.reason}</span>
                    </span>
                    <DecisionButton
                      containerId={r.containerId}
                      groupName={r.groupName}
                      decision={r.decided === 'not_site' ? null : 'site'}
                      label={r.decided === 'not_site' ? 'Undo' : 'Use as a site'}
                    />
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details
            className="mt-4 rounded-lg border border-white/10 p-4"
            open={!!(f.SITE_GROUP_PARENT?.value || f.SITE_GROUP_PATTERN?.value)}
          >
            <summary className="cursor-pointer text-sm font-medium text-slate-300">
              Choose the groups yourself
            </summary>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
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
          </details>
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
