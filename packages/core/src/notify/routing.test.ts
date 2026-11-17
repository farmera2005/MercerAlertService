import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_RULES, routeIncident, type RouteSubject } from './routing';
import type { RoutingRule } from './types';

const rules: RoutingRule[] = DEFAULT_ROUTING_RULES.map((r, i) => ({ ...r, id: i + 1 }));
const subject = (p: Partial<RouteSubject>): RouteSubject => ({
  priority: 'P3',
  kind: 'interface',
  divisionCode: 'grain',
  siteId: 4,
  affectedSiteIds: [4],
  withinBusinessHours: true,
  ...p,
});

describe('routeIncident (default rules)', () => {
  it('posts P1–P2 to net-critical and P3–P4 to net-alerts', () => {
    expect(routeIncident(rules, subject({ priority: 'P2' })).channelKeys).toEqual(['net-critical']);
    expect(routeIncident(rules, subject({ priority: 'P4' })).channelKeys).toEqual(['net-alerts']);
  });

  it('pages for P1 always and for P2 only after business hours', () => {
    expect(routeIncident(rules, subject({ priority: 'P1' }))).toMatchObject({
      page: true,
      escalateAfterMin: 15,
    });
    expect(routeIncident(rules, subject({ priority: 'P2' })).page).toBe(false);
    expect(routeIncident(rules, subject({ priority: 'P2', withinBusinessHours: false })).page).toBe(
      true,
    );
    expect(routeIncident(rules, subject({ priority: 'P3', withinBusinessHours: false })).page).toBe(
      false,
    );
  });
});

describe('routeIncident (custom rules)', () => {
  const custom: RoutingRule[] = [
    {
      id: 1,
      name: 'Affiliates to their own channel only',
      position: 1,
      enabled: true,
      match: { divisions: ['mps_feed', 'heartland_feed'] },
      channelKey: 'affiliates',
      pageOncall: false,
      escalateAfterMin: null,
      stop: true,
    },
    {
      id: 2,
      name: 'Rockford scales, page fast',
      position: 2,
      enabled: true,
      match: { siteIds: [4], kinds: ['site_outage', 'device_down'] },
      channelKey: 'grain-ops',
      pageOncall: true,
      escalateAfterMin: 10,
      stop: false,
    },
    {
      id: 3,
      name: 'Disabled',
      position: 3,
      enabled: false,
      match: {},
      channelKey: 'nowhere',
      pageOncall: true,
      escalateAfterMin: 1,
      stop: false,
    },
    ...rules.map((r) => ({ ...r, id: r.id + 10, position: r.position + 10 })),
  ];

  it('stops at a matching stop rule', () => {
    expect(routeIncident(custom, subject({ divisionCode: 'mps_feed', priority: 'P1' }))).toEqual({
      channelKeys: ['affiliates'],
      page: false,
      escalateAfterMin: null,
      ruleIds: [1],
    });
  });

  it('combines matching rules, takes the shortest escalation and skips disabled rules', () => {
    const r = routeIncident(custom, subject({ priority: 'P1', kind: 'site_outage' }));
    expect(r.channelKeys).toEqual(['grain-ops', 'net-critical']);
    expect(r).toMatchObject({ page: true, escalateAfterMin: 10 });
    expect(r.ruleIds).not.toContain(3);
  });

  it('matches a site among the affected sites', () => {
    expect(
      routeIncident(custom, subject({ siteId: 9, affectedSiteIds: [9, 4], kind: 'device_down' }))
        .channelKeys,
    ).toContain('grain-ops');
  });
});
