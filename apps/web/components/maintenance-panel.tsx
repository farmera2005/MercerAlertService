'use client';

import { useActionState, useState } from 'react';
import { createMaintenanceAction, endMaintenanceAction } from '@/app/actions/calendar';
import type { FormState } from '@/app/actions/settings';
import { Alert, Badge, Button, Card, FieldShell, Input, Select } from './ui';

export interface MaintenanceView {
  id: number;
  scope: 'global' | 'site' | 'node';
  target: string;
  startsAt: string;
  endsAt: string | null;
  recurrence: string | null;
  suppress: 'notifications' | 'incidents';
  reason: string | null;
  state: 'active' | 'upcoming' | 'ended' | 'recurring';
  createdBy: string | null;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATE_TONE = {
  active: 'warn',
  upcoming: 'info',
  ended: 'neutral',
  recurring: 'info',
} as const;

export function MaintenancePanel({
  windows,
  sites,
  nodes,
  timezone,
}: {
  windows: MaintenanceView[];
  sites: Array<{ id: number; name: string }>;
  nodes: Array<{ id: number; caption: string }>;
  timezone: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createMaintenanceAction, {});
  const [scope, setScope] = useState('site');
  const [recurring, setRecurring] = useState(false);
  const e = state.errors ?? {};
  return (
    <div className="space-y-6">
      <Card
        title="Maintenance windows"
        description={`Times are ${timezone}. “Notifications” keeps incidents but marks them in-maintenance (no paging, from Milestone 4); “Incidents” holds problems back until the window ends.`}
      >
        {windows.length === 0 && (
          <p className="text-sm text-slate-400">No current or upcoming windows.</p>
        )}
        <ul className="divide-y divide-white/5">
          {windows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <Badge tone={STATE_TONE[w.state]}>{w.state}</Badge>
              <span className="font-medium">{w.target}</span>
              <span className="text-slate-400">
                {w.recurrence ?? `${w.startsAt} → ${w.endsAt ?? 'open-ended'}`}
              </span>
              <Badge tone={w.suppress === 'incidents' ? 'warn' : 'neutral'}>
                suppresses {w.suppress}
              </Badge>
              {w.reason && <span className="text-slate-400">“{w.reason}”</span>}
              {w.state !== 'ended' && (
                <form action={endMaintenanceAction} className="ml-auto">
                  <input type="hidden" name="id" value={w.id} />
                  <Button type="submit" variant="ghost">
                    {w.state === 'upcoming' ? 'Cancel' : 'End now'}
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Add a window">
        <form action={action} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-3">
            <FieldShell id="mw-scope" label="Applies to">
              <Select
                id="mw-scope"
                name="scope"
                value={scope}
                onChange={(ev) => setScope(ev.target.value)}
              >
                <option value="site">One site</option>
                <option value="node">One device</option>
                <option value="global">Everything</option>
              </Select>
            </FieldShell>
            {scope === 'site' && (
              <FieldShell id="mw-site" label="Site" error={e.siteId}>
                <Select id="mw-site" name="siteId" defaultValue="">
                  <option value="">Choose…</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </FieldShell>
            )}
            {scope === 'node' && (
              <FieldShell id="mw-node" label="Device" error={e.nodeId}>
                <Select id="mw-node" name="nodeId" defaultValue="">
                  <option value="">Choose…</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.caption}
                    </option>
                  ))}
                </Select>
              </FieldShell>
            )}
            <FieldShell id="mw-suppress" label="Suppress">
              <Select id="mw-suppress" name="suppress" defaultValue="notifications">
                <option value="notifications">Notifications only</option>
                <option value="incidents">Incidents too</option>
              </Select>
            </FieldShell>
            <FieldShell id="mw-start" label="Starts" error={e.startsAt}>
              <Input id="mw-start" name="startsAt" type="datetime-local" />
            </FieldShell>
            <FieldShell
              id="mw-end"
              label="Ends"
              error={e.endsAt}
              help={recurring ? 'Optional: last day the schedule applies.' : undefined}
            >
              <Input id="mw-end" name="endsAt" type="datetime-local" />
            </FieldShell>
            <FieldShell id="mw-reason" label="Reason">
              <Input id="mw-reason" name="reason" placeholder="FortiGate firmware upgrade" />
            </FieldShell>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="recurring"
              checked={recurring}
              onChange={(ev) => setRecurring(ev.target.checked)}
              className="accent-sky-500"
            />
            Repeats weekly
          </label>
          {recurring && (
            <div className="grid gap-4 rounded-lg border border-white/10 p-4 sm:grid-cols-3">
              <fieldset className="sm:col-span-3">
                <legend className="text-sm font-medium text-slate-200">Days</legend>
                <div className="mt-2 flex flex-wrap gap-4 text-sm">
                  {DAYS.map((d, i) => (
                    <label key={d} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="weekdays"
                        value={i + 1}
                        className="accent-sky-500"
                      />
                      {d}
                    </label>
                  ))}
                </div>
                {e.weekdays && <p className="mt-1 text-xs text-red-300">{e.weekdays}</p>}
              </fieldset>
              <FieldShell id="mw-rstart" label="Start time" error={e.recStart}>
                <Input id="mw-rstart" name="recStart" type="time" />
              </FieldShell>
              <FieldShell id="mw-dur" label="Duration (minutes)" error={e.durationMin}>
                <Input
                  id="mw-dur"
                  name="durationMin"
                  type="number"
                  min={5}
                  max={1440}
                  defaultValue={120}
                />
              </FieldShell>
            </div>
          )}
          {state.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Add window'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
