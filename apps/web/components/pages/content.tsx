import 'server-only';
import { INTERNAL_SETTING_KEYS, normalizeKey } from '@mercer/core';
import { getInternalSetting, listDivisions, listSites } from '@mercer/db';
import type { DiscoveryReport } from '@mercer/swis/setup-contract';
import { MappingPanel } from '@/components/mapping-panel';
import { OrionPanel } from '@/components/orion-panel';
import { SettingsForm } from '@/components/settings-form';
import { SitesPanel, type SiteView } from '@/components/sites-panel';
import { Alert } from '@/components/ui';
import { server } from '@/lib/server';
import { getSettingsState, sectionFields } from '@/lib/settings';
import { SETTING_SECTIONS } from '@mercer/core';

type Discovery = { at: string; report: DiscoveryReport } | null;

async function lastDiscovery(): Promise<Discovery> {
  return getInternalSetting<{ at: string; report: DiscoveryReport }>(
    server().db.db,
    INTERNAL_SETTING_KEYS.lastDiscovery,
  );
}

function ConfigProblem({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Alert
      tone="error"
      title="Saved settings are invalid — the worker keeps using the last good configuration"
    >
      <pre className="mt-2 whitespace-pre-wrap text-xs">{error}</pre>
    </Alert>
  );
}

export async function OrionContent() {
  const state = await getSettingsState();
  const fields = [
    ...sectionFields('orion', state),
    ...sectionFields('orion_tls', state),
    ...sectionFields('orion_writeback', state),
  ];
  return (
    <div className="space-y-6">
      <ConfigProblem error={state.configError} />
      <OrionPanel fields={fields} />
    </div>
  );
}

function siteKeys(sites: Awaited<ReturnType<typeof listSites>>) {
  const out: Array<{ key: string; name: string }> = [];
  for (const s of sites)
    for (const k of [s.code, s.name, ...s.aliases])
      out.push({ key: normalizeKey(k), name: s.name });
  return out;
}

export async function MappingContent() {
  const [state, discovery, sites] = await Promise.all([
    getSettingsState(),
    lastDiscovery(),
    listSites(server().db.db),
  ]);
  return (
    <div className="space-y-6">
      <ConfigProblem error={state.configError} />
      <MappingPanel
        fields={sectionFields('mapping', state)}
        discovery={discovery}
        sites={siteKeys(sites)}
      />
    </div>
  );
}

export async function SitesContent() {
  const { db } = server();
  const [state, discovery, sites, divisions] = await Promise.all([
    getSettingsState(),
    lastDiscovery(),
    listSites(db.db),
    listDivisions(db.db),
  ]);
  const field = state.cfg?.mapping.siteField ?? 'Site';
  const known = new Set(siteKeys(sites).map((k) => k.key));
  const values = discovery?.report.customProperties.find((c) => c.field === field)?.topValues ?? [];
  const unmatched = values
    .filter(
      (v) =>
        v.value !== null &&
        String(v.value).trim() !== '' &&
        !known.has(normalizeKey(String(v.value))),
    )
    .map((v) => ({ value: String(v.value), nodes: v.nodes }));
  return (
    <SitesPanel
      sites={sites.map((s): SiteView => ({ ...s, nodeCount: s.nodeCount }))}
      divisions={divisions.map((d) => ({ code: d.code, name: d.name }))}
      unmatched={unmatched}
    />
  );
}

export async function GeneralContent() {
  const state = await getSettingsState();
  const sections = (['general', 'network', 'polling', 'retention', 'health'] as const).map(
    (section) => ({
      section,
      title: SETTING_SECTIONS[section].title,
      description: SETTING_SECTIONS[section].description,
      fields: sectionFields(section, state),
    }),
  );
  return (
    <div className="space-y-6">
      <ConfigProblem error={state.configError} />
      <SettingsForm sections={sections} submitLabel="Save settings" />
    </div>
  );
}
