import Link from 'next/link';
import { budgetState, SETTING_SECTIONS, shiftZonedDays, startOfZonedDay } from '@mercer/core';
import { aiSpendSince, aiUsageSince, recentAiCalls } from '@mercer/db';
import { AiTestForm, BudgetMeter } from '@/components/ai-panels';
import { SettingsForm } from '@/components/settings-form';
import { fmtTime } from '@/components/status';
import { Alert, Badge, Card } from '@/components/ui';
import { server } from '@/lib/server';
import { getSettingsState, sectionFields } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const PURPOSE: Record<string, string> = {
  severity: 'Priority check',
  summary: 'Incident summary',
  digest_daily: 'Daily digest',
  digest_weekly: 'Weekly trends',
  test: 'Connection test',
  chat: 'Chat',
};

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  ok: 'ok',
  retried: 'ok',
  fallback: 'warn',
  refused: 'warn',
  budget_blocked: 'warn',
  error: 'bad',
};

const usd = (n: number) => (n < 0.01 && n > 0 ? `US$${n.toFixed(4)}` : `US$${n.toFixed(2)}`);
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US'));

export default async function AiSettings() {
  const state = await getSettingsState();
  const cfg = state.cfg ?? server().bootstrap;
  const db = server().db.db;
  const now = new Date();
  const today = startOfZonedDay(now, cfg.timezone);
  const week = shiftZonedDays(today, -6, cfg.timezone);
  const [spent, todayUsage, weekUsage, calls] = await Promise.all([
    aiSpendSince(db, today),
    aiUsageSince(db, today),
    aiUsageSince(db, week),
    recentAiCalls(db, 40),
  ]);
  const budget = budgetState(spent, cfg.ai.dailyBudgetUsd);
  const weekCost = weekUsage.reduce((s, r) => s + r.costUsd, 0);
  const cached = weekUsage.reduce((s, r) => s + r.cacheReadTokens, 0);
  const prompt = weekUsage.reduce(
    (s, r) => s + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens,
    0,
  );
  return (
    <div className="space-y-6">
      {!cfg.ai.apiKey ? (
        <Alert tone="info" title="AI is off until an API key is saved">
          Incidents, notifications and digests work without it: titles and summaries come from MAS’s
          templates. Add an Anthropic API key below to have Claude write plain-English summaries,
          suggest priority within guardrails, and write the digests.
        </Alert>
      ) : !cfg.ai.enabled ? (
        <Alert tone="warning" title="AI is switched off">
          A key is saved, but “Use AI when a key is set” is off. MAS uses templates.
        </Alert>
      ) : (
        <Alert tone="success" title="AI is on">
          Summaries use {cfg.ai.models.summary}, priority checks {cfg.ai.models.severity}.
          {cfg.ai.redact
            ? ' IP addresses, MAC addresses and serial numbers are replaced before anything is sent.'
            : ' Redaction is OFF: addresses and serial numbers are sent as they are.'}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Spend today" description={`Resets at midnight (${cfg.timezone}).`}>
          <BudgetMeter
            spentUsd={budget.spentUsd}
            budgetUsd={budget.budgetUsd}
            level={budget.level}
          />
          <p className="mt-4 text-sm text-slate-400">
            Last 7 days: {usd(weekCost)}.{' '}
            {prompt > 0 &&
              `${Math.round((cached / prompt) * 100)} % of prompt tokens were served from the prompt cache.`}
          </p>
        </Card>
        <Card
          title="Test"
          description="One tiny call through the worker, with the saved key and settings."
        >
          <AiTestForm defaultModel={cfg.ai.models.summary} hasKey={!!cfg.ai.apiKey} />
        </Card>
      </div>

      <Card title="Usage" description="Estimated at list prices from the token counts.">
        <UsageTable title="Today" rows={todayUsage} />
        <div className="mt-6">
          <UsageTable title="Last 7 days" rows={weekUsage} />
        </div>
      </Card>

      <Card
        title="Recent calls"
        description="Every call is logged with its purpose, model, tokens, time and cost. Prompts and answers are not stored here."
      >
        {calls.length === 0 ? (
          <p className="text-sm text-slate-400">No AI calls yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="ai-calls">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Purpose</th>
                  <th className="py-2 pr-4 font-medium">Model</th>
                  <th className="py-2 pr-4 font-medium">Result</th>
                  <th className="py-2 pr-4 text-right font-medium">Tokens in / cached / out</th>
                  <th className="py-2 pr-4 text-right font-medium">Time</th>
                  <th className="py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {calls.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-300">
                      {fmtTime(c.at, cfg.timezone)}
                    </td>
                    <td className="py-2 pr-4 text-slate-200">
                      {PURPOSE[c.purpose] ?? c.purpose}
                      {c.incidentId && (
                        <>
                          {' '}
                          <Link
                            className="text-sky-300 hover:underline"
                            href={`/incidents/${c.incidentId}`}
                          >
                            INC-{c.incidentId}
                          </Link>
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-slate-400">
                      {c.model}
                      {c.servedBy && <div className="text-xs">answered by {c.servedBy}</div>}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>
                        {c.status.replace('_', ' ')}
                      </Badge>
                      {c.attempts > 1 && (
                        <span className="ml-2 text-xs text-slate-400">2 tries</span>
                      )}
                      {c.error && (
                        <div className="mt-1 max-w-md text-xs text-slate-400">{c.error}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-slate-300">
                      {k(c.inputTokens + c.cacheWriteTokens)} / {k(c.cacheReadTokens)} /{' '}
                      {k(c.outputTokens)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-slate-300">
                      {c.status === 'budget_blocked' ? '—' : `${(c.latencyMs / 1000).toFixed(1)} s`}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-300">
                      {usd(c.costUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <SettingsForm
        sections={(['ai', 'ai_models'] as const).map((section) => ({
          section,
          title: SETTING_SECTIONS[section].title,
          description: SETTING_SECTIONS[section].description,
          fields: sectionFields(section, state),
        }))}
        submitLabel="Save AI settings"
      />
    </div>
  );
}

function UsageTable({
  title,
  rows,
}: {
  title: string;
  rows: Awaited<ReturnType<typeof aiUsageSince>>;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">No calls.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-400">
              <tr>
                <th className="py-1.5 pr-4 font-medium">Purpose</th>
                <th className="py-1.5 pr-4 font-medium">Model</th>
                <th className="py-1.5 pr-4 text-right font-medium">Calls</th>
                <th className="py-1.5 pr-4 text-right font-medium">Used the template</th>
                <th className="py-1.5 pr-4 text-right font-medium">Avg time</th>
                <th className="py-1.5 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={`${r.purpose}-${r.model}`}>
                  <td className="py-1.5 pr-4 text-slate-200">{PURPOSE[r.purpose] ?? r.purpose}</td>
                  <td className="py-1.5 pr-4 text-slate-400">{r.model}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{r.calls}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{r.calls - r.ok}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">
                    {(r.avgLatencyMs / 1000).toFixed(1)} s
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{usd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
