import { describe, expect, it } from 'vitest';
import { decideAiPriority, effectivePriority, priorityBasis } from './priority';

const guard = { firewallDown: false, harvestCriticalInHarvest: false };

describe('decideAiPriority', () => {
  it('applies a ±1 step in apply mode and records the basis', () => {
    const d = decideAiPriority('apply', 1, { kind: 'device_down', basePriority: 'P3', ...guard });
    expect(d).toMatchObject({ applied: 1, priority: 'P2', basis: 'device_down/P3' });
  });

  it('only shows the suggestion in suggest mode', () => {
    const d = decideAiPriority('suggest', -1, {
      kind: 'device_down',
      basePriority: 'P3',
      ...guard,
    });
    expect(d).toMatchObject({ suggested: -1, applied: null, priority: 'P3' });
  });

  it('keeps the guardrails: a site outage never drops below P2', () => {
    const d = decideAiPriority('apply', -1, { kind: 'site_outage', basePriority: 'P2', ...guard });
    expect(d.priority).toBe('P2');
    expect(d.applied).toBeNull();
    expect(d.guardrail).toContain('below P2');
  });
});

describe('effectivePriority', () => {
  const stored = { aiPriorityAdjust: -1, aiPriorityBasis: priorityBasis('device_down', 'P3') };

  it('re-applies the stored step while the basis holds', () => {
    expect(effectivePriority('P3', 'device_down', stored, guard)).toBe('P4');
  });

  it('drops it when the score or the kind changed', () => {
    expect(effectivePriority('P2', 'device_down', stored, guard)).toBe('P2');
    expect(effectivePriority('P3', 'interface', stored, guard)).toBe('P3');
  });

  it('re-checks guardrails, e.g. when the firewall is now down', () => {
    expect(
      effectivePriority(
        'P2',
        'device_down',
        { aiPriorityAdjust: -1, aiPriorityBasis: 'device_down/P2' },
        { firewallDown: true, harvestCriticalInHarvest: false },
      ),
    ).toBe('P2');
  });
});
