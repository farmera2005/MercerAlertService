import { normalizeKey } from './util';

// ---------------------------------------------------------------------------------------------
// Device roles
// ---------------------------------------------------------------------------------------------

export const DEVICE_ROLES = [
  'firewall',
  'core_switch',
  'switch',
  'router',
  'access_point',
  'server',
  'scale_system',
  'ups',
  'other',
] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];

export function isDeviceRole(v: unknown): v is DeviceRole {
  return typeof v === 'string' && (DEVICE_ROLES as readonly string[]).includes(v);
}

export interface RoleRule {
  field: 'caption' | 'vendor' | 'machineType';
  pattern: string;
  flags?: string;
  role: DeviceRole;
}

/**
 * Default heuristics, evaluated in order (first match wins). Business-specific roles
 * (scales) come first so a CompuWeigh PC isn't classified as a generic server.
 * Admin → Mapping (M6) can replace this list; per-node overrides always win.
 */
export const DEFAULT_ROLE_RULES: readonly RoleRule[] = [
  {
    field: 'caption',
    pattern: 'scale|compuweigh|(^|[-_])cwg?\\d*([-_]|$)',
    flags: 'i',
    role: 'scale_system',
  },
  {
    field: 'vendor',
    pattern: 'cyberpower|american power conversion|\\bapc\\b|eaton|vertiv|liebert',
    flags: 'i',
    role: 'ups',
  },
  { field: 'machineType', pattern: '\\bups\\b|smart-ups|powerpanel', flags: 'i', role: 'ups' },
  { field: 'caption', pattern: '(^|[-_])ups\\d*([-_]|$)', flags: 'i', role: 'ups' },
  { field: 'vendor', pattern: 'fortinet', flags: 'i', role: 'firewall' },
  {
    field: 'machineType',
    pattern: 'fortigate|\\basa\\b|firepower|palo alto|sonicwall',
    flags: 'i',
    role: 'firewall',
  },
  { field: 'caption', pattern: '(^|[-_])(fw|fgt)\\d*([-_]|$)', flags: 'i', role: 'firewall' },
  { field: 'caption', pattern: '(^|[-_])(core|csw)\\d*([-_]|$)', flags: 'i', role: 'core_switch' },
  {
    field: 'machineType',
    pattern: '\\buap\\b|\\bu6\\b|\\bu7\\b|unifi ?ap|access ?point|aironet|\\bap\\b',
    flags: 'i',
    role: 'access_point',
  },
  { field: 'caption', pattern: '(^|[-_])w?ap\\d*([-_]|$)', flags: 'i', role: 'access_point' },
  {
    field: 'machineType',
    pattern: '\\bcrs\\d*|\\busw\\b|switch|catalyst|nexus|edgeswitch|\\bsg\\d{3}|\\bcbs\\d{3}',
    flags: 'i',
    role: 'switch',
  },
  {
    field: 'machineType',
    pattern:
      '\\bisr\\b|\\basr\\b|router|routerboard|\\brb\\d|\\bccr\\d|hex|edgerouter|\\busg\\b|\\budm\\b',
    flags: 'i',
    role: 'router',
  },
  { field: 'vendor', pattern: 'mikrotik', flags: 'i', role: 'router' },
  { field: 'caption', pattern: '(^|[-_])(sw|asw)\\d*([-_]|$)', flags: 'i', role: 'switch' },
  {
    field: 'machineType',
    pattern: 'windows|linux|ubuntu|red hat|centos|debian|vmware|esxi',
    flags: 'i',
    role: 'server',
  },
  {
    field: 'vendor',
    pattern: 'microsoft|net-snmp|linux|vmware|supermicro',
    flags: 'i',
    role: 'server',
  },
];

export interface RoleInput {
  caption?: string | null;
  vendor?: string | null;
  machineType?: string | null;
  isServer?: boolean | null;
  /** Value of the optional device-role custom property (CP_ROLE_FIELD). */
  customRole?: string | null;
}

const compiled = new WeakMap<readonly RoleRule[], Array<RoleRule & { re: RegExp }>>();

function compile(rules: readonly RoleRule[]) {
  let c = compiled.get(rules);
  if (!c) {
    c = rules.map((r) => ({ ...r, re: new RegExp(r.pattern, r.flags ?? 'i') }));
    compiled.set(rules, c);
  }
  return c;
}

const CUSTOM_ROLE_ALIASES: Record<string, DeviceRole> = {
  firewall: 'firewall',
  fw: 'firewall',
  wanedge: 'firewall',
  coreswitch: 'core_switch',
  core: 'core_switch',
  switch: 'switch',
  accessswitch: 'switch',
  router: 'router',
  ap: 'access_point',
  accesspoint: 'access_point',
  wap: 'access_point',
  server: 'server',
  scale: 'scale_system',
  scales: 'scale_system',
  scalesystem: 'scale_system',
  compuweigh: 'scale_system',
  ups: 'ups',
};

