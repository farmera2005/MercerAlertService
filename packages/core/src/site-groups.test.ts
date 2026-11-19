import { describe, expect, it } from 'vitest';
import { buildSiteResolutionContext, resolveNodeSite } from './mapping';
import {
  nodeSiteGroups,
  planSiteGroupLinks,
  selectSiteGroups,
  siteGroupsEnabled,
  type GroupMemberRef,
  type GroupRef,
} from './site-groups';

const groups: GroupRef[] = [
  { containerId: 1, name: 'Locations' },
  { containerId: 2, name: 'Rockford Elevator' },
  { containerId: 3, name: 'Celina HQ' },
  { containerId: 4, name: 'Rockford Scales' },
  { containerId: 5, name: 'All FortiGates' },
  { containerId: 6, name: 'Site - Coldwater' },
  { containerId: 7, name: 'Site - St. Henry' },
];
const node = (containerId: number, nodeId: number): GroupMemberRef => ({
  containerId,
  nodeId,
  memberContainerId: null,
});
const sub = (containerId: number, child: number): GroupMemberRef => ({
  containerId,
  nodeId: null,
  memberContainerId: child,
});
const members: GroupMemberRef[] = [
  sub(1, 2),
  sub(1, 3),
  sub(2, 4), // nested: Rockford Scales inside Rockford Elevator
  node(2, 10),
  node(2, 11),
  node(4, 12),
  node(3, 20),
  node(5, 10), // the Rockford firewall is also in "All FortiGates"
  node(5, 20),
  node(6, 30),
  node(7, 40),
];

describe('selectSiteGroups', () => {
  it('is off when neither setting is set', () => {
    expect(siteGroupsEnabled({ parent: null, pattern: null })).toBe(false);
    expect(selectSiteGroups(groups, members, { parent: '  ', pattern: null })).toEqual([]);
  });

  it('takes the direct sub-groups of the parent, not their sub-groups or the parent', () => {
    const r = selectSiteGroups(groups, members, { parent: 'locations', pattern: null });
    expect(r.map((g) => g.siteName)).toEqual(['Celina HQ', 'Rockford Elevator']);
  });

  it('matches names by pattern and uses the capture group as the site name', () => {
    const r = selectSiteGroups(groups, members, { parent: null, pattern: '^Site - (.+)$' });
    expect(r).toEqual([
      { containerId: 6, groupName: 'Site - Coldwater', siteName: 'Coldwater' },
      { containerId: 7, groupName: 'Site - St. Henry', siteName: 'St. Henry' },
    ]);
  });

  it('combines parent and pattern', () => {
    const r = selectSiteGroups(groups, members, { parent: 'Locations', pattern: '^Rock' });
    expect(r.map((g) => g.containerId)).toEqual([2]);
  });
});

describe('nodeSiteGroups', () => {
  const sites = selectSiteGroups(groups, members, { parent: 'Locations', pattern: null });

  it('follows nested groups and ignores groups that are not sites', () => {
    const r = nodeSiteGroups(sites, members);
    expect(Object.fromEntries(r.byNode)).toEqual({ 10: 2, 11: 2, 12: 2, 20: 3 });
    expect(r.ambiguous).toEqual([]);
  });

  it('prefers the closest group, then the lowest ID, and reports the ambiguity', () => {
    const extra = [...members, node(3, 12), node(3, 11)];
    const r = nodeSiteGroups(sites, extra);
    // 12 is nested in Rockford (depth 1) but direct in Celina (depth 0) → Celina.
    expect(r.byNode.get(12)).toBe(3);
    // 11 is direct in both → lowest container ID.
    expect(r.byNode.get(11)).toBe(2);
    expect(r.ambiguous).toEqual([11, 12]);
  });

  it('survives a cycle between groups', () => {
    const cyclic = [...members, sub(4, 2)];
    expect(nodeSiteGroups(sites, cyclic).byNode.get(12)).toBe(2);
  });
});

