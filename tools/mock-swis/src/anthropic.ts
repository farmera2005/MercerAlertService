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
  /** Tools the fake calls, in order, before answering an "Ask the network" question. */
  chatPlan?: Array<{ name: string; input: unknown }>;
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
  ): Promise<[number, unknown, string?] | null>;
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
  if (task.includes('Ask the network')) return 'chat';
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

type ChatBlock = {
  type: string;
  text?: string;
  content?: string | Array<{ type: string; text?: string }>;
  name?: string;
};

function blocksText(content: string | ChatBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) =>
      b.type === 'text'
        ? (b.text ?? '')
        : b.type === 'tool_result'
          ? typeof b.content === 'string'
            ? b.content
            : (b.content ?? []).map((c) => c.text ?? '').join('')
          : '',
    )
    .join('\n');
}

/**
 * "Ask the network": call the planned tools one per request, then answer from what they
 * returned, citing the first incident, device and site refs found (like a careful model would).
 */
function chatReply(
  messages: Array<{ role: string; content: string | ChatBlock[] }>,
  plan: Array<{ name: string; input: unknown }>,
  invent: boolean,
  seq: number,
): { content: unknown[]; stopReason: string } {
  let q = messages.length - 1;
  while (
    q > 0 &&
    !(
      messages[q]!.role === 'user' &&
      (typeof messages[q]!.content === 'string' ||
        (messages[q]!.content as ChatBlock[]).some((b) => b.type === 'text'))
    )
  )
    q--;
  const after = messages.slice(q + 1);
  const results = after
    .filter((m) => m.role === 'user')
    .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
    .filter((b) => b.type === 'tool_result');
  if (results.length < plan.length) {
    const step = plan[results.length]!;
    return {
      content: [{ type: 'tool_use', id: `toolu_fake_${seq}`, name: step.name, input: step.input }],
      stopReason: 'tool_use',
    };
  }
  const seen = after.map((m) => blocksText(m.content)).join('\n');
  const first = (re: RegExp) => re.exec(seen)?.[1];
  const inc = first(/"(INC-\d+)"/);
  const node = first(/"(NODE-\d+)"/);
  const site = first(/"(SITE-[A-Z0-9_-]+)"/);
  const ph = /\[(?:IP|MAC|SERIAL)-\d+\]/.exec(seen)?.[0];
  const parts = [
    inc ? `The most important open item is [${inc}].` : 'Nothing matches in the monitoring data.',
    node ? `- The device involved is [${node}].` : '',
    site ? `- It is at [${site}].` : '',
    ph ? `- Its address shows as ${ph} in the data.` : '',
    invent ? '- Also see [INC-999999].' : '',
  ].filter(Boolean);
  return { content: [{ type: 'text', text: parts.join('\n') }], stopReason: 'end_turn' };
}

/** The message as a Messages API event stream (text and tool input in small deltas). */
function sse(
  message: { content: unknown[]; usage: { output_tokens: number } } & Record<string, unknown>,
): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const chunks = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) ?? [];
  let out = ev('message_start', {
    type: 'message_start',
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { ...message.usage, output_tokens: 1 },
    },
  });
  message.content.forEach((raw, index) => {
    const b = raw as { type: string; text?: string; input?: unknown; signature?: string };
    if (b.type === 'text') {
      out += ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      for (const c of chunks(b.text ?? '', 7))
        out += ev('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: c },
        });
    } else if (b.type === 'tool_use') {
      out += ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { ...b, input: {} },
      });
      for (const c of chunks(JSON.stringify(b.input ?? {}), 9))
        out += ev('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: c },
        });
    } else if (b.type === 'thinking') {
      out += ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      out += ev('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: b.signature ?? 'fake' },
      });
    }
    out += ev('content_block_stop', { type: 'content_block_stop', index });
  });
  out += ev('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
      stop_details: message.stop_details ?? null,
    },
    usage: { output_tokens: message.usage.output_tokens },
  });
  out += ev('message_stop', { type: 'message_stop' });
  return out;
}

export function createFakeAnthropic(): FakeAnthropic {
  const records: FakeAnthropicRecord[] = [];
  const cache = new Set<string>();
  const DEFAULT_PLAN = [{ name: 'get_network_status', input: { division: null } }];
  let ctl: Required<Omit<FakeAnthropicControl, 'times'>> & { times: number } = {
    mode: 'ok',
    times: Infinity,
    delayMs: 0,
    severityAdjust: 0,
    inventIncident: false,
    chatPlan: DEFAULT_PLAN,
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
      ctl = {
        mode: 'ok',
        times: Infinity,
        delayMs: 0,
        severityAdjust: 0,
        inventIncident: false,
        chatPlan: DEFAULT_PLAN,
      };
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
        messages: Array<{ role: string; content: string | ChatBlock[] }>;
        output_config?: { effort?: string; format?: unknown };
        fallbacks?: unknown;
        stream?: boolean;
        tools?: Array<{ name: string }>;
      };
      const system = (body.system ?? []).map((b) => ({ text: b.text, cached: !!b.cache_control }));
      // Everything the model would read in the conversation (questions and tool results).
      const user = body.messages
        .filter((m) => m.role === 'user')
        .map((m) => blocksText(m.content))
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
      seq++;
      let content: unknown[];
      let stopReason = 'end_turn';
      if (mode === 'refuse') {
        content = [];
        stopReason = 'refusal';
      } else if (task === 'chat') {
        const r = chatReply(body.messages, ctl.chatPlan, invent, seq);
        content = [{ type: 'thinking', thinking: '', signature: 'fake' }, ...r.content];
        stopReason = r.stopReason;
      } else {
        const answer =
          mode === 'invalid'
            ? 'Sorry, here is some prose instead of JSON.'
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
        content = [
          { type: 'thinking', thinking: '', signature: 'fake' },
          { type: 'text', text: answer },
        ];
      }
      const outText = JSON.stringify(content);
      const message = {
        id: `msg_fake_${seq}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details:
          mode === 'refuse'
            ? { type: 'refusal', category: null, explanation: 'The fake model declined.' }
            : null,
        usage: {
          input_tokens: Math.max(
            1,
            tokens(user) + tokens(taskText) - (stable ? tokens(stable) : 0),
          ),
          output_tokens: tokens(outText) + 40,
          cache_read_input_tokens: hit ? tokens(stable) : 0,
          cache_creation_input_tokens: stable && !hit ? tokens(stable) : 0,
        },
      };
      if (body.stream) return [200, sse(message), 'text/event-stream'];
      return [200, message];
    },
  };
}
