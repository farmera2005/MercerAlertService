/**
 * Routing rules (Settings → Routing): which Teams channel hears about an incident, and whether
 * the on-call person is paged. Rules are evaluated in order; every matching rule contributes,
 * until one marked "stop" matches.
 */
import type { IncidentKind, Priority } from '../correlation/types';
import type { RoutingRule } from './types';

export interface RouteSubject {
  priority: Priority;
  kind: IncidentKind;
  divisionCode: string | null;
  siteId: number | null;
  affectedSiteIds: readonly number[];
  /** Within the primary site's business hours (harvest hours in harvest). */
  withinBusinessHours: boolean;
}

export interface RouteResult {
  channelKeys: string[];
  page: boolean;
  /** Shortest escalation delay among the paging rules that matched (null: use the default). */
  escalateAfterMin: number | null;
  ruleIds: number[];
}

const has = <T>(list: readonly T[] | undefined, v: T | null) =>
  !list || list.length === 0 || (v !== null && list.includes(v));

export function ruleMatches(rule: RoutingRule, s: RouteSubject): boolean {
  if (!rule.enabled) return false;
  const m = rule.match;
  if (!has(m.priorities, s.priority)) return false;
  if (!has(m.kinds, s.kind)) return false;
  if (!has(m.divisions, s.divisionCode)) return false;
  if (m.siteIds?.length) {
    const sites = [s.siteId, ...s.affectedSiteIds].filter((x): x is number => x !== null);
    if (!sites.some((id) => m.siteIds!.includes(id))) return false;
  }
  if (m.hours === 'business' && !s.withinBusinessHours) return false;
  if (m.hours === 'after' && s.withinBusinessHours) return false;
  return true;
}

export function routeIncident(rules: readonly RoutingRule[], s: RouteSubject): RouteResult {
  const out: RouteResult = { channelKeys: [], page: false, escalateAfterMin: null, ruleIds: [] };
  for (const rule of [...rules].sort((a, b) => a.position - b.position || a.id - b.id)) {
    if (!ruleMatches(rule, s)) continue;
    out.ruleIds.push(rule.id);
    if (rule.channelKey && !out.channelKeys.includes(rule.channelKey))
      out.channelKeys.push(rule.channelKey);
    if (rule.pageOncall) {
      out.page = true;
      if (rule.escalateAfterMin !== null)
        out.escalateAfterMin =
          out.escalateAfterMin === null
            ? rule.escalateAfterMin
            : Math.min(out.escalateAfterMin, rule.escalateAfterMin);
    }
    if (rule.stop) break;
  }
  return out;
}

/** Placeholder rules seeded on a fresh install (open question C1/C6). */
export const DEFAULT_ROUTING_RULES: Array<Omit<RoutingRule, 'id'>> = [
  {
    name: 'P1–P2 to net-critical',
    position: 10,
    enabled: true,
    match: { priorities: ['P1', 'P2'] },
    channelKey: 'net-critical',
    pageOncall: false,
    escalateAfterMin: null,
    stop: false,
  },
  {
    name: 'P3–P4 to net-alerts',
    position: 20,
    enabled: true,
    match: { priorities: ['P3', 'P4'] },
    channelKey: 'net-alerts',
    pageOncall: false,
    escalateAfterMin: null,
    stop: false,
  },
  {
    name: 'Page on-call for every P1',
    position: 30,
    enabled: true,
    match: { priorities: ['P1'] },
    channelKey: null,
    pageOncall: true,
    escalateAfterMin: 15,
    stop: false,
  },
  {
    name: 'Page on-call for P2 after business hours',
    position: 40,
    enabled: true,
    match: { priorities: ['P2'], hours: 'after' },
    channelKey: null,
    pageOncall: true,
    escalateAfterMin: 15,
    stop: false,
  },
];
