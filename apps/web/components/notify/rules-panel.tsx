'use client';

import { deleteRuleAction, moveRuleAction, saveRuleAction } from '@/app/actions/notify';
import { StatefulForm } from '../stateful-form';
import { KIND_LABEL } from '../status';
import { Badge, Button, FieldShell, Input, Select } from '../ui';

export interface RuleView {
  id: number;
  name: string;
  enabled: boolean;
  priorities: string[];
  kinds: string[];
  divisions: string[];
  siteIds: number[];
  hours: 'any' | 'business' | 'after';
  channelKey: string | null;
  pageOncall: boolean;
  escalateAfterMin: number | null;
  stop: boolean;
}

interface Options {
  channels: string[];
  divisions: Array<{ code: string; name: string }>;
  sites: Array<{ id: number; name: string }>;
  kinds: string[];
  defaultEscalate: number;
}

const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const HOURS = { any: 'Any time', business: 'In business hours', after: 'After business hours' };

function Checks({
  name,
  values,
  selected,
  label,
}: {
  name: string;
  values: Array<[string, string]>;
  selected: Array<string | number>;
  label: string;
}) {
  return (
    <fieldset className="text-sm">
      <legend className="mb-1.5 text-sm font-medium text-slate-200">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {values.map(([v, l]) => (
          <label
            key={v}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/15 px-2 py-1 text-slate-200 has-[:checked]:border-sky-400 has-[:checked]:bg-sky-500/10"
          >
            <input
              type="checkbox"
              name={name}
              value={v}
              defaultChecked={selected.map(String).includes(v)}
              className="accent-sky-400"
            />
            {l}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RuleForm({ rule, opts }: { rule: RuleView | null; opts: Options }) {
  const id = rule ? `rule-${rule.id}` : 'rule-new';
  return (
    <StatefulForm
      action={saveRuleAction.bind(null, rule?.id ?? null)}
      label={rule ? `Edit ${rule.name}` : 'New rule'}
      resetOnSuccess={!rule}
    >
      {(state, pending) => {
        const e = state.errors ?? {};
        return (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldShell id={`${id}-name`} label="Name" error={e.name}>
                <Input id={`${id}-name`} name="name" defaultValue={rule?.name ?? ''} />
              </FieldShell>
              <FieldShell id={`${id}-hours`} label="When">
                <Select id={`${id}-hours`} name="hours" defaultValue={rule?.hours ?? 'any'}>
                  {Object.entries(HOURS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </FieldShell>
            </div>
            <p className="text-xs text-slate-400">
              Leave a group empty to match everything. Business hours are the site’s (harvest hours
              at harvest-critical sites in harvest).
            </p>
            <Checks
              name="priorities"
              label="Priorities"
              values={PRIORITIES.map((p) => [p, p])}
              selected={rule?.priorities ?? []}
            />
            <Checks
              name="kinds"
              label="Kinds"
              values={opts.kinds.map((k) => [k, KIND_LABEL[k] ?? k])}
              selected={rule?.kinds ?? []}
            />
            <Checks
              name="divisions"
              label="Divisions"
              values={opts.divisions.map((d) => [d.code, d.name])}
              selected={rule?.divisions ?? []}
            />
            <details className="rounded-lg border border-white/10 p-3">
              <summary className="cursor-pointer text-sm text-slate-300">
                Sites ({rule?.siteIds.length ? `${rule.siteIds.length} selected` : 'any'})
              </summary>
              <div className="mt-3">
                <Checks
                  name="siteIds"
                  label="Only these sites"
                  values={opts.sites.map((s) => [String(s.id), s.name])}
                  selected={rule?.siteIds ?? []}
                />
              </div>
            </details>
            <div className="grid gap-4 sm:grid-cols-3">
              <FieldShell id={`${id}-ch`} label="Post to Teams channel" error={e.channelKey}>
                <Select id={`${id}-ch`} name="channelKey" defaultValue={rule?.channelKey ?? ''}>
                  <option value="">(none)</option>
                  {opts.channels.map((c) => (
                    <option key={c} value={c}>
                      #{c}
                    </option>
                  ))}
                </Select>
              </FieldShell>
              <FieldShell
                id={`${id}-esc`}
                label="Escalate after (minutes)"
                error={e.escalateAfterMin}
                help={`Empty: ${opts.defaultEscalate} min`}
              >
                <Input
                  id={`${id}-esc`}
                  name="escalateAfterMin"
                  inputMode="numeric"
                  defaultValue={rule?.escalateAfterMin ?? ''}
                />
              </FieldShell>
              <div className="space-y-2 pt-6 text-sm text-slate-200">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="pageOncall"
                    defaultChecked={rule?.pageOncall ?? false}
                    className="accent-sky-400"
                  />
                  Page the on-call person
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="stop"
                    defaultChecked={rule?.stop ?? false}
                    className="accent-sky-400"
                  />
                  Stop here (skip later rules)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={rule?.enabled ?? true}
                    className="accent-sky-400"
                  />
                  Enabled
                </label>
              </div>
            </div>
            <Button type="submit" disabled={pending}>
              {rule ? 'Save rule' : 'Add rule'}
            </Button>
          </div>
        );
      }}
    </StatefulForm>
  );
}

function describe(r: RuleView, opts: Options): string {
  const parts: string[] = [];
  parts.push(r.priorities.length ? r.priorities.join(', ') : 'Any priority');
  if (r.kinds.length) parts.push(r.kinds.map((k) => KIND_LABEL[k] ?? k).join(', '));
  if (r.divisions.length)
    parts.push(
      r.divisions.map((d) => opts.divisions.find((x) => x.code === d)?.name ?? d).join(', '),
    );
  if (r.siteIds.length) parts.push(`${r.siteIds.length} site${r.siteIds.length === 1 ? '' : 's'}`);
  if (r.hours !== 'any') parts.push(HOURS[r.hours].toLowerCase());
  const then: string[] = [];
  if (r.channelKey) then.push(`#${r.channelKey}`);
  if (r.pageOncall)
    then.push(`page on-call (escalate after ${r.escalateAfterMin ?? opts.defaultEscalate} min)`);
  return `${parts.join(' · ')} → ${then.join(' + ')}${r.stop ? ' · stop' : ''}`;
}

export function RulesPanel({ rules, opts }: { rules: RuleView[]; opts: Options }) {
  return (
    <div className="space-y-4">
      <ol
        className="divide-y divide-white/10 rounded-xl border border-white/10"
        data-testid="rules"
      >
        {rules.map((r, i) => (
          <li key={r.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-sm tabular-nums text-slate-500">{i + 1}.</span>
              <span
                className={r.enabled ? 'font-medium text-slate-100' : 'text-slate-500 line-through'}
              >
                {r.name}
              </span>
              {!r.enabled && <Badge>disabled</Badge>}
              <span className="ml-auto flex gap-1">
                {(['up', 'down'] as const).map((dir) => (
                  <form key={dir} action={moveRuleAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="direction" value={dir} />
                    <button
                      type="submit"
                      className="rounded px-2 py-1 text-sm text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-30"
                      disabled={dir === 'up' ? i === 0 : i === rules.length - 1}
                      aria-label={`Move ${r.name} ${dir}`}
                    >
                      {dir === 'up' ? '↑' : '↓'}
                    </button>
                  </form>
                ))}
              </span>
            </div>
            <p className="mt-1 pl-8 text-sm text-slate-400">{describe(r, opts)}</p>
            <details className="mt-2 ml-8 rounded-lg border border-white/10 p-3 open:bg-white/[0.02]">
              <summary className="cursor-pointer text-sm text-slate-300">Edit</summary>
              <div className="mt-3">
                <RuleForm rule={r} opts={opts} />
                <form action={deleteRuleAction} className="mt-3">
                  <input type="hidden" name="id" value={r.id} />
                  <Button
                    type="submit"
                    variant="ghost"
                    onClick={(e) => {
                      if (!window.confirm(`Delete the rule “${r.name}”?`)) e.preventDefault();
                    }}
                  >
                    Delete rule
                  </Button>
                </form>
              </div>
            </details>
          </li>
        ))}
      </ol>
      <details className="rounded-xl border border-white/10 p-4 open:bg-white/[0.02]">
        <summary className="cursor-pointer text-sm font-medium text-slate-200">Add a rule</summary>
        <div className="mt-4">
          <RuleForm rule={null} opts={opts} />
        </div>
      </details>
    </div>
  );
}
