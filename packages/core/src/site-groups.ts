/**
 * Sites from SolarWinds groups. A "site group" is a group chosen by SITE_GROUP_PARENT (its direct
 * sub-groups) and/or SITE_GROUP_PATTERN (a name match). A device belongs to the site group that
 * contains it directly or through nested groups. Each site group is linked to one Site Profile
 * (`sites.orion_container_id`): matched by name on first sight, or created, and renamed with it.
 * Pure: the worker loads the group mirror, and applies the plan these functions return.
 */
import { normalizeKey, slugify } from './util';

export interface GroupRef {
  containerId: number;
  name: string;
}

/** One row of Orion.ContainerMembers: a node, a nested group, or something else (ignored). */
export interface GroupMemberRef {
  containerId: number;
  nodeId: number | null;
  memberContainerId: number | null;
}

export interface SiteGroupConfig {
  parent: string | null;
  pattern: string | null;
}

export interface SiteGroup {
  containerId: number;
  groupName: string;
  /** The pattern's first capture group, else the group name. */
  siteName: string;
}

export function siteGroupsEnabled(cfg: SiteGroupConfig): boolean {
  return !!(cfg.parent?.trim() || cfg.pattern);
}

/** The groups that are sites, sorted by site name. Empty when neither setting is set. */
export function selectSiteGroups(
  groups: readonly GroupRef[],
  members: readonly GroupMemberRef[],
  cfg: SiteGroupConfig,
): SiteGroup[] {
  if (!siteGroupsEnabled(cfg)) return [];
  let candidates: readonly GroupRef[] = groups;
  const parentName = cfg.parent?.trim();
  if (parentName) {
    const key = parentName.toLowerCase();
    const parents = new Set(
      groups.filter((g) => g.name.trim().toLowerCase() === key).map((g) => g.containerId),
    );
    const children = new Set(
      members
        .filter((m) => parents.has(m.containerId) && m.memberContainerId !== null)
        .map((m) => m.memberContainerId!),
    );
    candidates = groups.filter((g) => children.has(g.containerId) && !parents.has(g.containerId));
  }
  const re = cfg.pattern ? new RegExp(cfg.pattern) : null;
  const out: SiteGroup[] = [];
  for (const g of candidates) {
    let siteName = g.name.trim();
    if (re) {
      const m = re.exec(g.name);
      if (!m) continue;
      const captured = m[1]?.trim();
      if (captured) siteName = captured;
    }
    if (siteName) out.push({ containerId: g.containerId, groupName: g.name, siteName });
  }
  return out.sort((a, b) => a.siteName.localeCompare(b.siteName) || a.containerId - b.containerId);
}

export interface NodeSiteGroups {
  /** nodeId → the site group's containerId. */
  byNode: Map<number, number>;
  /** Nodes found in more than one site group; they get the closest, then the lowest ID. */
  ambiguous: number[];
}

/** Which site group each node is in, following nested groups (cycle-safe). */
export function nodeSiteGroups(
  siteGroups: readonly SiteGroup[],
  members: readonly GroupMemberRef[],
): NodeSiteGroups {
  const byContainer = new Map<number, GroupMemberRef[]>();
  for (const m of members) {
    const list = byContainer.get(m.containerId);
    if (list) list.push(m);
    else byContainer.set(m.containerId, [m]);
  }
  const best = new Map<number, { containerId: number; depth: number }>();
  const seenIn = new Map<number, Set<number>>();
  for (const sg of siteGroups) {
    const visited = new Set<number>([sg.containerId]);
    let frontier = [sg.containerId];
    for (let depth = 0; frontier.length; depth++) {
      const next: number[] = [];
      for (const cid of frontier) {
        for (const m of byContainer.get(cid) ?? []) {
          if (m.nodeId !== null) {
            const sites = seenIn.get(m.nodeId) ?? new Set<number>();
            sites.add(sg.containerId);
            seenIn.set(m.nodeId, sites);
            const cur = best.get(m.nodeId);
            if (
              !cur ||
              depth < cur.depth ||
              (depth === cur.depth && sg.containerId < cur.containerId)
            )
              best.set(m.nodeId, { containerId: sg.containerId, depth });
          } else if (m.memberContainerId !== null && !visited.has(m.memberContainerId)) {
            visited.add(m.memberContainerId);
            next.push(m.memberContainerId);
          }
        }
      }
      frontier = next;
    }
  }
  const byNode = new Map<number, number>();
  for (const [nodeId, b] of best) byNode.set(nodeId, b.containerId);
  const ambiguous = [...seenIn].filter(([, s]) => s.size > 1).map(([n]) => n);
  return { byNode, ambiguous: ambiguous.sort((a, b) => a - b) };
}

export interface SiteLinkRef {
  id: number;
  code: string;
  name: string;
  aliases: readonly string[];
  orionContainerId: number | null;
}

export interface SiteGroupPlan {
  /** Existing sites matched by name, code or alias: link them to their group. */
  link: Array<{ siteId: number; containerId: number }>;
  /** Linked sites whose group's site name changed: rename, keeping the old name as an alias. */
  rename: Array<{ siteId: number; from: string; to: string }>;
  /** Site groups with no matching site: create a site for each (when auto-create is on). */
  create: Array<{ containerId: number; name: string; code: string }>;
}

/**
 * Link each site group to a site. A site already linked to the group keeps it (and follows its
 * name). Otherwise an unlinked site whose name, code or alias matches is linked; otherwise a site
 * is created with a code that is unique among existing and new sites.
 */
export function planSiteGroupLinks(
  siteGroups: readonly SiteGroup[],
  sites: readonly SiteLinkRef[],
  autoCreate: boolean,
): SiteGroupPlan {
  const plan: SiteGroupPlan = { link: [], rename: [], create: [] };
  const byContainer = new Map<number, SiteLinkRef>();
  const unlinkedByKey = new Map<string, SiteLinkRef>();
  for (const s of sites) {
    if (s.orionContainerId !== null) byContainer.set(s.orionContainerId, s);
  }
  const groupIds = new Set(siteGroups.map((g) => g.containerId));
  for (const s of sites) {
    // A site linked to a group that is no longer a site group may be re-linked by name.
    if (s.orionContainerId !== null && groupIds.has(s.orionContainerId)) continue;
    for (const k of [s.name, s.code, ...s.aliases]) {
      const key = normalizeKey(k);
      if (key && !unlinkedByKey.has(key)) unlinkedByKey.set(key, s);
    }
  }
  const usedCodes = new Set(sites.map((s) => s.code));
  const claimed = new Set<number>();
  for (const g of siteGroups) {
    const linked = byContainer.get(g.containerId);
    if (linked) {
      claimed.add(linked.id);
      if (linked.name !== g.siteName)
        plan.rename.push({ siteId: linked.id, from: linked.name, to: g.siteName });
      continue;
    }
    const match = unlinkedByKey.get(normalizeKey(g.siteName));
    if (match && !claimed.has(match.id)) {
      claimed.add(match.id);
      plan.link.push({ siteId: match.id, containerId: g.containerId });
      if (match.name !== g.siteName)
        plan.rename.push({ siteId: match.id, from: match.name, to: g.siteName });
      continue;
    }
    if (!autoCreate) continue;
    const base = slugify(g.siteName) || `group-${g.containerId}`;
    let code = base;
    if (usedCodes.has(code)) code = `${base}-${g.containerId}`.slice(0, 64);
    usedCodes.add(code);
    plan.create.push({ containerId: g.containerId, name: g.siteName, code });
  }
  return plan;
}
