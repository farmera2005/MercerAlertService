import { describe, expect, it } from 'vitest';
import { normalizeStatus, orionSeverity } from './orion';
import { parseSwisUri } from './uri';

describe('orion vocab', () => {
  it('normalizes statuses', () => {
    expect([1, 2, 3, 12, 9, 14, 8, 0, 17, 99].map(normalizeStatus)).toEqual([
      'up',
      'down',
      'warning',
      'unreachable',
      'unmanaged',
      'critical',
      'down',
      'unknown',
      'unknown',
      'other',
    ]);
  });
  it('maps severities', () => {
    expect([0, 1, 2, 3, 4].map(orionSeverity)).toEqual([
      'informational',
      'warning',
      'critical',
      'serious',
      'notice',
    ]);
  });
  it('parses SWIS URIs', () => {
    expect(
      parseSwisUri('swis://orion/Orion/Orion.Nodes/NodeID=12/Interfaces/InterfaceID=34'),
    ).toEqual({
      nodeId: 12,
      interfaceId: 34,
    });
    expect(parseSwisUri('swis://orion/Orion/Orion.Groups/ContainerID=7')).toEqual({
      containerId: 7,
    });
    expect(parseSwisUri(null)).toEqual({});
  });
});
