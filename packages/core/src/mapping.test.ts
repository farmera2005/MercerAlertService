import { describe, expect, it } from 'vitest';
import {
  buildSiteResolutionContext,
  classifyDeviceRole,
  resolveNodeSite,
  type SiteRef,
} from './mapping';

describe('classifyDeviceRole', () => {
  const cases: Array<[Parameters<typeof classifyDeviceRole>[0], string]> = [
    [
      { caption: 'ROCK-FW01', vendor: 'Fortinet', machineType: 'Fortinet FortiGate 60F' },
      'firewall',
    ],
    [
      { caption: 'ROCK-CORE01', vendor: 'Cisco', machineType: 'Cisco Catalyst 9300-48P' },
      'core_switch',
    ],
    [{ caption: 'ROCK-SW02', vendor: 'Cisco', machineType: 'Cisco Catalyst 2960X' }, 'switch'],
    [
      { caption: 'ROCK-AP03', vendor: 'Ubiquiti Networks', machineType: 'UniFi U6-LR' },
      'access_point',
    ],
    [{ caption: 'ROCK-RTR01', vendor: 'MikroTik', machineType: 'RouterBOARD hEX' }, 'router'],
    [{ caption: 'ROCK-SW01', vendor: 'MikroTik', machineType: 'CRS326-24G' }, 'switch'],
    [{ caption: 'ROCK-UPS01', vendor: 'CyberPower Systems', machineType: 'OR1500' }, 'ups'],
    [
      { caption: 'ROCK-SCALE01', vendor: 'Microsoft', machineType: 'Windows 10 Pro' },
      'scale_system',
    ],
    [{ caption: 'CEL-SQL01', vendor: 'Microsoft', machineType: 'Windows Server 2022' }, 'server'],
    [{ caption: 'mystery', vendor: null, machineType: null, isServer: true }, 'server'],
    [{ caption: 'mystery', vendor: null, machineType: null }, 'other'],
    [{ caption: 'ROCK-SW02', customRole: 'WAN Edge' }, 'firewall'],
  ];
  it.each(cases)('%j → %s', (input, role) => {
    expect(classifyDeviceRole(input)).toBe(role);
  });
});

describe('resolveNodeSite', () => {
  const sites: SiteRef[] = [
    {
      id: 1,
      code: 'celina-hq',
      name: 'Celina HQ',
      aliases: ['CEL', 'Celina'],
      divisionCode: 'corporate',
    },
    {
      id: 2,
      code: 'rockford',
      name: 'Rockford Elevator',
      aliases: ['ROCK'],
      divisionCode: 'grain',
    },
    {
      id: 3,
      code: 'mps-st-marys',
      name: 'MPS Feed St. Marys',
      aliases: ['MPS'],
      divisionCode: 'mps_feed',
    },
  ];
  const divisions = [
    { code: 'grain', name: 'Grain', aliases: [] },
    { code: 'feed', name: 'Feed', aliases: ['Feed Mill'] },
    { code: 'mps_feed', name: 'MPS Feed', aliases: ['MPS'] },
  ];
  const ctx = buildSiteResolutionContext(sites, divisions, new Map([[99, { siteId: 3 }]]), {
    siteField: 'Site',
    divisionField: 'Division',
    siteFromCaptionRegex: '^([A-Za-z]{3,5})[-_]',
  });

  it('matches custom property by name, case/punctuation-insensitively', () => {
    const r = resolveNodeSite(
      { nodeId: 1, caption: 'x', customProperties: { Site: 'rockford elevator' } },
      ctx,
    );
    expect(r).toMatchObject({ siteId: 2, source: 'custom_property', divisionCode: 'grain' });
  });
  it('prefers the Division custom property over the site division', () => {
    const r = resolveNodeSite(
      { nodeId: 1, caption: 'x', customProperties: { Site: 'ROCK', Division: 'Feed Mill' } },
      ctx,
    );
    expect(r.divisionCode).toBe('feed');
  });
  it('reports unmatched values for auto-create and does not fall back to caption', () => {
    const r = resolveNodeSite(
      { nodeId: 1, caption: 'ROCK-FW01', customProperties: { Site: 'Ohio City' } },
      ctx,
    );
    expect(r).toMatchObject({ siteId: null, unmatchedSiteValue: 'Ohio City', source: 'none' });
  });
  it('falls back to hostname prefix', () => {
    const r = resolveNodeSite({ nodeId: 1, caption: 'CEL-SQL01', customProperties: {} }, ctx);
    expect(r).toMatchObject({ siteId: 1, source: 'caption', divisionCode: 'corporate' });
  });
  it('applies admin overrides first', () => {
    const r = resolveNodeSite(
      { nodeId: 99, caption: 'ROCK-FW01', customProperties: { Site: 'Rockford' } },
      ctx,
    );
    expect(r).toMatchObject({ siteId: 3, source: 'override' });
  });
  it('leaves unknown nodes unmapped', () => {
    const r = resolveNodeSite({ nodeId: 1, caption: 'printer', customProperties: {} }, ctx);
    expect(r).toMatchObject({
      siteId: null,
      unmatchedSiteValue: null,
      source: 'none',
      divisionCode: null,
    });
  });
});
