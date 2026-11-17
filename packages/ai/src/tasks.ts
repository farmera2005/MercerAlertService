/**
 * The AI tasks: incident summary, priority second opinion, digests and a connection test. Each
 * returns either the validated answer or a reason the caller falls back to its template.
 */
import { z } from 'zod';
import {
  digestOutput,
  digestPrompt,
  incidentSummaryOutput,
  incidentSummaryPrompt,
  contextKeepWords,
  Redactor,
  severityOutput,
  severityPrompt,
  unknownCitations,
  type AppConfig,
  type DigestContent,
  type DigestFacts,
  type IncidentContext,
  type IncidentSummaryOutput,
  type PreviousSummary,
  type SeverityOutput,
} from '@mercer/core';
import type { AiRunner, CallOutcome } from './runner';

export interface IncidentAiInput {
  incidentId: number;
  context: IncidentContext;
  previous: PreviousSummary | null;
  /** The cached prompt prefix (role, environment, site profiles). */
  prefix: string;
}

/** Plain-English summary on the strong model. */
export function summarizeIncident(
  runner: AiRunner,
  cfg: AppConfig['ai'],
  i: IncidentAiInput,
): Promise<CallOutcome<IncidentSummaryOutput>> {
  return runner.call({
    purpose: 'summary',
    model: cfg.models.summary,
    effort: 'medium',
    maxTokens: 8000,
    prompt: incidentSummaryPrompt(i.prefix, i.context, i.previous),
    schema: incidentSummaryOutput,
    redactor: new Redactor(cfg.redact, contextKeepWords(i.context)),
    incidentId: i.incidentId,
  });
}

/** ±1 priority second opinion on the fast model; guardrails are applied by the caller. */
export function suggestPriority(
  runner: AiRunner,
  cfg: AppConfig['ai'],
  i: IncidentAiInput,
): Promise<CallOutcome<SeverityOutput>> {
  return runner.call({
    purpose: 'severity',
    model: cfg.models.severity,
    effort: 'low',
    maxTokens: 4000,
    prompt: severityPrompt(i.prefix, i.context),
    schema: severityOutput,
    redactor: new Redactor(cfg.redact, contextKeepWords(i.context)),
    incidentId: i.incidentId,
  });
}

/** Narrative for a digest. Rejected (and retried once) if it cites an incident not in the facts. */
export function writeDigest(
  runner: AiRunner,
  cfg: AppConfig['ai'],
  prefix: string,
  facts: DigestFacts,
): Promise<CallOutcome<DigestContent>> {
  return runner.call({
    purpose: facts.kind === 'daily' ? 'digest_daily' : 'digest_weekly',
    model: cfg.models.digest,
    effort: 'medium',
    maxTokens: 12000,
    prompt: digestPrompt(prefix, facts.kind, facts),
    schema: digestOutput,
    redactor: new Redactor(cfg.redact),
    timeoutMs: cfg.timeoutMs * 2,
    check: (d) => {
      const bad = unknownCitations(d, facts);
      return bad.length
        ? `it cites ${bad.map((id) => `INC-${id}`).join(', ')}, which ${bad.length > 1 ? 'are' : 'is'} not in <facts>`
        : null;
    },
  });
}

const testOutput = z.object({ reply: z.string().max(40) });

/** Settings → AI → Test: a tiny call that proves the key, network path and model work. */
export function testAi(
  runner: AiRunner,
  cfg: AppConfig['ai'],
  model: string,
): Promise<CallOutcome<z.infer<typeof testOutput>>> {
  return runner.call({
    purpose: 'test',
    model,
    effort: 'low',
    maxTokens: 2000,
    prompt: {
      stable: 'You are a connectivity check for MercerAlertService.',
      task: 'Reply with {"reply": "OK"}.',
      user: 'Connection test.',
    },
    schema: testOutput,
    redactor: new Redactor(cfg.redact),
  });
}
