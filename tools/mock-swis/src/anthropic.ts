/**
 * A stand-in for the Anthropic Messages API, for development and tests (never production).
 * Answers MAS's own prompts with deterministic, schema-valid JSON built from the request, reports
 * prompt-cache usage the way the real API does, and can be told to refuse, fail, stall or answer
 * badly. Everything it received is listed at GET /__mock/anthropic.
 *
 * Point MAS at it with ANTHROPIC_BASE_URL=http://mock-swis:17774/__mock/anthropic.
 */

export type FakeAnthropicMode = 'ok' | 'refuse' | 'invalid' | 'error' | 'slow';

export interface FakeAnthropicRecord {
  at: string;
  model: string;
  task: string;
  system: Array<{ text: string; cached: boolean }>;
  user: string;
  maxTokens: number;
  effort: string | null;
  betas: string | null;
  fallbacks: unknown;
  hasSchema: boolean;
}

export interface FakeAnthropicControl {
  mode?: FakeAnthropicMode;
  /** How many requests the mode (or inventIncident) applies to before going back to normal. */
  times?: number;
  /** For mode slow. */
  delayMs?: number;
  /** What the severity check answers. */
  severityAdjust?: -1 | 0 | 1;
  /** Make digests cite an incident that does not exist (tests the citation check). */
  inventIncident?: boolean;
}

export interface FakeAnthropic {
  records: FakeAnthropicRecord[];
  clear(): void;
  control(c: FakeAnthropicControl): void;
  handle(
    method: string,
    path: string,
    headers: Record<string, string | string[] | undefined>,
    raw: string,
  ): Promise<[number, unknown] | null>;
}

const tokens = (s: string) => Math.ceil(s.length / 4);

function between(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return m ? m[1]! : null;
}

function taskOf(task: string): string {
  if (task.includes('write the summary')) return 'summary';
  if (task.includes('second opinion on the priority')) return 'severity';
  if (task.includes('morning')) return 'digest_daily';
  if (task.includes('weekly trends')) return 'digest_weekly';
  return 'other';
}

interface IncidentJson {
  id?: number;
  kind?: string;
  status?: string;
  templateTitle?: string;
  site?: { name?: string } | null;
  rootNode?: { caption?: string; role?: string } | null;
  alerts?: Array<{ message?: string | null }>;
  alertCount?: number;
}

function summaryAnswer(user: string): Record<string, unknown> {
  const inc = JSON.parse(between(user, 'incident') ?? '{}') as IncidentJson;
  const site = inc.site?.name ?? 'an unknown site';
  const root = inc.rootNode?.caption ?? 'a device';
  const placeholder = /\[(?:IP|MAC|SERIAL)-\d+\]/.exec(user)?.[0];
  const outage = inc.kind === 'site_outage';
  const resolved = inc.status === 'resolved' || inc.status === 'closed';
  return {
    title: (outage
      ? `${site} offline: WAN circuit or firewall down`
      : `${inc.templateTitle ?? 'Network problem'} (reviewed)`
    ).slice(0, 90),
    short: `${resolved ? 'Was' : 'Is'} affecting ${site}; ${inc.alertCount ?? 0} alerts point at ${root}.`,
    whatIsAffected: `Everything at ${site} that depends on ${root}, including the scale house during harvest.`,
    likelyCause: `${root} stopped responding first${placeholder ? ` (address ${placeholder})` : ''}; the other alerts follow from it.`,
    confidence: outage ? 'medium' : 'low',
    firstSteps: [
      `Check the ISP circuit status for ${site}`,
      `Log in to ${root} from a jump host and check its WAN interface`,
      'Call the site and ask whether power and the UPS are on',
    ],
    changes: user.includes('<previous>')
      ? 'Cause revised after more alerts arrived.'
      : 'First summary.',
  };
}

function digestAnswer(user: string, invent: boolean, weekly: boolean): Record<string, unknown> {
  const facts = JSON.parse(between(user, 'facts') ?? '{}') as {
    overnight?: Array<{ id: number; title: string; priority: string }>;
    repeatOffenders?: Array<{ subject: string; incidents: number; incidentIds: number[] }>;
  };
  const bullets = weekly
    ? (facts.repeatOffenders ?? []).map(
        (r) => `${r.subject} had ${r.incidents} incidents (INC-${r.incidentIds[0]}).`,
      )
    : (facts.overnight ?? []).map((i) => `INC-${i.id} ${i.priority} ${i.title}.`);
  if (invent) bullets.push('INC-999999 was invented by the fake model.');
  return {
    headline: weekly ? 'Weekly trends from the fake model.' : 'Morning digest from the fake model.',
    sections: [
      {
        title: weekly ? 'Repeat offenders' : 'Overnight',
        bullets: bullets.length ? bullets.slice(0, 8) : ['Nothing to report.'],
      },
    ],
  };
}

