import { INTERNAL_SETTING_KEYS, isSwisConfigured } from '@mercer/core';
import { getHeartbeat, getInternalSetting, listSites } from '@mercer/db';
import type { DiscoveryReport, TestJobOutput } from '@mercer/swis/setup-contract';
import { FinishForm } from '@/components/finish-form';
import { Badge, Card } from '@/components/ui';
import { server } from '@/lib/server';
import { getSettingsState } from '@/lib/settings';

export const dynamic = 'force-dynamic';

type Check = { label: string; state: 'ok' | 'warn' | 'bad'; detail: string };

export default async function FinishPage() {
  const { db } = server();
  const [state, test, discovery, sites, worker] = await Promise.all([
    getSettingsState(),
    getInternalSetting<TestJobOutput & { at: string; baseUrl: string }>(
      db.db,
      INTERNAL_SETTING_KEYS.lastConnectionTest,
    ),
    getInternalSetting<{ at: string; report: DiscoveryReport }>(
      db.db,
      INTERNAL_SETTING_KEYS.lastDiscovery,
    ),
    listSites(db.db),
    getHeartbeat(db.db, 'worker'),
  ]);
  const cfg = state.cfg;
  const configured = !!cfg && isSwisConfigured(cfg.swis);
  const cpFields = discovery?.report.customProperties.map((c) => c.field) ?? [];
  const placeholders = sites.filter((s) => s.profileStatus === 'placeholder').length;
  const checks: Check[] = [
    {
      label: 'Worker running',
      state: worker && Date.now() - worker.lastBeatAt.getTime() < 90_000 ? 'ok' : 'bad',
      detail: worker
        ? `last heartbeat ${new Date(worker.lastBeatAt).toLocaleTimeString('en-US')}`
        : 'no heartbeat yet',
    },
    {
      label: 'SolarWinds connection saved',
      state: configured ? 'ok' : 'bad',
      detail: configured ? cfg!.swis.baseUrl : 'not configured',
    },
    {
      label: 'Connection test',
      state: test?.ok && test.baseUrl === cfg?.swis.baseUrl ? 'ok' : 'warn',
      detail: test
        ? test.ok
          ? `${test.nodes} nodes reachable (${new Date(test.at).toLocaleString('en-US')})`
          : (test.hint ?? test.error ?? 'failed')
        : 'not run',
    },
    {
      label: 'Discovery',
      state: discovery
        ? discovery.report.fields.some((f) => f.required && !f.present)
          ? 'bad'
          : 'ok'
        : 'warn',
      detail: discovery
        ? `run ${new Date(discovery.at).toLocaleString('en-US')}`
        : 'not run — mapping uses defaults',
    },
    {
      label: 'Site custom property',
      state: cfg && cpFields.includes(cfg.mapping.siteField) ? 'ok' : 'warn',
      detail: cfg
        ? `“${cfg.mapping.siteField}”${cpFields.length && !cpFields.includes(cfg.mapping.siteField) ? ' not found in Orion' : ''}`
        : '—',
    },
    {
      label: 'Site profiles',
      state: placeholders ? 'warn' : 'ok',
      detail: `${sites.length} sites${placeholders ? `, ${placeholders} still placeholders` : ''}`,
    },
    {
      label: 'TLS verification',
      state: cfg?.swis.insecureSkipVerify ? 'bad' : 'ok',
      detail: cfg?.swis.baseUrl.startsWith('http:')
        ? 'plain HTTP (test mock)'
        : cfg?.swis.insecureSkipVerify
          ? 'DISABLED'
          : 'on',
    },
  ];
  const warnings = checks.filter((c) => c.state !== 'ok').length;
  const tone = { ok: 'ok', warn: 'warn', bad: 'bad' } as const;
  return (
    <Card
      title="Ready to start monitoring?"
      description="Polling starts as soon as you confirm. Incidents and notifications arrive in later milestones."
    >
      <ul className="mb-6 divide-y divide-white/5">
        {checks.map((c) => (
          <li key={c.label} className="flex items-center justify-between gap-4 py-2.5 text-sm">
            <span>{c.label}</span>
            <span className="flex items-center gap-2 text-right text-slate-400">
              {c.detail}
              <Badge tone={tone[c.state]}>
                {c.state === 'ok' ? 'OK' : c.state === 'warn' ? 'check' : 'problem'}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
      <FinishForm ready={configured} warnings={warnings} />
    </Card>
  );
}
