import 'server-only';
import {
  chooseSiteGroups,
  geocodeQuery,
  INTERNAL_SETTING_KEYS,
  nodeSiteGroups,
  normalizeKey,
  siteGroupMode,
  type MappingConfig,
} from '@mercer/core';
import {
  getInternalSetting,
  latestSiteNotesWrites,
  listDivisions,
  listSites,
  loadGroupMirror,
  loadNodeFacts,
  loadSiteGroupDecisions,
  siteGroupInfo,
  siteKeysAndLinks,
} from '@mercer/db';
import type { DiscoveryReport } from '@mercer/swis/setup-contract';
import { MappingPanel, type SiteGroupPreview } from '@/components/mapping-panel';
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

/** Which SolarWinds groups the saved settings treat as sites (and why), with their MAS site. */
async function siteGroupPreview(
  mapping: MappingConfig | undefined,
  sites: Array<{
    id: number;
    code: string;
    name: string;
    aliases: string[];
    orionContainerId: number | null;
  }>,
): Promise<SiteGroupPreview> {
  const db = server().db.db;
  const { groups, members } = await loadGroupMirror(db);
  const cfg = {
    parent: mapping?.siteGroupParent ?? null,
    pattern: mapping?.siteGroupPattern ?? null,
    auto: mapping?.siteGroupAuto ?? true,
  };
  const mode = siteGroupMode(cfg);
  const { keys, linked } = siteKeysAndLinks(sites);
  const decisions = await loadSiteGroupDecisions(db);
  const detect = {
    nodes: mode === 'auto' ? await loadNodeFacts(db, mapping?.siteField ?? 'Site') : [],
    captionRegex: mapping?.siteFromCaptionRegex ?? null,
    knownSiteKeys: keys,
    linked,
    decisions,
  };
  const choice = chooseSiteGroups(groups, members, cfg, detect);
  const { byNode } = nodeSiteGroups(choice.siteGroups, members);
  const devices = new Map<number, number>();
  for (const cid of byNode.values()) devices.set(cid, (devices.get(cid) ?? 0) + 1);
  const linkedName = new Map(
    sites.filter((s) => s.orionContainerId !== null).map((s) => [s.orionContainerId!, s.name]),
  );
  return {
    mode,
    groupsPolled: groups.length,
    rows: choice.siteGroups.map((g) => ({
      containerId: g.containerId,
      decided: decisions.get(g.containerId) ?? null,
      groupName: g.groupName,
      siteName: g.siteName,
      devices: devices.get(g.containerId) ?? 0,
      linkedSite: linkedName.get(g.containerId) ?? null,
      reason: g.reason ?? null,
    })),
    rejected: choice.rejected.map((r) => ({
      containerId: r.containerId,
      decided: decisions.get(r.containerId) ?? null,
      groupName: r.groupName,
      reason: r.reason,
    })),
  };
}

export async function MappingContent() {
  const [state, discovery, sites] = await Promise.all([
    getSettingsState(),
    lastDiscovery(),
    listSites(server().db.db),
  ]);
  const siteGroups = await siteGroupPreview(state.cfg?.mapping, sites);
  return (
    <div className="space-y-6">
      <ConfigProblem error={state.configError} />
      <MappingPanel
        fields={sectionFields('mapping', state)}
        discovery={discovery}
        sites={siteKeys(sites)}
        siteGroups={siteGroups}
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
  const ids = sites.map((s) => s.id);
  const [groups, writes] = await Promise.all([
    siteGroupInfo(db.db, ids),
    latestSiteNotesWrites(db.db, ids),
  ]);
  return (
    <SitesPanel
      sites={sites.map((s): SiteView => {
        const g = groups.get(s.id);
        const w = writes.get(s.id);
        return {
          ...s,
          nodeCount: s.nodeCount,
          group: g ? { name: g.groupName, notes: g.description } : null,
          notesWrite: w
            ? {
                status: w.status,
                error: w.error,
                at: (w.completedAt ?? w.createdAt).toISOString(),
                by: w.requestedBy,
              }
            : null,
        };
      })}
      divisions={divisions.map((d) => ({ code: d.code, name: d.name }))}
      unmatched={unmatched}
      writebackEnabled={!!state.cfg?.swis.writeback.enabled}
      addressLookup={!!state.cfg?.map.geocoder}
      unplaced={
        sites.filter((s) => (s.lat === null || s.lon === null) && geocodeQuery(s) !== null).length
      }
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