export function createFakeAnthropic(): FakeAnthropic {
  const records: FakeAnthropicRecord[] = [];
  const cache = new Set<string>();
  let ctl: Required<Omit<FakeAnthropicControl, 'times'>> & { times: number } = {
    mode: 'ok',
    times: Infinity,
    delayMs: 0,
    severityAdjust: 0,
    inventIncident: false,
  };
  let seq = 0;
  const header = (h: Record<string, string | string[] | undefined>, k: string) => {
    const v = h[k];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  };

  return {
    records,
    clear() {
      records.length = 0;
      cache.clear();
      ctl = { mode: 'ok', times: Infinity, delayMs: 0, severityAdjust: 0, inventIncident: false };
    },
    control(c) {
      ctl = {
        ...ctl,
        ...c,
        times: c.times ?? Infinity,
        mode: c.mode ?? ctl.mode,
      } as typeof ctl;
    },
    async handle(method, path, headers, raw) {
      if (path === 'anthropic' && method === 'GET') return [200, { records }];
      if (path === 'anthropic' && method === 'DELETE') {
        this.clear();
        return [200, { ok: true }];
      }
      if (path === 'anthropic/control' && method === 'POST') {
        this.control(JSON.parse(raw || '{}') as FakeAnthropicControl);
        return [200, { ok: true }];
      }
      if (path !== 'anthropic/v1/messages' || method !== 'POST') return null;
      const auth = header(headers, 'x-api-key') ?? header(headers, 'authorization');
      if (!auth || /^Bearer\s*$/i.test(auth))
        return [
          401,
          { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        ];
      const body = JSON.parse(raw || '{}') as {
        model: string;
        max_tokens: number;
        system?: Array<{ text: string; cache_control?: unknown }>;
        messages: Array<{ content: string | Array<{ type: string; text?: string }> }>;
        output_config?: { effort?: string; format?: unknown };
        fallbacks?: unknown;
      };
      const system = (body.system ?? []).map((b) => ({ text: b.text, cached: !!b.cache_control }));
      const content = body.messages[0]?.content ?? '';
      const user =
        typeof content === 'string'
          ? content
          : content
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n');
      const taskText = system.map((s) => s.text).join('\n');
      const task = taskOf(taskText);
      records.push({
        at: new Date().toISOString(),
        model: body.model,
        task,
        system,
        user,
        maxTokens: body.max_tokens,
        effort: body.output_config?.effort ?? null,
        betas: header(headers, 'anthropic-beta'),
        fallbacks: body.fallbacks ?? null,
        hasSchema: !!body.output_config?.format,
      });

      // `times` counts down whatever is injected (a mode or invented citations).
      const injected = ctl.times > 0 && (ctl.mode !== 'ok' || ctl.inventIncident);
      const mode = injected ? ctl.mode : 'ok';
      const invent = injected && ctl.inventIncident;
      if (injected) ctl.times--;
      if (mode === 'error')
        return [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }];
      if (mode === 'slow') await new Promise((r) => setTimeout(r, ctl.delayMs || 5_000));

      const stable = system.find((s) => s.cached)?.text ?? '';
      const key = `${body.model}\n${stable}`;
      const hit = !!stable && cache.has(key);
      if (stable) cache.add(key);
      const answer =
        mode === 'invalid'
          ? 'Sorry, here is some prose instead of JSON.'
          : mode === 'refuse'
            ? ''
            : JSON.stringify(
                task === 'summary'
                  ? summaryAnswer(user)
                  : task === 'severity'
                    ? {
                        adjust: ctl.severityAdjust,
                        reason:
                          ctl.severityAdjust === 0
                            ? 'The score matches the evidence.'
                            : 'The fake model was told to adjust.',
                      }
                    : task === 'digest_daily' || task === 'digest_weekly'
                      ? digestAnswer(user, invent, task === 'digest_weekly')
                      : { reply: 'OK' },
              );
      seq++;
      return [
        200,
        {
          id: `msg_fake_${seq}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content:
            mode === 'refuse'
              ? []
              : [
                  { type: 'thinking', thinking: '', signature: 'fake' },
                  { type: 'text', text: answer },
                ],
          stop_reason: mode === 'refuse' ? 'refusal' : 'end_turn',
          stop_sequence: null,
          stop_details:
            mode === 'refuse'
              ? { type: 'refusal', category: null, explanation: 'The fake model declined.' }
              : null,
          usage: {
            input_tokens: tokens(user) + tokens(taskText) - (stable ? tokens(stable) : 0),
            output_tokens: tokens(answer) + 40,
            cache_read_input_tokens: hit ? tokens(stable) : 0,
            cache_creation_input_tokens: stable && !hit ? tokens(stable) : 0,
          },
        },
      ];
    },
  };
}
