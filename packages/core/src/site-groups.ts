/**
 * Sites from SolarWinds groups. A "site group" is found automatically (detectSiteGroups: groups
 * whose devices share a location), or chosen by SITE_GROUP_PARENT (its direct sub-groups) and/or
 * SITE_GROUP_PATTERN (a name match). A device belongs to the site group that contains it directly
 * or through nested groups. Each site group is linked to one Site Profile
 * (`sites.orion_container_id`): matched by name on first sight, or created, and renamed with it.
 * Pure: the worker loads the group mirror and device facts, and applies the plans returned here.
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
  /** Find site groups automatically when neither parent nor pattern is set (SITE_GROUP_AUTO). */
  auto?: boolean;
}

export interface SiteGroup {
  containerId: number;
  groupName: string;
  /** The pattern's first capture group, else the group name without "Site -" and the like. */
  siteName: string;
  /** Why it was chosen (automatic detection), for the Mapping page. */
  reason?: string;
}

export type SiteGroupMode = 'manual' | 'auto' | 'off';

export function siteGroupMode(cfg: SiteGroupConfig): SiteGroupMode {
  if (cfg.parent?.trim() || cfg.pattern) return 'manual';
  return cfg.auto ? 'auto' : 'off';
}

export function siteGroupsEnabled(cfg: SiteGroupConfig): boolean {
  return siteGroupMode(cfg) !== 'off';
}

/** "Site - Rockford", "LOC: Rockford", "Rockford Site" → "Rockford". */
export function cleanGroupName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/^(sites?|locations?|loc|branch(es)?|facilit(y|ies))\s*[-:–—|]\s*/i, '')
    .replace(/\s*[-:–—|]\s*(sites?|locations?)$/i, '')
    .replace(/\s+\((sites?|locations?)\)$/i, '')
    .replace(/\s+(site|location)$/i, '')
    .trim();
  return cleaned || name.trim();
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
    let siteName = cleanGroupName(g.name);
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
  /** Sites linked to a group that is no longer a site group (or gone): unlink them. */
  unlink: Array<{ siteId: number; containerId: number }>;
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
  const plan: SiteGroupPlan = { unlink: [], link: [], rename: [], create: [] };
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
  for (const s of sites)
    if (
      s.orionContainerId !== null &&
      !groupIds.has(s.orionContainerId) &&
      !plan.link.some((l) => l.siteId === s.id)
    )
      plan.unlink.push({ siteId: s.id, containerId: s.orionContainerId });
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Automatic detection
// ---------------------------------------------------------------------------------------------

/** What detection knows about a device. */
export interface NodeFacts {
  nodeId: number;
  caption: string | null;
  ip: string | null;
  role: string | null;
  /** The Site custom property value, if any. */
  siteValue: string | null;
  /** The node's Location field in SolarWinds (often the SNMP sysLocation), if any. */
  location?: string | null;
}

/** An admin's decision about one group, which wins over detection and settings. */
export type SiteGroupDecision = 'site' | 'not_site';

export interface DetectContext {
  nodes: readonly NodeFacts[];
  /** SITE_FROM_CAPTION_REGEX: its first capture group is a hostname's site prefix. */
  captionRegex: string | null;
  /** Normalized names, codes and aliases of the existing sites. */
  knownSiteKeys: ReadonlySet<string>;
  /** Groups already linked to a site stay site groups while they exist, so placement is stable. */
  linked: ReadonlySet<number>;
  /** Groups an admin marked as a site or not a site (Settings → Mapping). */
  decisions?: ReadonlyMap<number, SiteGroupDecision>;
}

export interface RejectedGroup {
  containerId: number;
  groupName: string;
  reason: string;
}

export interface SiteGroupChoice {
  mode: SiteGroupMode;
  siteGroups: SiteGroup[];
  /** Groups automatic detection did not use, with the reason (empty in manual mode). */
  rejected: RejectedGroup[];
}

/**
 * Share of a group's devices that must be at the group's location: a device is, when any of its
 * location signals matches the value most devices in the group have for that signal.
 */
export const SITE_LOCALITY_MIN = 0.75;
/** Groups this small may have one device elsewhere (a firewall polled on its WAN address). */
const SMALL_GROUP_MAX = 5;
/** A location signal counts only if it tells devices apart network-wide. */
const SIGNAL_MIN_VALUES = 3;
const SIGNAL_MIN_COVERAGE = 0.5;
/** Siblings: when this share of a parent's groups are sites, its other local groups are too. */
const SIBLING_SHARE = 0.6;
/** A site group mostly inside another site group is dropped. */
const CONTAINED_SHARE = 0.8;

