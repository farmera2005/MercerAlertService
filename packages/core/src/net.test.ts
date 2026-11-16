import { describe, expect, it } from 'vitest';
import { clientIp, ipAllowed, normalizeIp, parseCidrList } from './net';

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6, brackets and zone ids', () => {
    expect(normalizeIp('::ffff:10.20.0.5')).toBe('10.20.0.5');
    expect(normalizeIp('[fe80::1%eth0]')).toBe('fe80::1');
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});

describe('clientIp', () => {
  it('uses the socket peer unless a proxy is trusted', () => {
    expect(
      clientIp({ peer: '::ffff:10.1.1.9', forwardedFor: '1.2.3.4', trustProxy: false, hops: 1 }),
    ).toBe('10.1.1.9');
  });

  it('behind a proxy takes the entry our proxy appended, not a client-supplied one', () => {
    // client sent "6.6.6.6"; nginx appended the real address
    expect(
      clientIp({ peer: '10.0.0.2', forwardedFor: '6.6.6.6, 10.30.4.7', trustProxy: true, hops: 1 }),
    ).toBe('10.30.4.7');
    expect(
      clientIp({
        peer: '10.0.0.2',
        forwardedFor: '10.30.4.7, 10.0.0.3',
        trustProxy: true,
        hops: 2,
      }),
    ).toBe('10.30.4.7');
    expect(clientIp({ peer: '10.0.0.2', forwardedFor: null, trustProxy: true, hops: 1 })).toBe(
      '10.0.0.2',
    );
  });
});

describe('CIDR allowlists', () => {
  it('parses addresses and ranges into canonical form', () => {
    expect(parseCidrList('10.20.0.0/24, 10.20.1.15\n2001:db8::/32')).toEqual({
      cidrs: ['10.20.0.0/24', '10.20.1.15/32', '2001:db8::/32'],
      errors: [],
    });
    expect(parseCidrList('10.0.0.0/33 nope').errors).toHaveLength(2);
  });

  it('allows anyone with an empty list, otherwise only matching addresses', () => {
    expect(ipAllowed(null, [])).toBe(true);
    const list = ['10.20.0.0/24', '2001:db8::/32'];
    expect(ipAllowed('10.20.0.77', list)).toBe(true);
    expect(ipAllowed('::ffff:10.20.0.77', list)).toBe(true);
    expect(ipAllowed('10.20.1.1', list)).toBe(false);
    expect(ipAllowed('2001:db8::5', list)).toBe(true);
    expect(ipAllowed(null, list)).toBe(false);
  });
});
