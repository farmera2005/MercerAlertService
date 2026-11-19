'use client';

import { useActionState } from 'react';
import {
  deleteSiteAction,
  mapOrionSiteValueAction,
  placeUnplacedSitesAction,
  saveSiteAction,
  type FormState,
} from '@/app/actions/settings';
import { Alert, Badge, Button, Card, Checks, FieldShell, Input, Select, Textarea } from './ui';

export interface SiteView {
  id: number;
  code: string;
  name: string;
  divisionCodes: string[];
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
  mapX: number | null;
  mapY: number | null;
  tier: 'critical' | 'high' | 'standard';
  harvestCritical: boolean;
  aliases: string[];
  ownerGroup: string | null;
  contactNotes: string | null;
  profileStatus: 'placeholder' | 'auto' | 'confirmed';
  /** Where its map position came from (see the Address field). */
  geoStatus: 'pending' | 'ok' | 'not_found' | 'failed' | 'manual' | null;
  geoLabel: string | null;
  geoError: string | null;
  nodeCount: number;
  /** The SolarWinds site group this site corresponds to; its description is the site notes. */
  group: { name: string | null; notes: string | null } | null;
  notesWrite: {
    status: 'pending' | 'ok' | 'conflict' | 'failed' | 'skipped';
    error: string | null;
    at: string;
    by: string;
  } | null;
}

const WRITE_TEXT = {
  pending: 'Saving to SolarWinds…',
  ok: 'Saved to SolarWinds',
  conflict: 'Not saved',
  failed: 'Not saved',
  skipped: 'Not saved',
} as const;

/** What the address lookup did for this site. */
function geoText(site: SiteView | undefined, lookupOn: boolean): string {
  if (!lookupOn)
    return 'Address lookup is off (Settings → Map & wall), so type the latitude and longitude.';
  switch (site?.geoStatus) {
    case 'ok':
      return `On the map at: ${site.geoLabel ?? 'the address'}.`;
    case 'pending':
      return 'Looking up the address…';
    case 'not_found':
      return 'The address was not found. Check it, or type the latitude and longitude.';
    case 'failed':
      return `The lookup failed (${site.geoError ?? 'unknown error'}). Save again to retry.`;
    case 'manual':
      return 'Placed by the latitude and longitude typed below. Clear them to use the address.';
    default:
      return 'Places the site on the map (looked up with OpenStreetMap). Without one, the city is used.';
  }
}

