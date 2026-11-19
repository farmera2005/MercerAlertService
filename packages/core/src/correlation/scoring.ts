/**
 * Deterministic priority:
 *   score = impact points × Orion severity weight × site tier × season × time of day
 *   P1 ≥ p1Min · P2 ≥ p2Min · P3 ≥ p3Min · else P4
 * Every factor is returned so the UI can explain the priority.
 */
import type { DeviceRole } from '../mapping';
import { activeSeasons, isWithinHours, siteHours } from './calendar';
import type {
  ImpactClass,
  IncidentKind,
  Priority,
  PriorityFactors,
  RecordSeverity,
  ScoringConfig,
  SeasonPeriod,
  SiteInfo,
} from './types';

export const SEVERITY_WEIGHT: Readonly<Record<RecordSeverity, number>> = {
  critical: 1.0,
  serious: 0.85,
  warning: 0.6,
  notice: 0.4,
  informational: 0.25,
  none: 0.6,
};

/** What losing one device of this role means for the business. */
export const ROLE_IMPACT: Readonly<Record<DeviceRole, number>> = {
  firewall: 50,
  core_switch: 50,
  scale_system: 50,
  router: 45,
  server: 40,
  switch: 35,
  ups: 30,
  access_point: 25,
  other: 25,
};

export const CORE_ROLES: ReadonlySet<DeviceRole> = new Set([
  'firewall',
  'core_switch',
  'router',
  'server',
  'scale_system',
]);

const IMPACT_LABEL: Record<ImpactClass, string> = {
  site_outage: 'Whole site down',
  core_device: 'Core device down',
  multi_device: 'Several devices down',
  single_device: 'Single device down',
  ups_power: 'Power / UPS problem',
  core_interface: 'Interface on a core device',
  interface: 'Interface problem',
  service: 'Service / application',
  informational: 'Performance or informational',
};

export interface ScoreInput {
  kind: IncidentKind;
  /** Roles of distinct nodes that are down (not merely unreachable). */
  downRoles: DeviceRole[];
  /** Distinct nodes down or unreachable. */
  affectedNodes: number;
  interfaceOnCoreRole: boolean;
  firewallDown: boolean;
  severity: RecordSeverity;
  site: SiteInfo | null;
  seasons: readonly SeasonPeriod[];
  now: Date;
  timeZone: string;
  cfg: ScoringConfig;
}

export interface ScoreResult {
  score: number;
  priority: Priority;
  factors: PriorityFactors;
  recoveryTargetMin: number;
  harvestCriticalInHarvest: boolean;
}

function impactOf(i: ScoreInput): { impact: ImpactClass; points: number } {
  switch (i.kind) {
    case 'site_outage':
      return { impact: 'site_outage', points: 70 };
    case 'ups_power':
      return { impact: 'ups_power', points: 40 };
    case 'interface':
      return i.interfaceOnCoreRole
        ? { impact: 'core_interface', points: 40 }
        : { impact: 'interface', points: 20 };
    case 'service':
      return { impact: 'service', points: 30 };
    default:
      break;
  }
  if (i.downRoles.length >= 2) {
    return {
      impact: 'multi_device',
      points: Math.min(60, Math.max(...i.downRoles.map((r) => ROLE_IMPACT[r])) + 10),
    };
  }
  if (i.downRoles.length === 1) {
    const role = i.downRoles[0]!;
    return {
      impact: CORE_ROLES.has(role) ? 'core_device' : 'single_device',
      points: ROLE_IMPACT[role],
    };
  }
  if (i.affectedNodes >= 2) return { impact: 'multi_device', points: 35 };
  if (i.affectedNodes === 1) return { impact: 'single_device', points: 25 };
  return { impact: 'informational', points: 15 };
}

