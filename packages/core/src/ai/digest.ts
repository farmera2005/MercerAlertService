/**
 * Daily digest and weekly trends. The facts are computed deterministically from the database;
 * Claude only turns them into readable bullets. When AI is off, over budget, slow or wrong, the
 * template below renders the same facts. Numbers on the card (the fact table) always come from
 * the facts, never from the model.
 */
import type { Priority } from '../correlation/types';
import { teamsNotice, type TeamsPayload } from '../notify/messages';
import type { DigestContent } from './schemas';

export type DigestKind = 'daily' | 'weekly';

export interface DigestIncident {
  id: number;
  title: string;
  priority: Priority;
  status: string;
  site: string | null;
  openedAt: string;
  durationMin: number | null;
  alertCount: number;
  acknowledgedBy: string | null;
}

export interface NoiseFacts {
  rawAlerts: number;
  incidents: number;
  ratio: number | null;
  teamsPosts: number;
  pages: number;
  suppressed: number;
}

export interface DailyFacts {
  kind: 'daily';
  timeZone: string;
  periodStart: string;
  periodEnd: string;
  inHarvest: boolean;
  overnight: DigestIncident[];
  stillOpen: DigestIncident[];
  flapping: Array<{ node: string; site: string | null; changes: number }>;
  busiestLinks: Array<{
    node: string;
    interface: string;
    site: string | null;
    peakUtilPct: number;
    avgUtilPct: number;
  }>;
  /** Devices or sites with several incidents in the last 7 days. */
  recurring: Array<{ subject: string; site: string | null; incidents: number; lastId: number }>;
  noise: NoiseFacts;
}

export interface WeeklyFacts {
  kind: 'weekly';
  timeZone: string;
  periodStart: string;
  periodEnd: string;
  totals: {
    incidents: number;
    p1: number;
    p2: number;
    medianAckMin: number | null;
    medianResolveMin: number | null;
  };
  repeatOffenders: Array<{
    subject: string;
    site: string | null;
    incidents: number;
    downMinutes: number;
    incidentIds: number[];
  }>;
  worseningSites: Array<{
    site: string;
    incidents: number;
    previousIncidents: number;
    downMinutes: number;
    previousDownMinutes: number;
  }>;
  capacity: Array<{
    node: string;
    interface: string;
    site: string | null;
    p95UtilPct: number;
    peakUtilPct: number;
    daysOver80: number;
  }>;
  /** Orion alert definitions that look misconfigured. */
  noisyRules: Array<{
    alertName: string;
    raises: number;
    shortLivedPct: number;
    medianDurationMin: number | null;
    inIncidents: number;
    reasons: string[];
  }>;
  noise: NoiseFacts;
  previousNoise: NoiseFacts;
}

export type DigestFacts = DailyFacts | WeeklyFacts;

/** Every INC-<id> a digest may cite. */
export function citableIncidentIds(f: DigestFacts): Set<number> {
  const ids = new Set<number>();
  if (f.kind === 'daily') {
    for (const i of [...f.overnight, ...f.stillOpen]) ids.add(i.id);
    for (const r of f.recurring) ids.add(r.lastId);
  } else {
    for (const r of f.repeatOffenders) for (const id of r.incidentIds) ids.add(id);
  }
  return ids;
}

/** The incident ids a digest cites that are not in its facts (a hallucination check). */
export function unknownCitations(content: DigestContent, facts: DigestFacts): number[] {
  const known = citableIncidentIds(facts);
  const bad = new Set<number>();
  const scan = (t: string) => {
    for (const m of t.matchAll(/\bINC-(\d+)\b/g))
      if (!known.has(Number(m[1]))) bad.add(Number(m[1]));
  };
  scan(content.headline);
  for (const s of content.sections) for (const b of s.bullets) scan(b);
  return [...bad].sort((a, b) => a - b);
}

const PRIO_ORDER: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
const byUrgency = (a: DigestIncident, b: DigestIncident) =>
  PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority] || a.id - b.id;