describe('planSiteGroupLinks', () => {
  const sg = selectSiteGroups(groups, members, { parent: null, pattern: '^Site - (.+)$' });

  it('links matching sites by name or alias, renames, and creates the rest', () => {
    const plan = planSiteGroupLinks(
      sg,
      [
        {
          id: 1,
          code: 'coldwater',
          name: 'Coldwater Elevator',
          aliases: ['Coldwater'],
          orionContainerId: null,
        },
        { id: 2, code: 'st-henry', name: 'St Henry', aliases: [], orionContainerId: null },
      ],
      true,
    );
    expect(plan.link).toEqual([
      { siteId: 1, containerId: 6 },
      { siteId: 2, containerId: 7 },
    ]);
    expect(plan.rename).toEqual([
      { siteId: 1, from: 'Coldwater Elevator', to: 'Coldwater' },
      { siteId: 2, from: 'St Henry', to: 'St. Henry' },
    ]);
    expect(plan.create).toEqual([]);
  });

  it('keeps an existing link and follows a renamed group', () => {
    const plan = planSiteGroupLinks(
      sg,
      [
        { id: 1, code: 'cw', name: 'Old Name', aliases: [], orionContainerId: 6 },
        { id: 2, code: 'st-henry', name: 'St. Henry', aliases: [], orionContainerId: 7 },
      ],
      true,
    );
    expect(plan.link).toEqual([]);
    expect(plan.rename).toEqual([{ siteId: 1, from: 'Old Name', to: 'Coldwater' }]);
    expect(plan.create).toEqual([]);
  });

  it('creates sites with unique codes, or nothing when auto-create is off', () => {
    const existing = [
      { id: 9, code: 'coldwater', name: 'Coldwater', aliases: [], orionContainerId: 99 },
    ];
    // Site 9 is linked to another group (99) that is still a site group, so it can't be re-used.
    const withOther = [
      ...sg,
      { containerId: 99, groupName: 'Site - Coldwater', siteName: 'Coldwater' },
    ];
    const plan = planSiteGroupLinks(withOther, existing, true);
    expect(plan.create).toEqual([
      { containerId: 6, name: 'Coldwater', code: 'coldwater-6' },
      { containerId: 7, name: 'St. Henry', code: 'st-henry' },
    ]);
    expect(planSiteGroupLinks(sg, [], false).create).toEqual([]);
  });
});

describe('resolveNodeSite with site groups', () => {
  const sites = [
    { id: 1, code: 'rockford', name: 'Rockford Elevator', aliases: [], divisionCode: 'grain' },
    { id: 2, code: 'celina', name: 'Celina HQ', aliases: [], divisionCode: 'corporate' },
  ];
  const ctx = buildSiteResolutionContext(
    sites,
    [],
    new Map([[30, { siteId: 2 }]]),
    { siteField: 'Site', divisionField: 'Division', siteFromCaptionRegex: '^([A-Za-z]{3,5})[-_]' },
    new Map([
      [10, 1],
      [30, 1],
    ]),
  );

  it('uses the group before the custom property, and an override before the group', () => {
    const viaGroup = resolveNodeSite(
      { nodeId: 10, caption: 'CEL-FW01', customProperties: { Site: 'Celina HQ' } },
      ctx,
    );
    expect(viaGroup).toMatchObject({ siteId: 1, source: 'group', divisionCode: 'grain' });
    expect(resolveNodeSite({ nodeId: 30, caption: 'X', customProperties: {} }, ctx)).toMatchObject({
      siteId: 2,
      source: 'override',
    });
  });

  it('falls back to the custom property for devices in no site group', () => {
    expect(
      resolveNodeSite(
        { nodeId: 99, caption: 'CEL-SW01', customProperties: { Site: 'Celina HQ' } },
        ctx,
      ),
    ).toMatchObject({ siteId: 2, source: 'custom_property' });
  });
});
