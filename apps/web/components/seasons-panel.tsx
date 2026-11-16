'use client';

import { useActionState } from 'react';
import { deleteSeasonAction, saveSeasonAction } from '@/app/actions/calendar';
import type { FormState } from '@/app/actions/settings';
import { Alert, Badge, Button, Card, FieldShell, Input, Select } from './ui';

export interface SeasonView {
  id: number;
  name: string;
  kind: 'harvest' | 'high_risk';
  startMd: string;
  endMd: string;
  year: number | null;
  multiplier: number;
  divisions: string[] | null;
  harvestCriticalOnly: boolean;
  enabled: boolean;
}

function SeasonForm({
  season,
  divisions,
}: {
  season?: SeasonView;
  divisions: Array<{ code: string; name: string }>;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveSeasonAction, {});
  const e = state.errors ?? {};
  const v = state.values;
  const id = season ? `season${season.id}` : 'season-new';
  const dv = (k: string, f: string | number | null | undefined) => (v && k in v ? v[k] : (f ?? ''));
  return (
    <form action={action} className="space-y-4" noValidate>
      {season && <input type="hidden" name="id" value={season.id} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <FieldShell id={`${id}-name`} label="Name" error={e.name}>
          <Input id={`${id}-name`} name="name" defaultValue={dv('name', season?.name)} />
        </FieldShell>
        <FieldShell
          id={`${id}-kind`}
          label="Kind"
          help="Harvest boosts harvest-critical sites (and grain sites a little)."
        >
          <Select
            id={`${id}-kind`}
            name="kind"
            defaultValue={dv('kind', season?.kind ?? 'high_risk')}
          >
            <option value="harvest">Harvest</option>
            <option value="high_risk">Other high-risk period</option>
          </Select>
        </FieldShell>
        <FieldShell id={`${id}-mult`} label="Priority multiplier" error={e.multiplier}>
          <Input
            id={`${id}-mult`}
            name="multiplier"
            type="number"
            step={0.05}
            min={1}
            max={3}
            defaultValue={dv('multiplier', season?.multiplier ?? 1.2)}
          />
        </FieldShell>
        <FieldShell id={`${id}-start`} label="Starts (MM-DD)" error={e.startMd}>
          <Input
            id={`${id}-start`}
            name="startMd"
            placeholder="09-01"
            defaultValue={dv('startMd', season?.startMd)}
          />
        </FieldShell>
        <FieldShell id={`${id}-end`} label="Ends (MM-DD)" error={e.endMd}>
          <Input
            id={`${id}-end`}
            name="endMd"
            placeholder="12-15"
            defaultValue={dv('endMd', season?.endMd)}
          />
        </FieldShell>
        <FieldShell
          id={`${id}-year`}
          label="Only in year"
          error={e.year}
          help="Empty = every year."
        >
          <Input
            id={`${id}-year`}
            name="year"
            inputMode="numeric"
            defaultValue={dv('year', season?.year)}
          />
        </FieldShell>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-200">
          Applies to divisions (none checked = all)
        </legend>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">
          {divisions.map((d) => (
            <label key={d.code} className="flex items-center gap-2">
              <input
                type="checkbox"
                name="divisions"
                value={d.code}
                defaultChecked={season?.divisions?.includes(d.code)}
                className="accent-sky-500"
              />
              {d.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="harvestCriticalOnly"
            defaultChecked={season?.harvestCriticalOnly}
            className="accent-sky-500"
          />
          Only harvest-critical sites
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={season?.enabled ?? true}
            className="accent-sky-500"
          />
          Enabled
        </label>
      </div>
      {state.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : season ? 'Save season' : 'Add season'}
      </Button>
    </form>
  );
}

export function SeasonsPanel({
  seasons,
  divisions,
}: {
  seasons: SeasonView[];
  divisions: Array<{ code: string; name: string }>;
}) {
  const divName = new Map(divisions.map((d) => [d.code, d.name]));
  return (
    <div className="space-y-6">
      <Card
        title="Season calendar"
        description="During an active period, incidents at matching sites are scored higher. Harvest also shortens the recovery target for harvest-critical sites."
      >
        <ul className="divide-y divide-white/5">
          {seasons.map((s) => (
            <li key={s.id}>
              <details className="py-3">
                <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-slate-100">{s.name}</span>
                  <span className="text-slate-400">
                    {s.startMd} → {s.endMd}
                    {s.year ? ` (${s.year} only)` : ''}
                  </span>
                  <Badge tone={s.kind === 'harvest' ? 'warn' : 'info'}>
                    {s.kind === 'harvest' ? 'harvest' : 'high-risk'}
                  </Badge>
                  <span className="text-slate-400">×{s.multiplier}</span>
                  {s.divisions?.length ? (
                    <span className="text-xs text-slate-500">
                      {s.divisions.map((d) => divName.get(d) ?? d).join(', ')}
                    </span>
                  ) : null}
                  <Badge tone={s.enabled ? 'ok' : 'neutral'}>
                    {s.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </summary>
                <div className="mt-4 space-y-3 rounded-lg border border-white/10 p-4">
                  <SeasonForm season={s} divisions={divisions} />
                  <form
                    action={deleteSeasonAction}
                    onSubmit={(e) => {
                      if (!confirm(`Delete ${s.name}?`)) e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="id" value={s.id} />
                    <Button type="submit" variant="ghost" className="text-red-300">
                      Delete
                    </Button>
                  </form>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Add a period">
        <SeasonForm divisions={divisions} />
      </Card>
    </div>
  );
}