function incidentLine(i: DigestIncident): string {
  const where = i.site && !i.title.includes(i.site) ? ` (${i.site})` : '';
  const dur =
    i.durationMin === null
      ? i.status === 'acknowledged'
        ? `, acknowledged by ${i.acknowledgedBy ?? 'someone'}`
        : ', not acknowledged'
      : `, ${i.durationMin} min`;
  return `INC-${i.id} ${i.priority} ${i.title}${where}: opened ${i.openedAt}${dur}`;
}

function noiseLine(n: NoiseFacts): string {
  return n.ratio === null
    ? `${n.rawAlerts} raw alerts, no incidents opened.`
    : `${n.rawAlerts} raw alerts became ${n.incidents} incidents (noise ratio ${n.ratio}:1). ${n.teamsPosts} Teams posts, ${n.pages} pages, ${n.suppressed} suppressed.`;
}

function section(title: string, bullets: string[], max = 6) {
  if (bullets.length === 0) return [];
  const shown = bullets.slice(0, max);
  if (bullets.length > max) shown[max - 1] = `…and ${bullets.length - max + 1} more`;
  return [{ title, bullets: shown }];
}

/** The deterministic digest (used when AI is unavailable, and as the reference in tests). */
export function templateDigest(f: DigestFacts): DigestContent {
  if (f.kind === 'daily') {
    const openP1 = f.stillOpen.filter((i) => i.priority === 'P1');
    const headline = openP1.length
      ? `${openP1.length} P1 incident${openP1.length > 1 ? 's' : ''} still open: ${openP1
          .slice(0, 2)
          .map((i) => `INC-${i.id} ${i.title}`)
          .join('; ')}`
      : f.overnight.length === 0
        ? 'Quiet night: no new incidents.'
        : `${f.overnight.length} new incident${f.overnight.length > 1 ? 's' : ''} overnight, ${f.stillOpen.length} still open.`;
    const sections = [
      ...section('Overnight', [...f.overnight].sort(byUrgency).map(incidentLine)),
      ...section('Still open', [...f.stillOpen].sort(byUrgency).map(incidentLine)),
      ...section(
        'Flapping',
        f.flapping.map(
          (x) => `${x.node}${x.site ? ` (${x.site})` : ''}: ${x.changes} state changes`,
        ),
      ),
      ...section(
        'Busiest links',
        f.busiestLinks.map(
          (x) =>
            `${x.node} ${x.interface}${x.site ? ` (${x.site})` : ''}: peak ${x.peakUtilPct}%, average ${x.avgUtilPct}%`,
        ),
      ),
      ...section(
        'Recurring',
        f.recurring.map(
          (x) =>
            `${x.subject}${x.site && x.site !== x.subject ? ` (${x.site})` : ''}: ${x.incidents} incidents in 7 days, latest INC-${x.lastId}`,
        ),
      ),
      { title: 'Noise', bullets: [noiseLine(f.noise)] },
    ];
    return { headline: headline.slice(0, 160), sections };
  }
  const t = f.totals;
  const headline =
    f.worseningSites[0] !== undefined
      ? `${f.worseningSites[0].site} is getting worse: ${f.worseningSites[0].incidents} incidents this week vs ${f.worseningSites[0].previousIncidents} last week.`
      : `${t.incidents} incidents this week (${t.p1} P1, ${t.p2} P2).`;
  const sections = [
    ...section(
      'Repeat offenders',
      f.repeatOffenders.map(
        (x) =>
          `${x.subject}${x.site && x.site !== x.subject ? ` (${x.site})` : ''}: ${x.incidents} incidents, ${x.downMinutes} min down (${x.incidentIds
            .slice(0, 3)
            .map((id) => `INC-${id}`)
            .join(', ')})`,
      ),
    ),
    ...section(
      'Getting worse',
      f.worseningSites.map(
        (x) =>
          `${x.site}: ${x.incidents} incidents (was ${x.previousIncidents}), ${x.downMinutes} min down (was ${x.previousDownMinutes})`,
      ),
    ),
    ...section(
      'Capacity',
      f.capacity.map(
        (x) =>
          `${x.node} ${x.interface}${x.site ? ` (${x.site})` : ''}: 95th percentile ${x.p95UtilPct}%, peak ${x.peakUtilPct}%, over 80% on ${x.daysOver80} day${x.daysOver80 === 1 ? '' : 's'}`,
      ),
    ),
    ...section(
      'Orion rules to review',
      f.noisyRules.map((x) => `"${x.alertName}": ${x.raises} raises; ${x.reasons.join('; ')}`),
    ),
    {
      title: 'Noise',
      bullets: [`This week: ${noiseLine(f.noise)}`, `Last week: ${noiseLine(f.previousNoise)}`],
    },
  ];
  return { headline: headline.slice(0, 160), sections };
}

