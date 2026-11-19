import { describe, expect, it } from 'vitest';
import { buildSiteResolutionContext, resolveNodeSite } from './mapping';
import {
  chooseSiteGroups,
  cleanGroupName,
  detectSiteGroups,
  nodeSiteGroups,
  planSiteGroupLinks,
  selectSiteGroups,
  siteGroupsEnabled,
  type DetectContext,
  type GroupMemberRef,
  type GroupRef,
  type NodeFacts,
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

describe('detectSiteGroups (automatic)', () => {
  // Rockford (ROCK, 10.21.0.x), Celina HQ (CEL, 10.10.0.x), Celina Feed Mill (CFM, 10.11.0.x),
  // Coldwater (COLD, 10.22.0.x), and a one-device site, Spencerville (SPV, 10.30.0.x).
  const n = (
    nodeId: number,
    caption: string,
    ip: string,
    role: string,
    siteValue: string | null = null,
  ): NodeFacts => ({ nodeId, caption, ip, role, siteValue });
  const nodes: NodeFacts[] = [
    n(1, 'ROCK-FW01', '10.21.0.1', 'firewall'),
    n(2, 'ROCK-SW01', '10.21.0.2', 'switch'),
    n(3, 'ROCK-AP01', '10.21.0.5', 'access_point'),
    n(4, 'ROCK-SCALE01', '10.21.0.3', 'scale_system'),
    n(10, 'CEL-FW01', '10.10.0.1', 'firewall'),
    n(11, 'CEL-SW01', '10.10.0.2', 'core_switch'),
    n(12, 'CEL-SRV01', '10.10.0.20', 'server'),
    n(13, 'CEL-SRV02', '10.10.0.21', 'server'),
    n(15, 'CFM-FW01', '10.11.0.1', 'firewall'),
    n(16, 'CFM-SW01', '10.11.0.2', 'switch'),
    n(20, 'COLD-FW01', '10.22.0.1', 'firewall'),
    n(21, 'COLD-SW01', '10.22.0.2', 'switch'),
    n(30, 'SPV-FW01', '10.30.0.1', 'firewall'),
  ];
  const g = (containerId: number, name: string): GroupRef => ({ containerId, name });
  const autoGroups: GroupRef[] = [
    g(101, 'Rockford Elevator'),
    g(102, 'Celina HQ'),
    g(103, 'Coldwater'),
    g(104, 'Spencerville'),
    g(105, 'All FortiGates'),
    g(106, 'Celina HQ Servers'),
    g(107, 'Rockford Scales'),
    g(108, 'Grain Division'),
    g(109, 'Empty group'),
    g(110, 'Celina Feed Mill'),
  ];
  const autoMembers: GroupMemberRef[] = [
    ...[1, 2, 3].map((id) => node(101, id)),
    sub(101, 107),
    node(107, 4),
    ...[10, 11, 12, 13].map((id) => node(102, id)),
    ...[20, 21].map((id) => node(103, id)),
    node(104, 30),
    ...[1, 10, 15, 20, 30].map((id) => node(105, id)),
    ...[12, 13].map((id) => node(106, id)),
    sub(108, 101),
    sub(108, 103),
    ...[15, 16].map((id) => node(110, id)),
  ];
  const ctx = (over: Partial<DetectContext> = {}): DetectContext => ({
    nodes,
    captionRegex: '^([A-Za-z]{3,5})[-_]',
    knownSiteKeys: new Set(['rockfordelevator', 'celinahq']),
    linked: new Set(),
    ...over,
  });

  it('finds the site groups and says why the others are not', () => {
    const r = detectSiteGroups(autoGroups, autoMembers, ctx());
    expect(r.siteGroups.map((s) => s.groupName)).toEqual([
      'Celina Feed Mill',
      'Celina HQ',
      'Coldwater',
      'Rockford Elevator',
      'Spencerville',
    ]);
    const why = Object.fromEntries(r.rejected.map((x) => [x.groupName, x.reason]));
    expect(why).toEqual({
      'All FortiGates': 'devices are at several locations (at most 1 of 5 in one place)',
      'Celina HQ Servers': 'mostly the same devices as “Celina HQ”',
      'Empty group': 'no monitored devices',
      'Grain Division': 'devices are at several locations (at most 4 of 6 in one place)',
      'Rockford Scales': 'inside the site group “Rockford Elevator”',
    });
    const rock = r.siteGroups.find((s) => s.groupName === 'Rockford Elevator')!;
    expect(rock.reason).toBe('same hostname prefix ROCK, 4 kinds of device, named after a site');
    // One device, one kind, unknown name: a site because its neighbours are.
    expect(r.siteGroups.find((s) => s.groupName === 'Spencerville')!.reason).toMatch(
      /like the groups next to it$/,
    );
  });

  it('prefers the sites inside a city group over the city group itself', () => {
    const groups = [...autoGroups, g(120, 'Celina')];
    const members = [...autoMembers, sub(120, 102), sub(120, 110)];
    // Only the Site property tells Celina HQ and the feed mill apart here.
    const facts = nodes.map((x) => ({
      ...x,
      caption: x.caption!.replace(/^CFM/, 'CEL'),
      ip: x.ip!.replace(/^10\.11\./, '10.10.'),
      siteValue: [15, 16].includes(x.nodeId)
        ? 'Celina Feed Mill'
        : x.caption!.startsWith('CEL')
          ? 'Celina HQ'
          : x.caption!.split('-')[0]!,
    }));
    const r = detectSiteGroups(groups, members, ctx({ nodes: facts }));
    expect(r.rejected.find((x) => x.groupName === 'Celina')?.reason).toBe(
      'contains several site groups',
    );
    expect(r.siteGroups.map((s) => s.groupName)).toContain('Celina Feed Mill');
  });

  it('keeps a linked group, cleans up names, and uses nothing without location data', () => {
    const r = detectSiteGroups(autoGroups, autoMembers, ctx({ linked: new Set([105]) }));
    expect(r.siteGroups.find((s) => s.containerId === 105)?.reason).toBe(
      'kept because it is linked to a site (on its own: devices are at several locations (at most 1 of 5 in one place))',
    );
    // A linked group that qualifies anyway shows its own reason.
    const linkedRock = detectSiteGroups(autoGroups, autoMembers, ctx({ linked: new Set([101]) }));
    expect(linkedRock.siteGroups.find((s) => s.containerId === 101)?.reason).toMatch(
      /^same hostname prefix ROCK/,
    );
    expect(cleanGroupName('Site - Rockford')).toBe('Rockford');
    expect(cleanGroupName('LOC: Celina HQ')).toBe('Celina HQ');
    expect(cleanGroupName('Coldwater Site')).toBe('Coldwater');
    expect(cleanGroupName('Site')).toBe('Site');
    const blind = nodes.map((x) => ({ ...x, caption: null, ip: null }));
    const none = detectSiteGroups(autoGroups, autoMembers, ctx({ nodes: blind }));
    expect(none.siteGroups.map((s) => s.groupName)).toEqual(['Celina HQ', 'Rockford Elevator']);
    expect(none.rejected.find((x) => x.groupName === 'Coldwater')?.reason).toBe(
      'no location information to compare',
    );
  });

  it('chooses by mode: manual settings win, off uses nothing', () => {
    const c = ctx();
    expect(chooseSiteGroups(autoGroups, autoMembers, { parent: null, pattern: null }, c).mode).toBe(
      'off',
    );
    const manual = chooseSiteGroups(
      autoGroups,
      autoMembers,
      { parent: null, pattern: '^Cold', auto: true },
      c,
    );
    expect(manual.mode).toBe('manual');
    expect(manual.siteGroups.map((s) => s.groupName)).toEqual(['Coldwater']);
    const auto = chooseSiteGroups(
      autoGroups,
      autoMembers,
      { parent: null, pattern: null, auto: true },
      c,
    );
    expect(auto.mode).toBe('auto');
    expect(auto.siteGroups).toHaveLength(5);
  });

  it('unlinks sites whose group is no longer a site group', () => {
    const plan = planSiteGroupLinks(
      [{ containerId: 6, groupName: 'Site - Coldwater', siteName: 'Coldwater' }],
      [
        { id: 1, code: 'cw', name: 'Coldwater', aliases: [], orionContainerId: 6 },
        { id: 2, code: 'x', name: 'Gone', aliases: [], orionContainerId: 77 },
      ],
      true,
    );
    expect(plan.unlink).toEqual([{ siteId: 2, containerId: 77 }]);
  });
});

describe('detectSiteGroups on messier networks', () => {
  // Every site shares 10.0.0.0/16 and there is no Site property, so the /16 and the property tell
  // nothing apart; sites use several /24s, and hostnames follow two conventions.
  const f = (
    nodeId: number,
    caption: string,
    ip: string,
    role: string,
    location: string | null = null,
  ): NodeFacts => ({
    nodeId,
    caption,
    ip,
    role,
    siteValue: null,
    location,
  });
  const nodes: NodeFacts[] = [
    // Rockford Elevator: two naming styles, two subnets.
    f(1, 'ROCK-FW01', '10.0.21.1', 'firewall'),
    f(2, 'ROCK-SW01', '10.0.21.2', 'switch'),
    f(3, 'rockford-ap1', '10.0.121.5', 'access_point'),
    f(4, 'rockford-ap2', '10.0.121.6', 'access_point'),
    f(5, 'rockford-scale', '10.0.121.7', 'scale_system'),
    // Coldwater: generic hostnames; the Location field says where they are.
    f(10, 'FG60F-1', '10.0.22.1', 'firewall', 'Coldwater Elevator - MDF'),
    f(11, 'SW-24P-2', '10.0.122.2', 'switch', 'Coldwater Elevator, scale house'),
    f(12, 'AP-3', '10.0.122.3', 'access_point', 'Coldwater Elevator'),
    // Mendon: three devices, the firewall polled on its public WAN address.
    f(20, 'MEN-FW01', '198.51.100.7', 'firewall'),
    f(21, 'MEN-SW01', '10.0.23.2', 'switch'),
    f(22, 'MEN-AP01', '10.0.23.3', 'access_point'),
    // Elsewhere.
    f(30, 'CEL-FW01', '10.0.10.1', 'firewall'),
    f(31, 'CEL-SW01', '10.0.10.2', 'core_switch'),
  ];
  const groups: GroupRef[] = [
    { containerId: 1, name: 'Rockford Elevator' },
    { containerId: 2, name: 'Coldwater' },
    { containerId: 3, name: 'Mendon' },
    { containerId: 4, name: 'Celina HQ' },
    { containerId: 5, name: 'All FortiGates' },
  ];
  const members: GroupMemberRef[] = [
    ...[1, 2, 3, 4, 5].map((id) => node(1, id)),
    ...[10, 11, 12].map((id) => node(2, id)),
    ...[20, 21, 22].map((id) => node(3, id)),
    ...[30, 31].map((id) => node(4, id)),
    ...[1, 10, 20, 30].map((id) => node(5, id)),
  ];
  const ctx = (decisions?: Map<number, 'site' | 'not_site'>): DetectContext => ({
    nodes,
    captionRegex: '^([A-Za-z]{3,5})[-_]',
    knownSiteKeys: new Set(),
    linked: new Set(),
    decisions,
  });

  it('finds sites with mixed hostnames, several subnets, a Location field or a WAN-addressed firewall', () => {
    const r = detectSiteGroups(groups, members, ctx());
    expect(r.siteGroups.map((s) => s.groupName)).toEqual([
      'Celina HQ',
      'Coldwater',
      'Mendon',
      'Rockford Elevator',
    ]);
    expect(r.rejected).toEqual([
      {
        containerId: 5,
        groupName: 'All FortiGates',
        reason: 'devices are at several locations (at most 1 of 4 in one place)',
      },
    ]);
    expect(r.siteGroups.find((s) => s.groupName === 'Coldwater')!.reason).toMatch(
      /^3 of 3 devices match its name/,
    );
  });

  it('lets an admin decide: "not a site" and "use as a site" win, in both modes', () => {
    const decisions = new Map<number, 'site' | 'not_site'>([
      [3, 'not_site'],
      [5, 'site'],
    ]);
    const auto = chooseSiteGroups(
      groups,
      members,
      { parent: null, pattern: null, auto: true },
      ctx(decisions),
    );
    expect(auto.siteGroups.map((s) => [s.groupName, s.reason])).toContainEqual([
      'All FortiGates',
      'marked as a site',
    ]);
    expect(auto.siteGroups.map((s) => s.groupName)).not.toContain('Mendon');
    expect(auto.rejected).toContainEqual({
      containerId: 3,
      groupName: 'Mendon',
      reason: 'marked “not a site”',
    });
    const manual = chooseSiteGroups(
      groups,
      members,
      { parent: null, pattern: '^(Mendon|Coldwater)$' },
      ctx(decisions),
    );
    expect(manual.siteGroups.map((s) => s.groupName)).toEqual(['All FortiGates', 'Coldwater']);
  });
});
