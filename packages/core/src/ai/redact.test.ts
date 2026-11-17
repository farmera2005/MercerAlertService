import { describe, expect, it } from 'vitest';
import { Redactor } from './redact';

describe('Redactor', () => {
  it('replaces addresses and serials with stable placeholders and restores them', () => {
    const r = new Redactor();
    const text =
      'ROCK-FW01 (10.20.30.1) lost its WAN; peer 10.20.30.2 and 10.20.30.1 again. MAC 00:1a:2b:3c:4d:5e, v6 fe80::1, Serial: FGT60FTK2009ABCD, bare FOC1234X0YZ.';
    const out = r.redact(text);
    expect(out).toBe(
      'ROCK-FW01 ([IP-1]) lost its WAN; peer [IP-2] and [IP-1] again. MAC [MAC-1], v6 [IP-3], Serial: [SERIAL-1], bare [SERIAL-2].',
    );
    expect(r.restore(out)).toBe(text);
    expect(r.stats).toEqual({ IP: 3, MAC: 1, SERIAL: 2 });
  });

  it('keeps hostnames, times, incident ids and placeholders it did not issue', () => {
    const r = new Redactor();
    const text = 'ROCK-SW02 down at 10:30, INC-42, see ELEV-CORE-01. Uptime 12:30:45.';
    expect(r.redact(text)).toBe(text);
    expect(r.restore('Check [IP-9]')).toBe('Check [IP-9]');
  });

  it('redacts nested values and does nothing when disabled', () => {
    const r = new Redactor();
    const v = r.redactDeep({ a: ['host 192.168.1.10'], b: { c: 'cc-dd' }, n: 3 });
    expect(v).toEqual({ a: ['host [IP-1]'], b: { c: 'cc-dd' }, n: 3 });
    expect(r.restoreDeep(v)).toEqual({ a: ['host 192.168.1.10'], b: { c: 'cc-dd' }, n: 3 });
    const off = new Redactor(false);
    expect(off.redact('10.0.0.1')).toBe('10.0.0.1');
    expect(off.redactedAny).toBe(false);
  });

  it('numbers the stable prefix first, so cached text stays identical between calls', () => {
    const prefix = 'Corporate firewall is 172.16.0.1.';
    const a = new Redactor();
    const b = new Redactor();
    expect(a.redact(prefix)).toBe(b.redact(prefix));
    a.redact('10.1.1.1');
    b.redact('10.9.9.9');
    expect(a.restore('[IP-2]')).toBe('10.1.1.1');
    expect(b.restore('[IP-2]')).toBe('10.9.9.9');
  });
});

describe('Redactor keep-list', () => {
  it('leaves known device models and hostnames alone but still redacts addresses', () => {
    const r = new Redactor(true, ['CyberPower OR1500LCDRM1U', 'ROCKSW0102AB']);
    expect(r.redact('UPS OR1500LCDRM1U at 10.1.2.3, S/N FOC1234X0YZ, peer ROCKSW0102AB')).toBe(
      'UPS OR1500LCDRM1U at [IP-1], S/N [SERIAL-1], peer ROCKSW0102AB',
    );
  });
});