export function digestTitle(f: DigestFacts): string {
  return f.kind === 'daily'
    ? `Network digest · ${f.periodEnd.slice(0, 10)}`
    : `Weekly network trends · ${f.periodStart.slice(0, 10)} to ${f.periodEnd.slice(0, 10)}`;
}

/** Fact table shown under the narrative; always deterministic. */
export function digestFactRows(f: DigestFacts): Array<{ title: string; value: string }> {
  if (f.kind === 'daily')
    return [
      { title: 'Period', value: `${f.periodStart} to ${f.periodEnd}` },
      { title: 'New incidents', value: String(f.overnight.length) },
      { title: 'Still open', value: String(f.stillOpen.length) },
      {
        title: 'Noise ratio',
        value:
          f.noise.ratio === null
            ? '—'
            : `${f.noise.ratio}:1 (${f.noise.rawAlerts} alerts → ${f.noise.incidents})`,
      },
      { title: 'Pages sent', value: String(f.noise.pages) },
    ];
  return [
    { title: 'Week', value: `${f.periodStart} to ${f.periodEnd}` },
    { title: 'Incidents', value: `${f.totals.incidents} (${f.totals.p1} P1, ${f.totals.p2} P2)` },
    {
      title: 'Median time to acknowledge',
      value: f.totals.medianAckMin === null ? '—' : `${f.totals.medianAckMin} min`,
    },
    {
      title: 'Median time to resolve',
      value: f.totals.medianResolveMin === null ? '—' : `${f.totals.medianResolveMin} min`,
    },
    {
      title: 'Noise ratio',
      value: `${f.noise.ratio ?? '—'}:1 (last week ${f.previousNoise.ratio ?? '—'}:1)`,
    },
  ];
}

export function digestMarkdown(
  content: DigestContent,
  facts: DigestFacts,
  source: 'ai' | 'template',
): string {
  const lines = [`# ${digestTitle(facts)}`, '', `**${content.headline}**`, ''];
  for (const s of content.sections) {
    lines.push(`## ${s.title}`, '');
    for (const b of s.bullets) lines.push(`- ${b}`);
    lines.push('');
  }
  lines.push('| | |', '|---|---|');
  for (const r of digestFactRows(facts)) lines.push(`| ${r.title} | ${r.value} |`);
  lines.push(
    '',
    source === 'ai'
      ? '_Written by Claude from MAS data; the table is computed by MAS._'
      : '_Generated from a template (AI was not used)._',
  );
  return lines.join('\n');
}

export function digestCard(
  content: DigestContent,
  facts: DigestFacts,
  source: 'ai' | 'template',
  url: string,
): TeamsPayload {
  const card = teamsNotice(digestTitle(facts), content.headline, url);
  const body = card.attachments[0]!.content.body;
  for (const s of content.sections) {
    body.push({ type: 'TextBlock', text: `**${s.title}**`, wrap: true, spacing: 'Medium' });
    body.push({ type: 'TextBlock', text: s.bullets.map((b) => `- ${b}`).join('\n'), wrap: true });
  }
  body.push({ type: 'FactSet', facts: digestFactRows(facts), spacing: 'Medium' });
  body.push({
    type: 'TextBlock',
    text: source === 'ai' ? 'Written by Claude from MAS data.' : 'Generated from a template.',
    size: 'Small',
    isSubtle: true,
    wrap: true,
  });
  return card;
}
