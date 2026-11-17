'use client';

import { aiTestAction, digestNowAction } from '@/app/actions/ai';
import { StatefulForm } from './stateful-form';
import { LevelIcon, type Level } from './status';
import { Button, FieldShell, Input } from './ui';

/** Today's spend against the budget: a bar plus icon and words (never colour alone). */
export function BudgetMeter({
  spentUsd,
  budgetUsd,
  level,
}: {
  spentUsd: number;
  budgetUsd: number;
  level: 'ok' | 'warn' | 'exhausted';
}) {
  const fraction = budgetUsd > 0 ? Math.min(1, spentUsd / budgetUsd) : 1;
  const status: Level = level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'bad';
  const label =
    level === 'ok'
      ? 'Within budget'
      : level === 'warn'
        ? 'Over 80 % of the daily budget'
        : 'Budget reached: templates until midnight';
  return (
    <div data-testid="ai-budget">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums text-slate-50">
          US${spentUsd.toFixed(2)}
        </span>
        <span className="text-sm text-slate-400">
          of US${budgetUsd.toFixed(2)} today ({Math.round(fraction * 100)} %)
        </span>
      </div>
      <div
        className="mt-3 h-3 w-full overflow-hidden rounded-full bg-white/10"
        role="meter"
        aria-label="AI spend today"
        aria-valuemin={0}
        aria-valuemax={budgetUsd}
        aria-valuenow={Math.min(spentUsd, budgetUsd)}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(fraction * 100, spentUsd > 0 ? 1 : 0)}%`,
            background: status === 'ok' ? '#3987e5' : status === 'warn' ? '#fab219' : '#d03b3b',
          }}
        />
      </div>
      <div className="mt-2 flex items-center gap-2 text-sm text-slate-300">
        <LevelIcon level={status} size={16} /> {label}
      </div>
    </div>
  );
}

export function AiTestForm({ defaultModel, hasKey }: { defaultModel: string; hasKey: boolean }) {
  return (
    <StatefulForm action={aiTestAction} label="Test the AI connection">
      {(_, pending) => (
        <div className="flex flex-wrap items-end gap-3">
          <FieldShell id="ai-test-model" label="Model (optional)">
            <Input
              id="ai-test-model"
              name="model"
              placeholder={defaultModel}
              spellCheck={false}
              className="w-64"
            />
          </FieldShell>
          <Button type="submit" variant="secondary" disabled={pending || !hasKey}>
            {pending ? 'Calling Claude…' : 'Test the connection'}
          </Button>
          {!hasKey && <span className="text-sm text-slate-400">Save an API key first.</span>}
        </div>
      )}
    </StatefulForm>
  );
}

export function DigestNowForm({ kind }: { kind: 'daily' | 'weekly' }) {
  return (
    <StatefulForm action={digestNowAction} label={`Send the ${kind} digest now`}>
      {(_, pending) => (
        <>
          <input type="hidden" name="kind" value={kind} />
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending
              ? 'Writing…'
              : kind === 'daily'
                ? 'Send the daily digest now'
                : 'Send the weekly trends now'}
          </Button>
        </>
      )}
    </StatefulForm>
  );
}
