import { describe, expect, it } from 'vitest';
import { buildIncrementalQuery, buildPagedQuery } from './query-builder';
import { ACTIVE_ALERTS, EVENTS, NODES } from './queries';

describe('query builder', () => {
  it('builds paged SWQL with explicit aliases', () => {
    const { build } = buildPagedQuery(ACTIVE_ALERTS, null);
    const q = build(1001, 2000);
    expect(q).toMatch(/^SELECT aa\.AlertActiveID AS AlertActiveID, /);
    expect(q).toContain('ac.Name AS AlertName');
    expect(q).toMatch(/ORDER BY aa\.AlertActiveID WITH ROWS 1001 TO 2000$/);
  });
  it('appends the custom-property join only with extras', () => {
    expect(buildPagedQuery(NODES, null).build(1, 10)).not.toContain('NodesCustomProperties');
    expect(buildPagedQuery(NODES, null, ['cp.Site AS CP_Site']).build(1, 10)).toContain(
      'LEFT JOIN Orion.NodesCustomProperties cp ON cp.NodeID = n.NodeID',
    );
  });
  it('builds incremental queries bound to @cursor', () => {
    expect(buildIncrementalQuery(EVENTS, null).build(500)).toMatch(
      /WHERE e\.EventID > @cursor ORDER BY e\.EventID WITH ROWS 1 TO 500$/,
    );
  });
  it('rejects bad paging ranges', () => {
    expect(() => buildPagedQuery(NODES, null).build(0, 10)).toThrow();
  });
});
