/**
 * The shapes Claude must answer in. They are sent as JSON-schema structured outputs and checked
 * again with Zod here (length limits and similar constraints are enforced client-side only).
 * AI output may only enrich (titles, summaries, digests) or suggest a ±1 priority step.
 */
import { z } from 'zod';

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const incidentSummaryOutput = z.object({
  title: z
    .string()
    .min(5)
    .max(90)
    .describe(
      'Plain-English incident title in business terms, e.g. "Scales at the Rockford elevator may be offline". No IP addresses.',
    ),
  short: z
    .string()
    .min(10)
    .max(220)
    .describe('One or two sentences for list rows and the NOC wall.'),
  whatIsAffected: z
    .string()
    .min(5)
    .max(600)
    .describe('What is affected for the business: which site, which operations, who notices.'),
  likelyCause: z
    .string()
    .min(5)
    .max(600)
    .describe('The most likely root cause given the evidence, and what points to it.'),
  confidence: z.enum(CONFIDENCE_LEVELS).describe('Confidence in the likely cause.'),
  firstSteps: z
    .array(z.string().min(3).max(240))
    .min(1)
    .max(6)
    .describe('Concrete first troubleshooting steps for this equipment, most useful first.'),
  changes: z
    .string()
    .min(3)
    .max(400)
    .describe(
      'What changed since the previous summary. Exactly "First summary." when there was none.',
    ),
});
export type IncidentSummaryOutput = z.infer<typeof incidentSummaryOutput>;

export const severityOutput = z.object({
  adjust: z
    .union([z.literal(-1), z.literal(0), z.literal(1)])
    .describe('-1 = one level less urgent, 0 = keep, 1 = one level more urgent.'),
  reason: z
    .string()
    .min(5)
    .max(300)
    .describe('One sentence citing the specific evidence for the adjustment (or for keeping it).'),
});
export type SeverityOutput = z.infer<typeof severityOutput>;

export const digestOutput = z.object({
  headline: z.string().min(5).max(160).describe('One line: the most important thing to know.'),
  sections: z
    .array(
      z.object({
        title: z.string().min(2).max(60),
        bullets: z.array(z.string().min(3).max(300)).min(1).max(8),
      }),
    )
    .min(1)
    .max(7),
});
export type DigestContent = z.infer<typeof digestOutput>;

/** What is stored in `incidents.ai_summary` (placeholders already restored). */
export const storedAiSummary = incidentSummaryOutput.extend({
  model: z.string(),
  generatedAt: z.string(),
  /** The incident's material_rev this summary describes. */
  forMaterialRev: z.number().int(),
  redacted: z.boolean(),
});
export type StoredAiSummary = z.infer<typeof storedAiSummary>;

/** Read `incidents.ai_summary` defensively (rows written by older versions, manual edits). */
export function readStoredAiSummary(value: unknown): StoredAiSummary | null {
  const r = storedAiSummary.safeParse(value);
  return r.success ? r.data : null;
}