export function priorityFromScore(score: number, cfg: ScoringConfig): Priority {
  if (score >= cfg.p1Min) return 'P1';
  if (score >= cfg.p2Min) return 'P2';
  if (score >= cfg.p3Min) return 'P3';
  return 'P4';
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreIncident(i: ScoreInput): ScoreResult {
  const seasons = activeSeasons(i.seasons, i.now, i.timeZone);
  const harvest = seasons.some((s) => s.kind === 'harvest');
  const harvestCriticalInHarvest = harvest && !!i.site?.harvestCritical;
  const recoveryTargetMin = harvestCriticalInHarvest
    ? i.cfg.recoveryHarvestMin
    : i.cfg.recoveryDefaultMin;

  if (i.kind === 'monitoring_source_down') {
    const factors: PriorityFactors = {
      fixed: 'Monitoring source down is always P1',
      impact: 'informational',
      impactPoints: 0,
      severity: 'critical',
      severityWeight: 1,
      tier: null,
      tierMult: 1,
      season: null,
      seasonMult: 1,
      businessHours: true,
      timeMult: 1,
      score: 100,
      explanation: [
        'SolarWinds itself is unavailable: nothing else can be detected until it is back → P1 (fixed)',
      ],
    };
    return { score: 100, priority: 'P1', factors, recoveryTargetMin, harvestCriticalInHarvest };
  }

  const { impact, points } = impactOf(i);
  const severityWeight = SEVERITY_WEIGHT[i.severity];
  const tier = i.site?.tier ?? null;
  const tierMult = tier === 'critical' ? i.cfg.tierCritical : tier === 'high' ? i.cfg.tierHigh : 1;

  let seasonMult = 1;
  let season: string | null = null;
  for (const s of seasons) {
    let m = 1;
    if (s.kind === 'harvest') {
      if (i.site?.harvestCritical) m = s.multiplier;
      else if (i.site?.divisionCodes.includes('grain')) m = i.cfg.harvestGrainMult;
    } else {
      const divOk =
        !s.divisions?.length || s.divisions.some((d) => i.site?.divisionCodes.includes(d));
      const hcOk = !s.harvestCriticalOnly || !!i.site?.harvestCritical;
      if (divOk && hcOk) m = s.multiplier;
    }
    if (m > seasonMult) {
      seasonMult = m;
      season = s.name;
    }
  }

  const inHours = i.site ? isWithinHours(i.now, siteHours(i.site, harvest), i.timeZone) : true;
  const exempt = (impact === 'site_outage' || i.firewallDown) && harvestCriticalInHarvest;
  const timeMult = inHours || exempt ? 1 : i.cfg.afterHoursMult;

  const score = round1(points * severityWeight * tierMult * seasonMult * timeMult);
  const priority = priorityFromScore(score, i.cfg);
  const explanation = [
    `${IMPACT_LABEL[impact]} (${points})`,
    `Orion severity ${i.severity} ×${severityWeight}`,
    tier ? `${tier[0]!.toUpperCase()}${tier.slice(1)}-tier site ×${tierMult}` : 'Site unknown ×1',
    season ? `${season} ×${seasonMult}` : 'No high-risk season ×1',
    inHours
      ? 'Within business hours ×1'
      : exempt
        ? 'After hours, but harvest-critical outage ×1'
        : `Outside business hours ×${timeMult}`,
    `Score ${score} → ${priority}`,
  ];
  return {
    score,
    priority,
    recoveryTargetMin,
    harvestCriticalInHarvest,
    factors: {
      impact,
      impactPoints: points,
      severity: i.severity,
      severityWeight,
      tier,
      tierMult,
      season,
      seasonMult,
      businessHours: inHours,
      timeMult,
      score,
      explanation,
      firewallDown: i.firewallDown,
      harvestCriticalInHarvest,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// AI guardrail (used by Milestone 5; enforced here so the rule lives with the scoring code)
// ---------------------------------------------------------------------------------------------

const RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
const BY_RANK: Priority[] = ['P1', 'P1', 'P2', 'P3', 'P4'];

export interface GuardrailContext {
  kind: IncidentKind;
  firewallDown: boolean;
  harvestCriticalInHarvest: boolean;
}

/**
 * Apply an AI-suggested adjustment (clamped to ±1 level). The AI can never push a whole-site
 * outage, a firewall-down incident, or any harvest-critical site during harvest below P2 — and
 * if such an incident is already below P2 it cannot be lowered at all. Source-down is fixed.
 */
export function applyAiAdjustment(
  base: Priority,
  suggested: number,
  ctx: GuardrailContext,
): { priority: Priority; adjust: -1 | 0 | 1; guardrail: string | null } {
  if (ctx.kind === 'monitoring_source_down')
    return { priority: base, adjust: 0, guardrail: 'Monitoring source down is fixed at P1' };
  const adjust = (Math.max(-1, Math.min(1, Math.round(suggested))) || 0) as -1 | 0 | 1;
  // +1 = more urgent (lower rank number).
  const rank = Math.max(1, Math.min(4, RANK[base] - adjust));
  const isProtected =
    ctx.kind === 'site_outage' || ctx.firewallDown || ctx.harvestCriticalInHarvest;
  if (isProtected && adjust < 0 && rank > 2) {
    const kept = Math.min(RANK[base], 4) > 2 ? RANK[base] : 2;
    return {
      priority: BY_RANK[kept]!,
      adjust: kept === RANK[base] ? 0 : -1,
      guardrail:
        'AI may not lower a site outage, firewall-down or harvest-critical incident below P2',
    };
  }
  return { priority: BY_RANK[rank]!, adjust, guardrail: null };
}
