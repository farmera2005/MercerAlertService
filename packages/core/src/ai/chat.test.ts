import { describe, expect, it } from 'vitest';
import {
  CHAT_TOOL_INPUTS,
  clampToolOutput,
  describeToolCall,
  extractCitations,
  refsInToolOutput,
} from './chat';
import { Redactor } from './redact';

describe('chat tool inputs', () => {
  it('accept complete inputs and reject extra or out-of-range fields', () => {
    const s = CHAT_TOOL_INPUTS.search_incidents;
    expect(
      s.safeParse({
        text: 'Rockford',
        status: 'active',
        priorities: ['P1'],
        site: null,
        since_hours: 24,
        limit: 10,
      }).success,
    ).toBe(true);
    expect(
      s.safeParse({
        text: null,
        status: 'active',
        priorities: [],
        site: null,
        since_hours: null,
        limit: 500,
      }).success,
    ).toBe(false);
    expect(CHAT_TOOL_INPUTS.get_incident.safeParse({ incident_id: 4, sql: 'drop' }).success).toBe(
      false,
    );
  });

  it('describe a call for the progress steps', () => {
    expect(
      describeToolCall('search_incidents', {
        text: 'Rockford',
        status: 'active',
        priorities: [],
        site: null,
        since_hours: null,
        limit: 10,
      }),
    ).toBe('Searching incidents (text: Rockford · status: active · limit: 10)');
    expect(describeToolCall('get_network_status', { division: null })).toBe(
      'Checking network status',
    );
  });
});

describe('citations', () => {
  const seen = refsInToolOutput(
    JSON.stringify([
      { ref: 'INC-42', title: 'Site down' },
      { ref: 'NODE-1001', caption: 'ROCK-FW01' },
      { ref: 'SITE-ROCK' },
    ]),
  );

  it('extracts refs in order and marks the ones no tool returned', () => {
    const c = extractCitations(
      'Rockford is down [INC-42] because [NODE-1001] stopped; see [SITE-rock]. Also [INC-7]. Again [INC-42].',
      seen,
    );
    expect(c.map((x) => [x.ref, x.kind, x.key, x.verified])).toEqual([
      ['INC-42', 'incident', '42', true],
      ['NODE-1001', 'node', '1001', true],
      ['SITE-ROCK', 'site', 'ROCK', true],
      ['INC-7', 'incident', '7', false],
    ]);
  });

  it('clamps long tool output with a note', () => {
    const out = clampToolOutput('x'.repeat(50), 20);
    expect(out).toContain('[truncated: 30 more characters');
  });
});

describe('Redactor state', () => {
  it('continues the numbering of an earlier turn', () => {
    const a = new Redactor();
    expect(a.redact('10.0.0.1 and 10.0.0.2')).toBe('[IP-1] and [IP-2]');
    const b = new Redactor().importState(a.exportState());
    expect(b.redact('10.0.0.2 then 10.0.0.3')).toBe('[IP-2] then [IP-3]');
    expect(b.restore('[IP-1] [IP-3]')).toBe('10.0.0.1 10.0.0.3');
  });
});
