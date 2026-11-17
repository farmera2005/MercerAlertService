'use client';

import {
  createOverrideAction,
  deleteOverrideAction,
  deletePersonAction,
  savePersonAction,
  setWeekAction,
  testSendAction,
} from '@/app/actions/notify';
import { StatefulForm } from '../stateful-form';
import { Badge, Button, FieldShell, Input, Select } from '../ui';

export interface PersonView {
  id: number;
  name: string;
  email: string | null;
  phoneE164: string | null;
  pushoverUserKey: string | null;
  pageVia: 'sms' | 'pushover' | 'both' | 'none';
  isItLead: boolean;
  active: boolean;
  rotationPosition: number | null;
}

export interface WeekView {
  weekStart: string;
  label: string;
  primaryId: number | null;
  secondaryId: number | null;
  primaryName: string;
  secondaryName: string;
  explicit: boolean;
}

export interface OverrideView {
  id: number;
  personName: string;
  label: string;
  reason: string | null;
}

const VIA: Record<PersonView['pageVia'], string> = {
  sms: 'SMS',
  pushover: 'Pushover',
  both: 'SMS and Pushover',
  none: 'Never page',
};

function PersonFields({ p, errors }: { p?: PersonView; errors: Record<string, string> }) {
  const id = p ? `p-${p.id}` : 'p-new';
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FieldShell id={`${id}-name`} label="Name" error={errors.name}>
        <Input id={`${id}-name`} name="name" defaultValue={p?.name ?? ''} />
      </FieldShell>
      <FieldShell id={`${id}-email`} label="E-mail (optional)" error={errors.email}>
        <Input id={`${id}-email`} name="email" type="email" defaultValue={p?.email ?? ''} />
      </FieldShell>
      <FieldShell
        id={`${id}-phone`}
        label="Mobile number"
        error={errors.phoneE164}
        help="International format, e.g. +14195550123"
      >
        <Input
          id={`${id}-phone`}
          name="phoneE164"
          inputMode="tel"
          defaultValue={p?.phoneE164 ?? ''}
        />
      </FieldShell>
      <FieldShell id={`${id}-po`} label="Pushover user key" error={errors.pushoverUserKey}>
        <Input
          id={`${id}-po`}
          name="pushoverUserKey"
          defaultValue={p?.pushoverUserKey ?? ''}
          spellCheck={false}
        />
      </FieldShell>
      <FieldShell id={`${id}-via`} label="Page by">
        <Select id={`${id}-via`} name="pageVia" defaultValue={p?.pageVia ?? 'sms'}>
          {Object.entries(VIA).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </FieldShell>
      <FieldShell
        id={`${id}-rot`}
        label="Rotation order"
        error={errors.rotationPosition}
        help="1, 2, 3… Empty: not in the weekly rotation"
      >
        <Input
          id={`${id}-rot`}
          name="rotationPosition"
          inputMode="numeric"
          defaultValue={p?.rotationPosition ?? ''}
        />
      </FieldShell>
      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          name="isItLead"
          defaultChecked={p?.isItLead ?? false}
          className="accent-sky-400"
        />
        IT lead (last escalation step)
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          name="active"
          defaultChecked={p?.active ?? true}
          className="accent-sky-400"
        />
        Active
      </label>
    </div>
  );
}

