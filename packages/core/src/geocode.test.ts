import { describe, expect, it } from 'vitest';
import {
  geocodeQuery,
  nominatimSearchUrl,
  parseNominatim,
  planGeocode,
  type GeoFields,
} from './geocode';

const site = (o: Partial<GeoFields> = {}): GeoFields => ({
  address: null,
  city: null,
  state: null,
  lat: null,
  lon: null,
  ...o,
});

describe('geocodeQuery', () => {
  it('uses the address, else the city and state', () => {
    expect(geocodeQuery(site({ address: ' 100 W  Main St, Rockford, OH ', city: 'X' }))).toBe(
      '100 W Main St, Rockford, OH',
    );
    expect(geocodeQuery(site({ city: 'Celina', state: 'OH' }))).toBe('Celina, OH');
    expect(geocodeQuery(site({ city: 'Celina' }))).toBe('Celina');
    expect(geocodeQuery(site({ address: '  ', state: 'OH' }))).toBeNull();
  });
});

describe('planGeocode', () => {
  const placed = site({ address: '1 Elm St, Celina, OH', lat: 40.5, lon: -84.5 });

  it('looks up a new site with an address and no coordinates', () => {
    expect(planGeocode(null, site({ address: '1 Elm St, Celina, OH' }))).toEqual({
      action: 'lookup',
      query: '1 Elm St, Celina, OH',
    });
  });
  it('keeps coordinates typed in this save', () => {
    expect(planGeocode(null, placed)).toEqual({
      action: 'manual',
      query: '1 Elm St, Celina, OH',
    });
    const moved = { ...placed, address: '2 Oak St, Celina, OH', lat: 40.6 };
    expect(planGeocode(placed, moved).action).toBe('manual');
  });
  it('looks up a changed address, and does nothing when it is unchanged', () => {
    const moved = { ...placed, address: '2 Oak St, Celina, OH' };
    expect(planGeocode(placed, moved)).toEqual({
      action: 'lookup',
      query: '2 Oak St, Celina, OH',
    });
    expect(planGeocode(placed, { ...placed, city: 'Celina' })).toEqual({ action: 'none' });
    // A site placed before addresses existed keeps its coordinates on other edits.
    const legacy = site({ city: 'Celina', state: 'OH', lat: 40.54, lon: -84.57 });
    expect(planGeocode(legacy, legacy)).toEqual({ action: 'none' });
  });
  it('looks up again when the coordinates are cleared', () => {
    const cleared = { ...placed, lat: null, lon: null };
    expect(planGeocode(placed, cleared).action).toBe('lookup');
  });
  it('does nothing without an address or a city', () => {
    expect(planGeocode(null, site())).toEqual({ action: 'none' });
  });
});

describe('Nominatim', () => {
  it('reads the first match', () => {
    expect(
      parseNominatim([
        { lat: '40.6896531', lon: '-84.6469913', display_name: 'Rockford, Mercer County, Ohio' },
        { lat: '1', lon: '1', display_name: 'elsewhere' },
      ]),
    ).toEqual({ lat: 40.689653, lon: -84.646991, label: 'Rockford, Mercer County, Ohio' });
    expect(parseNominatim([])).toBeNull();
    expect(() => parseNominatim({ error: 'nope' })).toThrow();
  });
  it('builds the search URL', () => {
    expect(nominatimSearchUrl('https://nominatim.openstreetmap.org/', 'Celina, OH', ['us'])).toBe(
      'https://nominatim.openstreetmap.org/search?q=Celina%2C+OH&format=jsonv2&limit=1&countrycodes=us',
    );
    expect(nominatimSearchUrl('http://x', 'a', [])).toBe(
      'http://x/search?q=a&format=jsonv2&limit=1',
    );
  });
});
