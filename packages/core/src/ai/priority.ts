/**
 * How an AI priority suggestion becomes (or does not become) the incident's priority.
 * The model may only suggest ±1 level; `applyAiAdjustment` (scoring.ts) clamps it with the
 * guardrails. The applied step is stored with the basis it was made for (`kind/basePriority`),
 * and the correlation engine re-applies it only while that basis still holds.
 */
import { applyAiAdjustment } from '../correlation/scoring';
import type { IncidentKind, Priority } from '../correlation/types';

export const AI_PRIORITY_MODES = ['apply', 'suggest', 'off'] as const;
export type AiPriorityMode = (typeof AI_PRIORITY_MODES)[number];

export interface GuardFacts {
  firewallDown: boolean;
  harvestCriticalInHarvest: boolean;
}

export function priorityBasis(kind: IncidentKind, base: Priority): string {
  return `${kind}/${base}`;
}

/** Priority from the score plus a stored AI step, if the step still applies. */
export function effectivePriority(
  base: Priority,
  kind: IncidentKind,
  stored: { aiPriorityAdjust: number | null; aiPriorityBasis: string | null },
  guard: GuardFacts,
): Priority {
  if (!stored.aiPriorityAdjust || stored.aiPriorityBasis !== priorityBasis(kind, base)) return base;
  return applyAiAdjustment(base, stored.aiPriorityAdjust, { kind, ...guard }).priority;
}

export interface AiPriorityDecision {
  /** What the model said (−1, 0, 1). */
  suggested: -1 | 0 | 1;
  /** What is stored as applied (null in suggest/off mode or when nothing changes). */
  applied: -1 | 1 | null;
  /** The priority the incident should have now. */
  priority: Priority;
  basis: string;
  guardrail: string | null;
}

export function decideAiPriority(
  mode: AiPriorityMode,
  suggested: -1 | 0 | 1,
  incident: { kind: IncidentKind; basePriority: Priority } & GuardFacts,
): AiPriorityDecision {
  const basis = priorityBasis(incident.kind, incident.basePriority);
  const guarded = applyAiAdjustment(incident.basePriority, suggested, incident);
  if (mode !== 'apply')
    return {
      suggested,
      applied: null,
      priority: incident.basePriority,
      basis,
      guardrail: guarded.guardrail,
    };
  return {
    suggested,
    applied: guarded.adjust === 0 ? null : guarded.adjust,
    priority: guarded.priority,
    basis,
    guardrail: guarded.guardrail,
  };
}
