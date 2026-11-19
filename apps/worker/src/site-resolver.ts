import {
  buildSiteResolutionContext,
  chooseSiteGroups,
  classifyDeviceRole,
  isDeviceRole,
  planSiteGroupLinks,
  resolveNodeSite,
  siteGroupMode,
  type Logger,
  type MappingConfig,
  type NodeFacts,
  type SiteGroupConfig,
  type SiteResolutionContext,
} from '@mercer/core';
import {
  applySiteGroupPlan,
  createAutoSites,
  loadGroupMirror,
  loadGroupSiteMap,
  loadNodeFacts,
  loadSiteGroupDecisions,
  loadSiteContextData,
  loadSiteLinkRefs,
  siteKeysAndLinks,
  type Db,
  type NodeSnapshotRow,
} from '@mercer/db';
import type { SwisNode } from '@mercer/swis';

/** Resolves SWIS nodes to sites/divisions/roles; caches Site Profiles briefly. */
export class SiteResolver {
  private ctx: SiteResolutionContext | null = null;
  private loadedAt = 0;
  /** Site groups not yet chosen with device data (fresh start, or new mapping settings). */
  private groupSyncPending = true;

  constructor(
    private readonly db: Db,
    private readonly mapping: MappingConfig,
    private readonly log: Logger,
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(): void {
    this.ctx = null;
  }

  private get groupConfig(): SiteGroupConfig {
    return {
      parent: this.mapping.siteGroupParent,
      pattern: this.mapping.siteGroupPattern,
      auto: this.mapping.siteGroupAuto,
    };
  }

  private role(n: SwisNode): ReturnType<typeof classifyDeviceRole> {
    const customRole = this.mapping.roleField ? n.customProperties[this.mapping.roleField] : null;
    return classifyDeviceRole({
      caption: n.caption,
      vendor: n.vendor,
      machineType: n.machineType,
      isServer: n.isServer,
      customRole: typeof customRole === 'string' ? customRole : null,
    });
  }

  /**
   * Choose the site groups (settings or automatic detection) and link, create, rename or unlink
   * sites to match. Runs after every groups poll, and on the first nodes poll with the devices
   * just fetched, so a fresh install places devices by group straight away.
   */
  async syncSiteGroups(facts?: NodeFacts[]): Promise<{
    mode: string;
    siteGroups: number;
    linked: number;
    unlinked: number;
    renamed: number;
    created: number;
  }> {
    const cfg = this.groupConfig;
    const mode = siteGroupMode(cfg);
    const none = { mode, siteGroups: 0, linked: 0, unlinked: 0, renamed: 0, created: 0 };
    const siteRefs = await loadSiteLinkRefs(this.db);
    if (mode === 'off' && !siteRefs.some((s) => s.orionContainerId !== null)) {
      this.groupSyncPending = false;
      return none;
    }
    let nodes: NodeFacts[] = [];
    if (mode === 'auto') {
      nodes = facts ?? (await loadNodeFacts(this.db, this.mapping.siteField));
      // No devices yet: wait for the nodes poll rather than unlinking everything.
      if (!nodes.length) return none;
    }
    const { keys, linked } = siteKeysAndLinks(siteRefs);
    // Admins' per-group decisions apply in both automatic and manual mode.
    const detect = {
      nodes,
      captionRegex: this.mapping.siteFromCaptionRegex,
      knownSiteKeys: keys,
      linked,
      decisions: await loadSiteGroupDecisions(this.db),
    };
    const { groups, members } = await loadGroupMirror(this.db);
    const choice = chooseSiteGroups(groups, members, cfg, detect);
    const plan = planSiteGroupLinks(choice.siteGroups, siteRefs, this.mapping.autoCreateSites);
    await applySiteGroupPlan(this.db, plan);
    this.groupSyncPending = false;
    const out = {
      mode,
      siteGroups: choice.siteGroups.length,
      linked: plan.link.length,
      unlinked: plan.unlink.length,
      renamed: plan.rename.length,
      created: plan.create.length,
    };
    if (out.linked || out.unlinked || out.renamed || out.created)
      this.log.info(out, 'sites updated from SolarWinds groups');
    this.invalidate();
    return out;
  }

  private async context(force = false): Promise<SiteResolutionContext> {
    if (!force && this.ctx && Date.now() - this.loadedAt < this.ttlMs) return this.ctx;
    const data = await loadSiteContextData(this.db);
    const groupSites =
      siteGroupMode(this.groupConfig) === 'off' ? null : await loadGroupSiteMap(this.db);
    if (groupSites?.ambiguous.length)
      this.log.warn(
        { nodes: groupSites.ambiguous.slice(0, 20), count: groupSites.ambiguous.length },
        'devices are in more than one site group; using the closest group',
      );
    this.ctx = buildSiteResolutionContext(
      data.sites,
      data.divisions,
      data.overrides,
      {
        siteField: this.mapping.siteField,
        divisionField: this.mapping.divisionField,
        siteFromCaptionRegex: this.mapping.siteFromCaptionRegex,
      },
      groupSites?.byNode,
    );
    this.loadedAt = Date.now();
    return this.ctx;
  }

  async resolveAll(
    nodes: SwisNode[],
  ): Promise<{ rows: NodeSnapshotRow[]; unmapped: number; autoCreated: number }> {
    if (this.groupSyncPending && nodes.length)
      await this.syncSiteGroups(
        nodes.map((n) => {
          const v = n.customProperties[this.mapping.siteField];
          return {
            nodeId: n.nodeId,
            caption: n.caption,
            ip: n.ipAddress,
            role: this.role(n),
            location: n.location,
            siteValue: v === null || v === undefined ? null : String(v),
          };
        }),
      );
    let ctx = await this.context();
    let autoCreated = 0;
    if (this.mapping.autoCreateSites) {
      const unmatched = new Set<string>();
      for (const n of nodes) {
        const r = resolveNodeSite(n, ctx);
        if (r.unmatchedSiteValue) unmatched.add(r.unmatchedSiteValue);
      }
      if (unmatched.size) {
        autoCreated = await createAutoSites(this.db, [...unmatched]);
        if (autoCreated)
          this.log.info(
            { created: autoCreated, values: [...unmatched] },
            'auto-created site profiles',
          );
        ctx = await this.context(true);
      }
    }
    let unmapped = 0;
    const rows = nodes.map((n): NodeSnapshotRow => {
      const r = resolveNodeSite(n, ctx);
      if (r.siteId === null) unmapped++;
      const override = ctx.overrides.get(n.nodeId)?.deviceRole;
      const deviceRole = isDeviceRole(override) ? override : this.role(n);
      return {
        ...n,
        siteId: r.siteId,
        divisionCode: r.divisionCode,
        siteSource: r.source,
        deviceRole,
      };
    });
    return { rows, unmapped, autoCreated };
  }
}