type Signal = 'cp' | 'location' | 'prefix' | 'word' | 'net24' | 'net16';
const SIGNALS: readonly Signal[] = ['cp', 'location', 'prefix', 'word', 'net24', 'net16'];
const SIGNAL_TEXT: Record<Signal, (k: string) => string> = {
  cp: () => 'same Site property',
  location: () => 'same Location',
  prefix: (k) => `same hostname prefix ${k.toUpperCase()}`,
  word: (k) => `hostnames start with ${k.toUpperCase()}`,
  net24: (k) => `same subnet ${k}.x`,
  net16: (k) => `same network ${k}.x.x`,
};
/** Location values that say nothing. */
const NO_LOCATION = new Set(['', 'unknown', 'notset', 'na', 'none', 'default', 'location']);

/** "Rockford Elevator - MDF rack 2" → "rockfordelevator". */
function locationKey(location: string | null | undefined): string {
  const first = (location ?? '').split(/\s+-\s+|[,;/|(]/)[0] ?? '';
  const key = normalizeKey(first);
  return NO_LOCATION.has(key) ? '' : key;
}

/** The first word of a hostname: "Rockford-SW01" → "rockford", "rkfd_fg60f.mercer" → "rkfd". */
function hostnameWord(caption: string | null): string {
  const word = (caption ?? '').trim().split(/[-_. ]/)[0] ?? '';
  return /[a-z]/i.test(word) && word.length >= 2 ? normalizeKey(word) : '';
}

/** Apply admin decisions to a choice: they win over detection and the manual settings. */
function applyDecisions(
  groups: readonly GroupRef[],
  choice: { siteGroups: SiteGroup[]; rejected: RejectedGroup[] },
  decisions: ReadonlyMap<number, SiteGroupDecision> | undefined,
): { siteGroups: SiteGroup[]; rejected: RejectedGroup[] } {
  if (!decisions?.size) return choice;
  const byId = new Map(groups.map((g) => [g.containerId, g]));
  const siteGroups = choice.siteGroups.filter((g) => decisions.get(g.containerId) !== 'not_site');
  const rejected = choice.rejected.filter((r) => !decisions.has(r.containerId));
  const chosen = new Set(siteGroups.map((g) => g.containerId));
  for (const [cid, d] of decisions) {
    const g = byId.get(cid);
    if (!g) continue;
    if (d === 'site' && !chosen.has(cid)) {
      siteGroups.push({
        containerId: cid,
        groupName: g.name,
        siteName: cleanGroupName(g.name),
        reason: 'marked as a site',
      });
    } else if (d === 'site') {
      const sg = siteGroups.find((x) => x.containerId === cid)!;
      sg.reason = 'marked as a site';
    } else rejected.push({ containerId: cid, groupName: g.name, reason: 'marked “not a site”' });
  }
  siteGroups.sort((a, b) => a.siteName.localeCompare(b.siteName) || a.containerId - b.containerId);
  rejected.sort((a, b) => a.groupName.localeCompare(b.groupName));
  return { siteGroups, rejected };
}

/** Choose the site groups for the current settings: manual, automatic, or none. */
export function chooseSiteGroups(
  groups: readonly GroupRef[],
  members: readonly GroupMemberRef[],
  cfg: SiteGroupConfig,
  detect: DetectContext | null,
): SiteGroupChoice {
  const mode = siteGroupMode(cfg);
  if (mode === 'manual')
    return {
      mode,
      ...applyDecisions(
        groups,
        { siteGroups: selectSiteGroups(groups, members, cfg), rejected: [] },
        detect?.decisions,
      ),
    };
  if (mode === 'off' || !detect) return { mode, siteGroups: [], rejected: [] };
  return {
    mode,
    ...applyDecisions(groups, detectSiteGroups(groups, members, detect), detect.decisions),
  };
}

/**
 * Find the groups that are sites. A group looks like a site when most of its devices share a
 * location (Site property, hostname prefix or subnet, whichever tells sites apart) and it holds
 * several kinds of device or is named after a known site. "All FortiGates" fails the first test
 * (spread over every site) or the second (one kind of device). Then: a group inside another site
 * group is dropped, unless the outer group is really several site groups (a city or region); a
 * group mostly inside another is dropped; and a small local group joins its sibling groups when
 * most of them are sites. Groups already linked to a site stay sites.
 */
export function detectSiteGroups(
  groups: readonly GroupRef[],
  members: readonly GroupMemberRef[],
  ctx: DetectContext,
): { siteGroups: SiteGroup[]; rejected: RejectedGroup[] } {
  const byId = new Map(groups.map((g) => [g.containerId, g]));
  const children = new Map<number, number[]>();
  const directNodes = new Map<number, number[]>();
  const parents = new Map<number, number[]>();
  for (const m of members) {
    if (!byId.has(m.containerId)) continue;
    if (m.nodeId !== null) {
      const l = directNodes.get(m.containerId) ?? [];
      l.push(m.nodeId);
      directNodes.set(m.containerId, l);
    } else if (m.memberContainerId !== null && byId.has(m.memberContainerId)) {
      const l = children.get(m.containerId) ?? [];
      l.push(m.memberContainerId);
      children.set(m.containerId, l);
      const p = parents.get(m.memberContainerId) ?? [];
      p.push(m.containerId);
      parents.set(m.memberContainerId, p);
    }
  }
  const nodesOf = new Map<number, Set<number>>();
  const collect = (cid: number): Set<number> => {
    const done = nodesOf.get(cid);
    if (done) return done;
    const out = new Set<number>();
    const seen = new Set<number>([cid]);
    const stack = [cid];
    while (stack.length) {
      const c = stack.pop()!;
      for (const n of directNodes.get(c) ?? []) out.add(n);
      for (const ch of children.get(c) ?? [])
        if (!seen.has(ch)) {
          seen.add(ch);
          stack.push(ch);
        }
    }
    nodesOf.set(cid, out);
    return out;
  };
  for (const g of groups) collect(g.containerId);

  // Location keys per node, keeping only signals that tell devices apart network-wide.
  const captionRe = ctx.captionRegex ? new RegExp(ctx.captionRegex) : null;
  const keysOf = new Map<number, Partial<Record<Signal, string>>>();
  for (const n of ctx.nodes) {
    const k: Partial<Record<Signal, string>> = {};
    const cp = n.siteValue ? normalizeKey(n.siteValue) : '';
    if (cp) k.cp = cp;
    const loc = locationKey(n.location);
    if (loc) k.location = loc;
    const prefix = captionRe && n.caption ? captionRe.exec(n.caption)?.[1] : undefined;
    if (prefix && normalizeKey(prefix)) k.prefix = normalizeKey(prefix);
    const word = hostnameWord(n.caption);
    if (word) k.word = word;
    const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(n.ip ?? '');
    if (ip) {
      k.net24 = `${ip[1]}.${ip[2]}.${ip[3]}`;
      k.net16 = `${ip[1]}.${ip[2]}`;
    }
    keysOf.set(n.nodeId, k);
  }
  const signals = SIGNALS.filter((sig) => {
    const values = [...keysOf.values()].map((k) => k[sig]).filter((v): v is string => !!v);
    return (
      values.length >= SIGNAL_MIN_COVERAGE * Math.max(1, ctx.nodes.length) &&
      new Set(values).size >= SIGNAL_MIN_VALUES
    );
  });
  const roleOf = new Map(ctx.nodes.map((n) => [n.nodeId, n.role]));

  interface Stats {
    size: number;
    /** Devices at the group's location (agreeing on at least one signal). */
    agree: number;
    /** Most devices sharing any one location value, for the reason text. */
    together: number;
    /** Devices whose hostname, Site property or Location matches the group's name. */
    named: number;
    /** Devices sharing the best signal's value. */
    bestCount: number;
    locality: number;
    /** The signal most devices share, for the reason text. */
    signal: Signal | null;
    key: string | null;
    roles: number;
    nameMatch: boolean;
    siteName: string;
  }
  const knownKeys = [...ctx.knownSiteKeys];
  const stats = new Map<number, Stats>();
  for (const g of groups) {
    const nodes = [...nodesOf.get(g.containerId)!].filter((n) => keysOf.has(n));
    // The value most devices in the group have, per signal (when it is a real majority).
    const majority = new Map<Signal, { key: string; count: number }>();
    let together = 0;
    for (const sig of signals) {
      const counts = new Map<string, number>();
      let present = 0;
      for (const n of nodes) {
        const v = keysOf.get(n)![sig];
        if (!v) continue;
        present++;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      if (!present) continue;
      const [key, count] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
      together = Math.max(together, count);
      if (count >= 0.5 * present && count >= 0.5 * nodes.length) majority.set(sig, { key, count });
    }
    const siteName = cleanGroupName(g.name);
    const nameKey = normalizeKey(siteName);
    const contains = (a: string, b: string) =>
      a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
    // A device whose hostname starts like the group's name, or whose Site property or Location
    // matches it, is at that site: "ROCK-FW01" and "rockford-ap1" in "Rockford Elevator".
    const namedHere = (k: Partial<Record<Signal, string>>) =>
      nameKey.length >= 3 &&
      ((!!k.prefix && k.prefix.length >= 3 && nameKey.startsWith(k.prefix)) ||
        (!!k.word && k.word.length >= 3 && nameKey.startsWith(k.word)) ||
        (!!k.cp && (k.cp === nameKey || contains(k.cp, nameKey))) ||
        (!!k.location && (k.location === nameKey || contains(k.location, nameKey))));
    const named = nodes.filter((n) => namedHere(keysOf.get(n)!)).length;
    const agree = nodes.filter((n) => {
      const k = keysOf.get(n)!;
      return namedHere(k) || [...majority].some(([sig, m]) => k[sig] === m.key);
    }).length;
    const locality = nodes.length ? agree / nodes.length : 0;
    let signal: Signal | null = null;
    let key: string | null = null;
    let best = 0;
    for (const [sig, m] of majority)
      if (m.count > best) [best, signal, key] = [m.count, sig, m.key];
    const roles = new Set(
      nodes.map((n) => roleOf.get(n)).filter((r): r is string => !!r && r !== 'other'),
    ).size;
    const cpKey = majority.get('cp')?.key;
    const locKey = majority.get('location')?.key;
    const prefixKey = majority.get('prefix')?.key;
    const wordKey = majority.get('word')?.key;
    const nameMatch =
      !!nameKey &&
      (ctx.knownSiteKeys.has(nameKey) ||
        knownKeys.some((k) => k.startsWith(nameKey) && nameKey.length >= 4) ||
        (!!cpKey && (nameKey === cpKey || contains(nameKey, cpKey))) ||
        (!!locKey && (nameKey === locKey || contains(nameKey, locKey))) ||
        (!!prefixKey && prefixKey.length >= 3 && nameKey.startsWith(prefixKey)) ||
        (!!wordKey && wordKey.length >= 3 && nameKey.startsWith(wordKey)));
    stats.set(g.containerId, {
      size: nodes.length,
      agree,
      together: Math.max(together, agree),
      named,
      bestCount: best,
      locality,
      signal,
      key,
      roles,
      nameMatch,
      siteName,
    });
  }
  const isLocal = (st: Stats) =>
    st.size > 0 &&
    (st.locality >= SITE_LOCALITY_MIN ||
      (st.size >= 3 && st.size <= SMALL_GROUP_MAX && st.agree >= st.size - 1));

  const reasonFor = (st: Stats): string => {
    const parts: string[] = [];
    if (st.named > st.bestCount) parts.push(`${st.named} of ${st.size} devices match its name`);
    else if (st.signal && st.key) parts.push(SIGNAL_TEXT[st.signal](st.key));
    if (st.roles >= 2) parts.push(`${st.roles} kinds of device`);
    if (st.nameMatch) parts.push('named after a site');
    return parts.join(', ');
  };
  const rejected = new Map<number, string>();
  const accepted = new Set<number>();
  /** Linked groups kept only because they are linked: why they would not qualify today. */
  const keptLinked = new Map<number, string>();
  for (const g of groups) {
    const st = stats.get(g.containerId)!;
    const local = isLocal(st);
    if (ctx.decisions?.get(g.containerId) === 'not_site') continue;
    if (st.size === 0) rejected.set(g.containerId, 'no monitored devices');
    else if (!local && !signals.length && ctx.knownSiteKeys.has(normalizeKey(st.siteName)))
      // Nothing to compare locations with: a group named exactly after a site is still one.
      accepted.add(g.containerId);
    else if (!local)
      rejected.set(
        g.containerId,
        signals.length
          ? `devices are at several locations (at most ${st.together} of ${st.size} in one place)`
          : 'no location information to compare',
      );
    else if (st.roles >= 2 || st.nameMatch) accepted.add(g.containerId);
    else rejected.set(g.containerId, 'one kind of device, and not named after a site');
    // A linked group stays a site while it has devices, so placement doesn't flap.
    if (ctx.linked.has(g.containerId) && st.size > 0 && !accepted.has(g.containerId)) {
      keptLinked.set(g.containerId, rejected.get(g.containerId) ?? '');
      rejected.delete(g.containerId);
      accepted.add(g.containerId);
    }
  }

  // Nesting: keep the outermost site group, unless it is several site groups (a city or region).
  const nearestAccepted = (cid: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>([cid]);
    const stack = [...(children.get(cid) ?? [])];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      if (accepted.has(c)) out.push(c);
      else stack.push(...(children.get(c) ?? []));
    }
    return out;
  };
  const hasAcceptedAncestor = (cid: number): boolean => {
    const seen = new Set<number>([cid]);
    const stack = [...(parents.get(cid) ?? [])];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      if (accepted.has(p)) return true;
      stack.push(...(parents.get(p) ?? []));
    }
    return false;
  };
  const chosen = new Set<number>();
  const resolve = (cid: number, trail: Set<number>) => {
    if (trail.has(cid)) return;
    trail.add(cid);
    const inner = nearestAccepted(cid);
    const covered = new Set(inner.flatMap((c) => [...nodesOf.get(c)!]));
    if (inner.length >= 2 && covered.size >= CONTAINED_SHARE * nodesOf.get(cid)!.size) {
      rejected.set(cid, 'contains several site groups');
      for (const c of inner) resolve(c, trail);
    } else {
      chosen.add(cid);
      for (const c of inner) rejected.set(c, `inside the site group “${byId.get(cid)!.name}”`);
    }
  };
  for (const cid of accepted) if (!hasAcceptedAncestor(cid)) resolve(cid, new Set());

  // Overlap: a site group mostly inside a bigger one is the same place.
  const ordered = [...chosen].sort((a, b) => nodesOf.get(b)!.size - nodesOf.get(a)!.size || a - b);
  for (let i = 0; i < ordered.length; i++) {
    const small = ordered[i]!;
    if (!chosen.has(small)) continue;
    for (let j = 0; j < i; j++) {
      const big = ordered[j]!;
      if (!chosen.has(big) || ctx.linked.has(small)) continue;
      const sn = nodesOf.get(small)!;
      const bn = nodesOf.get(big)!;
      let shared = 0;
      for (const n of sn) if (bn.has(n)) shared++;
      if (sn.size && shared >= CONTAINED_SHARE * sn.size) {
        chosen.delete(small);
        rejected.set(small, `mostly the same devices as “${byId.get(big)!.name}”`);
        break;
      }
    }
  }

  // Siblings: small local groups next to site groups are sites too.
  const bySibling = new Set<number>();
  const siblingSets = new Map<number, number[]>(); // parent id (0 = top level) → children
  for (const g of groups) {
    for (const p of parents.get(g.containerId) ?? [0]) {
      const l = siblingSets.get(p) ?? [];
      l.push(g.containerId);
      siblingSets.set(p, l);
    }
  }
  for (const sibs of siblingSets.values()) {
    // Only local groups with devices of their own count: "All FortiGates" says nothing about the
    // site groups next to it, and "Celina HQ Servers" is part of a site.
    const sites = sibs.filter((c) => chosen.has(c));
    const taken = new Set(sites.flatMap((c) => [...nodesOf.get(c)!]));
    const candidates = sibs.filter(
      (c) =>
        !chosen.has(c) &&
        !accepted.has(c) &&
        ctx.decisions?.get(c) !== 'not_site' &&
        isLocal(stats.get(c)!) &&
        ![...nodesOf.get(c)!].some((n) => taken.has(n)),
    );
    if (sites.length < 2 || sites.length < SIBLING_SHARE * (sites.length + candidates.length))
      continue;
    for (const c of candidates) {
      chosen.add(c);
      rejected.delete(c);
      bySibling.add(c);
    }
  }

  const siteGroups: SiteGroup[] = [...chosen].map((cid) => {
    const g = byId.get(cid)!;
    const st = stats.get(cid)!;
    const why = keptLinked.has(cid)
      ? `kept because it is linked to a site (on its own: ${keptLinked.get(cid)})`
      : bySibling.has(cid)
        ? `${reasonFor(st) || 'local devices'}, like the groups next to it`
        : reasonFor(st);
    return { containerId: cid, groupName: g.name, siteName: st.siteName, reason: why };
  });
  siteGroups.sort((a, b) => a.siteName.localeCompare(b.siteName) || a.containerId - b.containerId);
  const rejectedList = [...rejected]
    .filter(([cid]) => !chosen.has(cid))
    .map(([cid, reason]) => ({ containerId: cid, groupName: byId.get(cid)!.name, reason }))
    .sort((a, b) => a.groupName.localeCompare(b.groupName));
  return { siteGroups, rejected: rejectedList };
}