export function PeoplePanel({
  people,
  providers,
}: {
  people: PersonView[];
  providers: { sms: boolean; pushover: boolean };
}) {
  return (
    <div className="space-y-4">
      <ul
        className="divide-y divide-white/10 rounded-xl border border-white/10"
        data-testid="people"
      >
        {people.map((p) => (
          <li key={p.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-100">{p.name}</span>
              <span className="text-sm text-slate-400">{VIA[p.pageVia]}</span>
              {p.rotationPosition !== null && (
                <Badge tone="info">rotation #{p.rotationPosition}</Badge>
              )}
              {p.isItLead && <Badge tone="warn">IT lead</Badge>}
              {!p.active && <Badge>inactive</Badge>}
              {(p.pageVia === 'sms' || p.pageVia === 'both') && !p.phoneE164 && (
                <Badge tone="bad">no mobile number</Badge>
              )}
              {(p.pageVia === 'pushover' || p.pageVia === 'both') && !p.pushoverUserKey && (
                <Badge tone="bad">no Pushover key</Badge>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-start gap-3">
              {(['sms', 'pushover'] as const)
                .filter((k) => (k === 'sms' ? p.phoneE164 : p.pushoverUserKey))
                .map((k) => (
                  <StatefulForm key={k} action={testSendAction} label={`Test ${k} to ${p.name}`}>
                    {(_, pending) => (
                      <>
                        <input type="hidden" name="kind" value={k} />
                        <input type="hidden" name="personId" value={p.id} />
                        <Button
                          type="submit"
                          variant="secondary"
                          disabled={pending || !providers[k]}
                          title={
                            providers[k]
                              ? undefined
                              : `${k === 'sms' ? 'Twilio' : 'Pushover'} is not set up`
                          }
                        >
                          {pending ? 'Sending…' : `Test ${k === 'sms' ? 'SMS' : 'Pushover'}`}
                        </Button>
                      </>
                    )}
                  </StatefulForm>
                ))}
              <details className="min-w-[280px] flex-1 rounded-lg border border-white/10 p-3 open:bg-white/[0.02]">
                <summary className="cursor-pointer text-sm text-slate-300">Edit</summary>
                <div className="mt-3">
                  <StatefulForm action={savePersonAction.bind(null, p.id)} label={`Edit ${p.name}`}>
                    {(state, pending) => (
                      <div className="space-y-4">
                        <PersonFields p={p} errors={state.errors ?? {}} />
                        <Button type="submit" disabled={pending}>
                          Save
                        </Button>
                      </div>
                    )}
                  </StatefulForm>
                  <form action={deletePersonAction} className="mt-3">
                    <input type="hidden" name="id" value={p.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      onClick={(e) => {
                        if (!window.confirm(`Remove ${p.name}?`)) e.preventDefault();
                      }}
                    >
                      Remove person
                    </Button>
                  </form>
                </div>
              </details>
            </div>
          </li>
        ))}
      </ul>
      <details className="rounded-xl border border-white/10 p-4 open:bg-white/[0.02]">
        <summary className="cursor-pointer text-sm font-medium text-slate-200">
          Add a person
        </summary>
        <div className="mt-4">
          <StatefulForm
            action={savePersonAction.bind(null, null)}
            label="Add a person"
            resetOnSuccess
          >
            {(state, pending) => (
              <div className="space-y-4">
                <PersonFields errors={state.errors ?? {}} />
                <Button type="submit" disabled={pending}>
                  Add person
                </Button>
              </div>
            )}
          </StatefulForm>
        </div>
      </details>
    </div>
  );
}

export function WeeksTable({ weeks, people }: { weeks: WeekView[]; people: PersonView[] }) {
  const active = people.filter((p) => p.active);
  return (
    <div data-testid="weeks">
      <div className="hidden grid-cols-[11rem_1fr_1fr_auto] gap-3 pb-2 text-xs text-slate-400 sm:grid">
        <span>Week from</span>
        <span>Primary</span>
        <span>Secondary</span>
        <span />
      </div>
      <ul className="divide-y divide-white/5">
        {weeks.map((w) => (
          <li key={w.weekStart} className="py-2">
            <form
              action={setWeekAction}
              className="grid items-center gap-2 sm:grid-cols-[11rem_1fr_1fr_auto] sm:gap-3"
            >
              <input type="hidden" name="weekStart" value={w.weekStart} />
              <span className="text-sm text-slate-200">
                {w.label}
                {w.explicit && <span className="ml-2 text-xs text-sky-300">assigned</span>}
              </span>
              <Select
                name="primary"
                defaultValue={w.explicit ? String(w.primaryId ?? '') : ''}
                aria-label={`Primary for the week of ${w.label}`}
              >
                <option value="">Rotation: {w.primaryName}</option>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <Select
                name="secondary"
                defaultValue={w.explicit ? String(w.secondaryId ?? '') : ''}
                aria-label={`Secondary for the week of ${w.label}`}
              >
                <option value="">{w.explicit ? '(none)' : `Rotation: ${w.secondaryName}`}</option>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="ghost">
                Save
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OverridesPanel({
  overrides,
  people,
}: {
  overrides: OverrideView[];
  people: PersonView[];
}) {
  return (
    <div className="space-y-4">
      {overrides.length === 0 ? (
        <p className="text-sm text-slate-400">No cover planned.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {overrides.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3">
              <span className="font-medium text-slate-100">{o.personName}</span>
              <span className="text-slate-400">{o.label}</span>
              {o.reason && <span className="text-slate-500">{o.reason}</span>}
              <form action={deleteOverrideAction}>
                <input type="hidden" name="id" value={o.id} />
                <Button type="submit" variant="ghost">
                  Remove
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <StatefulForm action={createOverrideAction} label="Add cover" resetOnSuccess>
        {(state, pending) => {
          const e = state.errors ?? {};
          return (
            <div className="grid gap-3 sm:grid-cols-5 sm:items-end">
              <FieldShell id="ov-person" label="Who covers" error={e.personId}>
                <Select id="ov-person" name="personId" defaultValue="">
                  <option value="">Choose…</option>
                  {people
                    .filter((p) => p.active)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
              </FieldShell>
              <FieldShell id="ov-start" label="From" error={e.startsAt}>
                <Input id="ov-start" name="startsAt" type="datetime-local" />
              </FieldShell>
              <FieldShell id="ov-end" label="Until" error={e.endsAt}>
                <Input id="ov-end" name="endsAt" type="datetime-local" />
              </FieldShell>
              <FieldShell id="ov-reason" label="Reason">
                <Input id="ov-reason" name="reason" placeholder="Vacation swap" />
              </FieldShell>
              <Button type="submit" disabled={pending}>
                Add cover
              </Button>
            </div>
          );
        }}
      </StatefulForm>
    </div>
  );
}
