import { describe, expect, it } from 'vitest';
import { displayTitle, formatDuration, shortSummary, stripAddresses } from './text';

describe('dashboard text', () => {
  it('prefers the AI title and short summary when present', () => {
    expect(
      displayTitle({ title: 'Site down — Rockford', aiTitle: 'Rockford elevator offline' }),
    ).toBe('Rockford elevator offline');
    expect(displayTitle({ title: 'Site down — Rockford', aiTitle: '  ' })).toBe(
      'Site down — Rockford',
    );
    expect(
      shortSummary({ templateSummary: 'Long text.', aiSummary: { short: 'Scales offline.' } }),
    ).toBe('Scales offline.');
  });

  it('cuts the template summary at a sentence boundary', () => {
    const t =
      'The WAN edge firewall ROCK-FW01 at Rockford Elevator (Grain) is down, so the whole site is cut off. Affected: 2 scale systems and 9 switches. Scales at Rockford Elevator may be offline.';
    expect(shortSummary({ templateSummary: t, aiSummary: null }, 120)).toBe(
      'The WAN edge firewall ROCK-FW01 at Rockford Elevator (Grain) is down, so the whole site is cut off.',
    );
    expect(shortSummary({ templateSummary: 'x'.repeat(300), aiSummary: null }, 20)).toHaveLength(
      20,
    );
  });

  it('removes IP and MAC addresses for the wall', () => {
    expect(stripAddresses('Gateway 10.20.0.1 (00:1A:2B:3C:4D:5E) and fe80::1:2:3 down')).toBe(
      'Gateway [address] ([address]) and [address] down',
    );
    expect(stripAddresses('Down since 10:30, link 2001:db8::5 and ::1')).toBe(
      'Down since 10:30, link [address] and [address]',
    );
  });

  it('formats durations', () => {
    expect(formatDuration(30_000)).toBe('<1 min');
    expect(formatDuration(95 * 60_000)).toBe('1 h 35 min');
    expect(formatDuration(50 * 3600_000)).toBe('2 d 2 h');
  });
});