export function classifyDeviceRole(
  input: RoleInput,
  rules: readonly RoleRule[] = DEFAULT_ROLE_RULES,
): DeviceRole {
  if (input.customRole) {
    const mapped = CUSTOM_ROLE_ALIASES[normalizeKey(input.customRole)];
    if (mapped) return mapped;
  }
  for (const r of compile(rules)) {
    const value = input[r.field];
    if (value && r.re.test(value)) return r.role;
  }
  if (input.isServer) return 'server';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// Site / division resolution
// ---------------------------------------------------------------------------------------------

export interface SiteRef {
  id: number;
  code: string;
  name: string;
  aliases: readonly string[];
  divisionCode: string | null;
}

export interface DivisionRef {
  code: string;
  name: string;
  aliases: readonly string[];
}

export interface NodeOverride {
  siteId?: number | null;
  divisionCode?: string | null;
  deviceRole?: string | null;
}

export interface SiteResolutionConfig {
  siteField: string;
  divisionField: string;
  siteFromCaptionRegex: string | null;
}

export interface SiteResolutionContext {
  sitesByKey: Map<string, SiteRef>;
  sitesById: Map<number, SiteRef>;
  divisionsByKey: Map<string, DivisionRef>;
  overrides: Map<number, NodeOverride>;
  /** nodeId → siteId from SolarWinds site groups (see site-groups.ts); empty when not used. */
  groupSiteByNode: Map<number, number>;
  config: SiteResolutionConfig;
  captionRe: RegExp | null;
}

export function buildSiteResolutionContext(
  sites: readonly SiteRef[],
  divisions: readonly DivisionRef[],
  overrides: Map<number, NodeOverride>,
  config: SiteResolutionConfig,
  groupSiteByNode: Map<number, number> = new Map(),
): SiteResolutionContext {
  const sitesByKey = new Map<string, SiteRef>();
  const sitesById = new Map<number, SiteRef>();
  for (const s of sites) {
    sitesById.set(s.id, s);
    for (const k of [s.code, s.name, ...s.aliases]) {
      const key = normalizeKey(k);
      if (key && !sitesByKey.has(key)) sitesByKey.set(key, s);
    }
  }
  const divisionsByKey = new Map<string, DivisionRef>();
  for (const d of divisions) {
    for (const k of [d.code, d.name, ...d.aliases]) {
      const key = normalizeKey(k);
      if (key && !divisionsByKey.has(key)) divisionsByKey.set(key, d);
    }
  }
  return {
    sitesByKey,
    sitesById,
    divisionsByKey,
    overrides,
    groupSiteByNode,
    config,
    captionRe: config.siteFromCaptionRegex ? new RegExp(config.siteFromCaptionRegex) : null,
  };
}

export type SiteSource = 'override' | 'group' | 'custom_property' | 'caption' | 'none';

export interface SiteResolution {
  siteId: number | null;
  /** Non-empty Site custom-property value that matched no site (candidate for auto-create). */
  unmatchedSiteValue: string | null;
  divisionCode: string | null;
  source: SiteSource;
}

function cpString(cps: Record<string, unknown>, field: string): string | null {
  if (!field) return null;
  const v = cps[field];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * Resolve a node to a site and division. Order: admin override → SolarWinds site group → Site
 * custom property → hostname-prefix regex → unmapped. Division: override → Division custom
 * property → site's division.
 */
export function resolveNodeSite(
  node: { nodeId: number; caption: string | null; customProperties: Record<string, unknown> },
  ctx: SiteResolutionContext,
): SiteResolution {
  const ov = ctx.overrides.get(node.nodeId);
  let siteId: number | null = null;
  let source: SiteSource = 'none';
  let unmatchedSiteValue: string | null = null;

  if (ov?.siteId != null && ctx.sitesById.has(ov.siteId)) {
    siteId = ov.siteId;
    source = 'override';
  }

  if (siteId === null) {
    const fromGroup = ctx.groupSiteByNode.get(node.nodeId);
    if (fromGroup !== undefined && ctx.sitesById.has(fromGroup)) {
      siteId = fromGroup;
      source = 'group';
    }
  }

  if (siteId === null) {
    const cpSite = cpString(node.customProperties, ctx.config.siteField);
    if (cpSite) {
      const s = ctx.sitesByKey.get(normalizeKey(cpSite));
      if (s) {
        siteId = s.id;
        source = 'custom_property';
      } else {
        unmatchedSiteValue = cpSite;
      }
    }
  }

  if (siteId === null && !unmatchedSiteValue && ctx.captionRe && node.caption) {
    const m = ctx.captionRe.exec(node.caption);
    const code = m?.[1];
    if (code) {
      const s = ctx.sitesByKey.get(normalizeKey(code));
      if (s) {
        siteId = s.id;
        source = 'caption';
      }
    }
  }

  let divisionCode: string | null = null;
  if (ov?.divisionCode) divisionCode = ov.divisionCode;
  if (!divisionCode) {
    const cpDiv = cpString(node.customProperties, ctx.config.divisionField);
    if (cpDiv) divisionCode = ctx.divisionsByKey.get(normalizeKey(cpDiv))?.code ?? null;
  }
  if (!divisionCode && siteId !== null)
    divisionCode = ctx.sitesById.get(siteId)?.divisionCode ?? null;

  return { siteId, unmatchedSiteValue, divisionCode, source };
}