/** Where the site's notes live, and the last attempt to change them from MAS. */
function NotesField({
  site,
  id,
  writebackEnabled,
  error,
  value,
}: {
  site?: SiteView;
  id: string;
  writebackEnabled: boolean;
  error?: string;
  value: (key: string, fallback: string | null | undefined) => string | number | undefined;
}) {
  if (site?.group) {
    const w = site.notesWrite;
    const groupName = site.group.name ?? 'missing in SolarWinds';
    return (
      <div className="sm:col-span-3" data-testid={`site-notes-${site.code}`}>
        <FieldShell
          id={`${id}-notes`}
          label="Notes"
          error={error}
          help={
            writebackEnabled
              ? `Stored in SolarWinds as the description of the group “${groupName}”. Changes are written there with the write-back account.`
              : `Stored in SolarWinds as the description of the group “${groupName}”. Edit them there, or turn on Orion write-back (Settings → SolarWinds) to edit them here.`
          }
        >
          <input type="hidden" name="groupNotesBase" value={site.group.notes ?? ''} />
          <Textarea
            id={`${id}-notes`}
            name="groupNotes"
            rows={4}
            maxLength={4000}
            readOnly={!writebackEnabled || w?.status === 'pending'}
            defaultValue={String(value('groupNotes', site.group.notes) ?? '')}
          />
        </FieldShell>
        {w && w.status !== 'ok' && (
          <p
            className={`mt-1 text-xs ${w.status === 'pending' ? 'text-slate-400' : 'text-amber-300'}`}
            data-testid="site-notes-write"
            data-status={w.status}
          >
            {WRITE_TEXT[w.status]}
            {w.error ? `: ${w.error}` : ''} ({w.by}, {new Date(w.at).toLocaleString('en-US')})
          </p>
        )}
        {w?.status === 'ok' && (
          <p
            className="mt-1 text-xs text-slate-500"
            data-testid="site-notes-write"
            data-status="ok"
          >
            {WRITE_TEXT.ok} by {w.by}, {new Date(w.at).toLocaleString('en-US')}.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="sm:col-span-3">
      <FieldShell
        id={`${id}-notes`}
        label="Notes"
        error={error}
        help="Kept in MAS. Sites that come from SolarWinds groups keep their notes in the group description."
      >
        <Textarea
          id={`${id}-notes`}
          name="contactNotes"
          rows={3}
          maxLength={4000}
          defaultValue={String(value('contactNotes', site?.contactNotes) ?? '')}
        />
      </FieldShell>
    </div>
  );
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
  writebackEnabled,
  addressLookup,
}: {
  site?: SiteView;
  divisions: DivisionView[];
  onDoneLabel: string;
  writebackEnabled: boolean;
  addressLookup: boolean;
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
        <div className="sm:col-span-2">
          <FieldShell
            id={`${id}-name`}
            label="Name"
            error={e.name}
            help={site?.group ? 'Follows the SolarWinds group name.' : undefined}
          >
            <Input
              id={`${id}-name`}
              name="name"
              defaultValue={dv('name', site?.name)}
              readOnly={!!site?.group}
              className={site?.group ? 'text-slate-400' : undefined}
              required
            />
          </FieldShell>
        </div>
        <FieldShell id={`${id}-tier`} label="Tier" help="Critical sites are paged first.">
          <Select id={`${id}-tier`} name="tier" defaultValue={dv('tier', site?.tier ?? 'standard')}>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="standard">Standard</option>
          </Select>
        </FieldShell>
        <div className="sm:col-span-3">
          <Checks
            name="divisionCodes"
            label="Divisions"
            values={divisions.map((d) => [d.code, d.name])}
            selected={
              v && 'divisionCodes' in v
                ? v.divisionCodes!.split(',').filter(Boolean)
                : (site?.divisionCodes ?? [])
            }
            help="Every division at this location. Incidents here go to each division’s routing rules and seasons."
          />
        </div>
        <div className="sm:col-span-2">
          <FieldShell
            id={`${id}-address`}
            label="Address"
            help={<span data-testid="geo-status">{geoText(site, addressLookup)}</span>}
          >
            <Input
              id={`${id}-address`}
              name="address"
              autoComplete="street-address"
              defaultValue={dv('address', site?.address)}
              placeholder="100 W Main St, Rockford, OH 45882"
            />
          </FieldShell>
        </div>
        <FieldShell id={`${id}-city`} label="City">
          <Input id={`${id}-city`} name="city" defaultValue={dv('city', site?.city)} />
        </FieldShell>
        <FieldShell
          id={`${id}-lat`}
          label="Latitude"
          error={e.lat}
          help={addressLookup ? 'Filled in from the address.' : undefined}
        >
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
        <FieldShell
          id={`${id}-mapX`}
          label="Map X (offline map)"
          error={e.mapX}
          help="Only for an uploaded map image: pixels from the left edge."
        >
          <Input
            id={`${id}-mapX`}
            name="mapX"
            inputMode="numeric"
            defaultValue={dv('mapX', site?.mapX)}
          />
        </FieldShell>
        <FieldShell
          id={`${id}-mapY`}
          label="Map Y (offline map)"
          error={e.mapY}
          help="Pixels from the top edge."
        >
          <Input
            id={`${id}-mapY`}
            name="mapY"
            inputMode="numeric"
            defaultValue={dv('mapY', site?.mapY)}
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
        <NotesField
          site={site}
          id={id}
          writebackEnabled={writebackEnabled}
          error={e.groupNotes}
          value={dv}
        />
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

/** Look up every site that has an address (or city) but no place on the map. */
function PlaceAll({ count }: { count: number }) {
  const [state, action, pending] = useActionState<FormState>(placeUnplacedSitesAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Queuing…' : `Place ${count} site${count === 1 ? '' : 's'} on the map`}
      </Button>
      <span className="text-sm text-slate-400">
        {state.message ?? 'Sites with an address or city but no coordinates.'}
      </span>
    </form>
  );
}

export function SitesPanel({
  sites,
  divisions,
  unmatched,
  writebackEnabled,
  addressLookup,
  unplaced,
}: {
  sites: SiteView[];
  divisions: DivisionView[];
  unmatched: Array<{ value: string; nodes: number }>;
  writebackEnabled: boolean;
  /** Whether the worker places sites from their address (MAP_ADDRESS_LOOKUP). */
  addressLookup: boolean;
  /** Sites with an address or city but no coordinates. */
  unplaced: number;
}) {
  const divName = new Map(divisions.map((d) => [d.code, d.name]));
  const onMap = (s: SiteView) =>
    (s.lat !== null && s.lon !== null) || (s.mapX !== null && s.mapY !== null);
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
                  <Button type="submit" variant="secondary">
                    Apply
                  </Button>
                  <div className="basis-full">
                    <Checks
                      name="divisionCodes"
                      label="Divisions (for a new site)"
                      values={divisions.map((d) => [d.code, d.name])}
                      selected={[]}
                    />
                  </div>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title={`Site profiles (${sites.length})`}
        description="Tier and harvest-critical drive incident priority. Placeholder sites came with the install — confirm or delete them."
        actions={addressLookup && unplaced > 0 ? <PlaceAll count={unplaced} /> : undefined}
      >
        <ul className="divide-y divide-white/5">
          {sites.map((s) => (
            <li key={s.id}>
              <details className="group py-3">
                <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-slate-100">{s.name}</span>
                  <span className="text-slate-400">
                    {s.divisionCodes.map((c) => divName.get(c) ?? c).join(', ') || 'no division'}
                  </span>
                  <Badge
                    tone={s.tier === 'critical' ? 'bad' : s.tier === 'high' ? 'warn' : 'neutral'}
                  >
                    {s.tier}
                  </Badge>
                  {s.harvestCritical && <Badge tone="warn">harvest-critical</Badge>}
                  {!onMap(s) && <Badge tone="neutral">not on map</Badge>}
                  <Badge tone={STATUS_TONE[s.profileStatus]}>{s.profileStatus}</Badge>
                  {s.group && (
                    <Badge tone="info">
                      {s.group.name ? 'SolarWinds group' : 'SolarWinds group missing'}
                    </Badge>
                  )}
                  <span className="text-xs text-slate-500">{s.nodeCount} nodes</span>
                </summary>
                <div className="mt-4 space-y-4 rounded-lg border border-white/10 p-4">
                  <SiteForm
                    site={s}
                    divisions={divisions}
                    onDoneLabel="Save site"
                    writebackEnabled={writebackEnabled}
                    addressLookup={addressLookup}
                  />
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
        <SiteForm
          divisions={divisions}
          onDoneLabel="Add site"
          writebackEnabled={writebackEnabled}
          addressLookup={addressLookup}
        />
      </Card>
    </div>
  );
}
