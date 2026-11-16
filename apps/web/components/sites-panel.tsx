'use client';

import { useActionState } from 'react';
import {
  deleteSiteAction,
  mapOrionSiteValueAction,
  saveSiteAction,
  type FormState,
} from '@/app/actions/settings';
import { Alert, Badge, Button, Card, FieldShell, Input, Select } from './ui';

export interface SiteView {
  id: number;
  code: string;
  name: string;
  divisionCode: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
  tier: 'critical' | 'high' | 'standard';
  harvestCritical: boolean;
  aliases: string[];
  ownerGroup: string | null;
  contactNotes: string | null;
  profileStatus: 'placeholder' | 'auto' | 'confirmed';
  nodeCount: number;
}

export interface DivisionView {
  code: string;
  name: string;
}

const STATUS_TONE = { placeholder: 'warn', auto: 'info', confirmed: 'ok' } as const;

function SiteForm({
  site,
  divisions,
  onDoneLabel,
}: {
  site?: SiteView;
  divisions: DivisionView[];
  onDoneLabel: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveSiteAction, {});
  const id = site ? `s${site.id}` : 'new';
  const e = state.errors ?? {};
  const v = state.values;
  const dv = (key: string, fallback: string | number | null | undefined) =>
    v && key in v ? v[key] : (fallback ?? '');
  return (
    <form action={action} className="space-y-4" noValidate>
      {site && <input type="hidden" name="id" value={site.id} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <FieldShell id={`${id}-name`} label="Name" error={e.name}>
          <Input id={`${id}-name`} name="name" defaultValue={dv('name', site?.name)} required />
        </FieldShell>
        <FieldShell id={`${id}-div`} label="Division">
          <Select
            id={`${id}-div`}
            name="divisionCode"
            defaultValue={dv('divisionCode', site?.divisionCode)}
          >
            <option value="">(unassigned)</option>
            {divisions.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </Select>
        </FieldShell>
        <FieldShell id={`${id}-tier`} label="Tier" help="Critical sites are paged first.">
          <Select id={`${id}-tier`} name="tier" defaultValue={dv('tier', site?.tier ?? 'standard')}>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="standard">Standard</option>
          </Select>
        </FieldShell>
        <FieldShell id={`${id}-city`} label="City">
          <Input id={`${id}-city`} name="city" defaultValue={dv('city', site?.city)} />
        </FieldShell>
        <FieldShell id={`${id}-lat`} label="Latitude" error={e.lat}>
          <Input
            id={`${id}-lat`}
            name="lat"
            inputMode="decimal"
            defaultValue={dv('lat', site?.lat)}
            placeholder="40.5489"
          />
        </FieldShell>
        <FieldShell id={`${id}-lon`} label="Longitude" error={e.lon}>
          <Input
            id={`${id}-lon`}
            name="lon"
            inputMode="decimal"
            defaultValue={dv('lon', site?.lon)}
            placeholder="-84.5702"
          />
        </FieldShell>
        <div className="sm:col-span-2">
          <FieldShell
            id={`${id}-aliases`}
            label="Other names"
            help="Comma-separated. Orion “Site” values and hostname prefixes that mean this site."
          >
            <Input
              id={`${id}-aliases`}
              name="aliases"
              defaultValue={dv('aliases', site?.aliases.join(', '))}
              placeholder="ROCK, Rockford"
            />
          </FieldShell>
        </div>
        <FieldShell id={`${id}-owner`} label="Owner / contact group">
          <Input
            id={`${id}-owner`}
            name="ownerGroup"
            defaultValue={dv('ownerGroup', site?.ownerGroup)}
          />
        </FieldShell>
      </div>
      <input type="hidden" name="state" value={site?.state ?? 'OH'} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="harvestCritical"
          defaultChecked={v ? v.harvestCritical === 'on' : site?.harvestCritical}
          className="accent-sky-500"
        />
        Harvest-critical (scales/receiving — 4-hour recovery target during harvest)
      </label>
      {state.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : onDoneLabel}
      </Button>
    </form>
  );
}

export function SitesPanel({
  sites,
  divisions,
  unmatched,
}: {
  sites: SiteView[];
  divisions: DivisionView[];
  unmatched: Array<{ value: string; nodes: number }>;
}) {
  const divName = new Map(divisions.map((d) => [d.code, d.name]));
  return (
    <div className="space-y-6">
      {unmatched.length > 0 && (
        <Card
          title="Orion site values without a profile"
          description="Map each value to an existing site (it becomes an alias) or create a new site for it."
        >
          <ul className="divide-y divide-white/5">
            {unmatched.map((u) => (
              <li key={u.value} className="py-3">
                <form
                  action={mapOrionSiteValueAction}
                  className="flex flex-wrap items-center gap-3"
                >
                  <input type="hidden" name="value" value={u.value} />
                  <span className="min-w-48 font-medium">{u.value}</span>
                  <span className="text-xs text-slate-400">{u.nodes} nodes</span>
                  <Select
                    name="target"
                    defaultValue="new"
                    className="w-56"
                    aria-label={`Map ${u.value} to`}
                  >
                    <option value="new">Create a new site</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        Same as: {s.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    name="divisionCode"
                    defaultValue=""
                    className="w-48"
                    aria-label="Division for a new site"
                  >
                    <option value="">Division (for new)</option>
                    {divisions.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                  <Button type="submit" variant="secondary">
                    Apply
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title={`Site profiles (${sites.length})`}
        description="Tier and harvest-critical drive incident priority. Placeholder sites came with the install — confirm or delete them."
      >
        <ul className="divide-y divide-white/5">
          {sites.map((s) => (
            <li key={s.id}>
              <details className="group py-3">
                <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-slate-100">{s.name}</span>
                  <span className="text-slate-400">
                    {s.divisionCode ? divName.get(s.divisionCode) : 'no division'}
                  </span>
                  <Badge
                    tone={s.tier === 'critical' ? 'bad' : s.tier === 'high' ? 'warn' : 'neutral'}
                  >
                    {s.tier}
                  </Badge>
                  {s.harvestCritical && <Badge tone="warn">harvest-critical</Badge>}
                  <Badge tone={STATUS_TONE[s.profileStatus]}>{s.profileStatus}</Badge>
                  <span className="text-xs text-slate-500">{s.nodeCount} nodes</span>
                </summary>
                <div className="mt-4 space-y-4 rounded-lg border border-white/10 p-4">
                  <SiteForm site={s} divisions={divisions} onDoneLabel="Save site" />
                  <form
                    action={deleteSiteAction}
                    onSubmit={(e) => {
                      if (!confirm(`Delete ${s.name}? Its nodes become unmapped.`))
                        e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="id" value={s.id} />
                    <Button type="submit" variant="ghost" className="text-red-300">
                      Delete site
                    </Button>
                  </form>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Add a site">
        <SiteForm divisions={divisions} onDoneLabel="Add site" />
      </Card>
    </div>
  );
}
