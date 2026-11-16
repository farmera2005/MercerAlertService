import { describe, expect, it } from 'vitest';
import {
  siteHealth,
  worstLevel,
  type SiteHealthIncident,
  type SiteHealthNode,
} from './site-health';

const node = (
  statusNorm: SiteHealthNode['statusNorm'],
  role: SiteHealthNode['role'] = 'switch',
) => ({
  statusNorm,
  role,
  unmanaged: false,
});
const inc = (p: Partial<SiteHealthIncident>): SiteHealthIncident => ({
  priority: 'P3',
  kind: 'interface',
  status: 'open',
  inMaintenance: false,
  title: 'Interface is down',
  ...p,
});

describe('siteHealth', () => {
  it('is green when every device is up and nothing is open', () => {
    const h = siteHealth([node('up'), node('up', 'firewall')], []);
    expect(h).toMatchObject({ level: 'ok', reason: 'All 2 devices up', nodesTotal: 2 });
  });

  it('is unknown with no monitored devices', () => {
    expect(siteHealth([{ ...node('up'), unmanaged: true }], []).level).toBe('unknown');
  });

  it('is red for a site outage or any open P1/P2', () => {
    expect(
      siteHealth(
        [node('down', 'firewall')],
        [inc({ kind: 'site_outage', priority: 'P1', title: 'Site down' })],
      ),
    ).toMatchObject({ level: 'bad', reason: 'P1 · Site down' });
    expect(siteHealth([node('up')], [inc({ priority: 'P2', title: 'UPS on battery' })]).level).toBe(
      'bad',
    );
  });

  it('is red when the firewall is down before correlation has caught up', () => {
    expect(siteHealth([node('down', 'firewall'), node('unreachable')], [])).toMatchObject({
      level: 'bad',
      reason: 'Every device is down or unreachable',
    });
    expect(siteHealth([node('down', 'firewall'), node('up')], []).reason).toBe(
      'WAN edge firewall down',
    );
  });

  it('is amber for P3/P4 incidents and for devices down without an incident', () => {
    expect(siteHealth([node('up')], [inc({ priority: 'P4' })]).level).toBe('warn');
    expect(siteHealth([node('down', 'access_point'), node('up')], [])).toMatchObject({
      level: 'warn',
      reason: '1 device down',
    });
    expect(siteHealth([node('warning'), node('up')], []).reason).toBe('1 device in warning');
  });

  it('acknowledged incidents still count; resolved ones do not', () => {
    expect(siteHealth([node('up')], [inc({ status: 'acknowledged' })]).level).toBe('warn');
    expect(siteHealth([node('up')], [inc({ status: 'resolved', priority: 'P1' })]).level).toBe(
      'ok',
    );
  });

  it('shows maintenance instead of red when the problem is under a maintenance window', () => {
    expect(
      siteHealth(
        [node('down', 'firewall')],
        [inc({ kind: 'site_outage', priority: 'P1', inMaintenance: true })],
        { inMaintenance: true },
      ),
    ).toMatchObject({ level: 'maintenance', reason: 'In maintenance · 1 open incident' });
    expect(siteHealth([node('down', 'firewall')], [], { inMaintenance: true }).level).toBe(
      'maintenance',
    );
  });

  it('worstLevel picks the most severe', () => {
    expect(worstLevel(['ok', 'warn', 'unknown'])).toBe('warn');
    expect(worstLevel(['ok', 'bad'])).toBe('bad');
    expect(worstLevel([])).toBe('unknown');
  });
});
