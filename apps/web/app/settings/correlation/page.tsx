import { SETTING_SECTIONS, scoreIncident, type ScoreInput, type SiteInfo } from '@mercer/core';
import { listSeasons } from '@mercer/db';
import { SettingsForm } from '@/components/settings-form';
import { Card } from '@/components/ui';
import { server } from '@/lib/server';
import { getSettingsState, sectionFields } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const OFFICE = { days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' };

/** Live examples so admins can see what their thresholds and multipliers do. */
async function examples() {
  const state = await getSettingsState();
  const cfg = state.cfg;
  if (!cfg) return [];
  const seasons = (await listSeasons(server().db.db)).filter((s) => s.enabled);
  const harvestSeason = seasons.find((s) => s.kind === 'harvest');
  const grain: SiteInfo = {
    id: 0,
    name: 'a harvest-critical elevator',
    divisionCodes: ['grain'],
    divisionNames: ['Grain'],
    tier: 'high',
    harvestCritical: true,
    businessHours: OFFICE,
    harvestHours: null,
  };
  const agro: SiteInfo = {
    ...grain,
    name: 'a standard agronomy site',
    divisionCodes: ['agronomy'],
    divisionNames: ['Agronomy'],
    tier: 'standard',
    harvestCritical: false,
  };
  const hq: SiteInfo = {
    ...grain,
    name: 'HQ',
    divisionCodes: ['corporate'],
    divisionNames: ['Corporate'],
    tier: 'critical',
    harvestCritical: false,
  };
  const year = new Date().getUTCFullYear();
  const inHarvest = harvestSeason
    ? new Date(`${year}-${harvestSeason.startMd}T15:00:00Z`)
    : new Date(`${year}-10-14T15:00:00Z`);
  const offSeason = new Date(`${year}-03-11T02:00:00Z`);
  const base = {
    downRoles: [],
    affectedNodes: 0,
    interfaceOnCoreRole: false,
    firewallDown: false,
    severity: 'critical' as const,
    seasons: seasons.map((s) => ({ ...s })),
    timeZone: cfg.timezone,
    cfg: cfg.scoring,
  };
  const cases: Array<
    [string, Omit<ScoreInput, 'seasons' | 'timeZone' | 'cfg'> & Partial<ScoreInput>]
  > = [
    [
      'Whole site down at a harvest-critical elevator, harvest, business hours',
      {
        ...base,
        kind: 'site_outage',
        downRoles: ['firewall'],
        firewallDown: true,
        site: grain,
        now: inHarvest,
      },
    ],
    [
      'The same outage in March at night',
      {
        ...base,
        kind: 'site_outage',
        downRoles: ['firewall'],
        firewallDown: true,
        site: grain,
        now: offSeason,
      },
    ],
    [
      'Scale PC down at that elevator during harvest',
      {
        ...base,
        kind: 'device_down',
        downRoles: ['scale_system'],
        affectedNodes: 1,
        site: grain,
        now: inHarvest,
      },
    ],
    [
      'One access point down at a standard agronomy site',
      {
        ...base,
        kind: 'device_down',
        downRoles: ['access_point'],
        affectedNodes: 1,
        site: agro,
        now: offSeason,
      },
    ],
    [
      'HQ WAN link saturated (warning on the firewall interface)',
      {
        ...base,
        kind: 'interface',
        interfaceOnCoreRole: true,
        severity: 'warning',
        site: hq,
        now: inHarvest,
      },
    ],
  ];
  return cases.map(([label, input]) => ({
    label,
    result: scoreIncident({ ...base, ...input } as ScoreInput),
  }));
}

export default async function CorrelationSettings() {
  const state = await getSettingsState();
  const sections = (['correlation', 'scoring'] as const).map((section) => ({
    section,
    title: SETTING_SECTIONS[section].title,
    description: SETTING_SECTIONS[section].description,
    fields: sectionFields(section, state),
  }));
  const ex = await examples();
  return (
    <div className="space-y-6">
      <SettingsForm sections={sections} submitLabel="Save" />
      <Card
        title="What these settings produce"
        description="Recomputed from the saved settings and season calendar."
      >
        <ul className="divide-y divide-white/5 text-sm">
          {ex.map((e) => (
            <li key={e.label} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span>{e.label}</span>
              <span className="text-slate-400" title={e.result.factors.explanation.join(' · ')}>
                score {e.result.score} →{' '}
                <strong className="text-slate-100">{e.result.priority}</strong>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-400">
          Points by what is affected: whole site 70 · firewall / core switch / scale system 50 ·
          router 45 · server 40 · power/UPS 40 · switch 35 · access point 25 · interface on a core
          device 40, otherwise 20. Orion severity: critical ×1 · serious ×0.85 · warning ×0.6 ·
          notice ×0.4. “Monitoring source down” is always P1.
        </p>
      </Card>
    </div>
  );
}
