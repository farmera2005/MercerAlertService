/** Display text shared by the dashboard and the wall. */

export interface IncidentText {
  title: string;
  aiTitle: string | null;
  templateSummary: string;
  aiSummary: unknown;
}

export function displayTitle(i: Pick<IncidentText, 'title' | 'aiTitle'>): string {
  return i.aiTitle?.trim() || i.title;
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g;
// Full form, or compressed with "::" (at least one hex digit); never a clock time like 10:30.
const IPV6 =
  /(?<![\w:])(?=[0-9a-f:]*[0-9a-f])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{0,4}::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{0,4})(?![\w:])/gi;
const MAC = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi;

/** Fresh copies of the address patterns (global regexes carry state, so never share one). */
export const addressPatterns = () => ({
  ipv4: new RegExp(IPV4.source, IPV4.flags),
  ipv6: new RegExp(IPV6.source, IPV6.flags),
  mac: new RegExp(MAC.source, MAC.flags),
});

/** The wall is visible to anyone in the room, so addresses never reach it. */
export function stripAddresses(text: string): string {
  return text.replace(MAC, '[address]').replace(IPV4, '[address]').replace(IPV6, '[address]');
}

function firstSentences(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const parts = clean.match(/[^.!?]+[.!?]+/g) ?? [clean];
  let out = '';
  for (const p of parts) {
    if ((out + p).trim().length > max) break;
    out += p;
  }
  out = out.trim();
  return out || `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One or two sentences for the wall and list rows: the AI "short" summary when there is one
 * (Milestone 5), otherwise the start of the templated summary.
 */
export function shortSummary(
  i: Pick<IncidentText, 'templateSummary' | 'aiSummary'>,
  max = 180,
): string {
  const ai =
    i.aiSummary && typeof i.aiSummary === 'object' && 'short' in i.aiSummary
      ? (i.aiSummary as { short?: unknown }).short
      : null;
  const text = typeof ai === 'string' && ai.trim() ? ai : i.templateSummary;
  return firstSentences(text, max);
}

export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}
