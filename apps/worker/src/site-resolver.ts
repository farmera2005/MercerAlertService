import {
  buildSiteResolutionContext,
  classifyDeviceRole,
  isDeviceRole,
  resolveNodeSite,
  type Logger,
  type MappingConfig,
  type SiteResolutionContext,
} from '@mercer/core';
import { createAutoSites, loadSiteContextData, type Db, type NodeSnapshotRow } from '@mercer/db';
import type { SwisNode } from '@mercer/swis';

/** Resolves SWIS nodes to sites/divisions/roles; caches Site Profiles briefly. */
export class SiteResolver {
  private ctx: SiteResolutionContext | null = null;
  private loadedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly mapping: MappingConfig,
    private readonly log: Logger,
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(): void {
    this.ctx = null;
  }

  private async context(force = false): Promise<SiteResolutionContext> {
    if (!force && this.ctx && Date.now() - this.loadedAt < this.ttlMs) return this.ctx;
    const data = await loadSiteContextData(this.db);
    this.ctx = buildSiteResolutionContext(data.sites, data.divisions, data.overrides, {
      siteField: this.mapping.siteField,
      divisionField: this.mapping.divisionField,
      siteFromCaptionRegex: this.mapping.siteFromCaptionRegex,
    });
    this.loadedAt = Date.now();
    return this.ctx;
  }

  async resolveAll(
    nodes: SwisNode[],
  ): Promise<{ rows: NodeSnapshotRow[]; unmapped: number; autoCreated: number }> {
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
      const customRole = this.mapping.roleField ? n.customProperties[this.mapping.roleField] : null;
      const deviceRole = isDeviceRole(override)
        ? override
        : classifyDeviceRole({
            caption: n.caption,
            vendor: n.vendor,
            machineType: n.machineType,
            isServer: n.isServer,
            customRole: typeof customRole === 'string' ? customRole : null,
          });
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
