/**
 * PLACEHOLDER reference data (docs/open-questions.md B1–B5). Sites are marked
 * profile_status='placeholder' so the UI can flag them until IT confirms the real list.
 * Coordinates are approximate town centres for the map.
 */
import type { BusinessHours } from './schema/reference';

export const SEED_DIVISIONS = [
  {
    code: 'corporate',
    name: 'Corporate',
    isAffiliate: false,
    sortOrder: 10,
    aliases: ['HQ', 'Corp', 'Administration', 'IT'],
  },
  {
    code: 'grain',
    name: 'Grain',
    isAffiliate: false,
    sortOrder: 20,
    aliases: ['Grain Marketing', 'Elevator', 'Elevators'],
  },
  {
    code: 'agronomy',
    name: 'Agronomy',
    isAffiliate: false,
    sortOrder: 30,
    aliases: ['Agronomy Center', 'Agron', 'Agro'],
  },
  {
    code: 'feed',
    name: 'Feed',
    isAffiliate: false,
    sortOrder: 40,
    aliases: ['Feed Mill', 'Animal Nutrition'],
  },
  {
    code: 'energy',
    name: 'Energy',
    isAffiliate: false,
    sortOrder: 50,
    aliases: ['Fuel', 'Propane', 'Energy Division'],
  },
  {
    code: 'mps_feed',
    name: 'MPS Feed',
    isAffiliate: true,
    sortOrder: 60,
    aliases: ['MPS', 'MPS Feed Inc'],
  },
  {
    code: 'heartland_feed',
    name: 'Heartland Feed Services',
    isAffiliate: true,
    sortOrder: 70,
    aliases: ['Heartland', 'HFS'],
  },
];

const OFFICE: BusinessHours = { days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' };
const HARVEST: BusinessHours = { days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '22:00' };

type SeedSite = {
  code: string;
  name: string;
  divisionCode: string;
  city: string;
  state: string;
  lat: number | null;
  lon: number | null;
  tier: 'critical' | 'high' | 'standard';
  harvestCritical: boolean;
  aliases: string[];
  businessHours?: BusinessHours;
  harvestHours?: BusinessHours | null;
};

const BASE_SITES: Array<Omit<SeedSite, 'businessHours' | 'harvestHours'>> = [
  {
    code: 'celina-hq',
    name: 'Celina HQ',
    divisionCode: 'corporate',
    city: 'Celina',
    state: 'OH',
    lat: 40.5489,
    lon: -84.5702,
    tier: 'critical',
    harvestCritical: false,
    aliases: ['CEL', 'Celina', 'HQ'],
  },
  {
    code: 'rockford',
    name: 'Rockford Elevator',
    divisionCode: 'grain',
    city: 'Rockford',
    state: 'OH',
    lat: 40.6928,
    lon: -84.6472,
    tier: 'high',
    harvestCritical: true,
    aliases: ['ROCK', 'Rockford'],
  },
  {
    code: 'coldwater',
    name: 'Coldwater Elevator',
    divisionCode: 'grain',
    city: 'Coldwater',
    state: 'OH',
    lat: 40.4795,
    lon: -84.6283,
    tier: 'high',
    harvestCritical: true,
    aliases: ['COLD', 'Coldwater'],
  },
  {
    code: 'fort-recovery',
    name: 'Fort Recovery Elevator',
    divisionCode: 'grain',
    city: 'Fort Recovery',
    state: 'OH',
    lat: 40.4131,
    lon: -84.7766,
    tier: 'high',
    harvestCritical: true,
    aliases: ['FTR', 'Fort Recovery'],
  },
  {
    code: 'st-henry',
    name: 'St. Henry Elevator',
    divisionCode: 'grain',
    city: 'St. Henry',
    state: 'OH',
    lat: 40.4181,
    lon: -84.6386,
    tier: 'standard',
    harvestCritical: true,
    aliases: ['STH', 'St Henry'],
  },
  {
    code: 'mendon',
    name: 'Mendon Elevator',
    divisionCode: 'grain',
    city: 'Mendon',
    state: 'OH',
    lat: 40.6706,
    lon: -84.5172,
    tier: 'standard',
    harvestCritical: true,
    aliases: ['MEN', 'Mendon'],
  },
  {
    code: 'ohio-city',
    name: 'Ohio City Agronomy',
    divisionCode: 'agronomy',
    city: 'Ohio City',
    state: 'OH',
    lat: 40.7706,
    lon: -84.6138,
    tier: 'standard',
    harvestCritical: false,
    aliases: ['OHC', 'Ohio City'],
  },
  {
    code: 'van-wert',
    name: 'Van Wert Agronomy Center',
    divisionCode: 'agronomy',
    city: 'Van Wert',
    state: 'OH',
    lat: 40.8695,
    lon: -84.5841,
    tier: 'standard',
    harvestCritical: false,
    aliases: ['VWRT', 'Van Wert'],
  },
  {
    code: 'wapakoneta',
    name: 'Wapakoneta Energy',
    divisionCode: 'energy',
    city: 'Wapakoneta',
    state: 'OH',
    lat: 40.5678,
    lon: -84.1936,
    tier: 'standard',
    harvestCritical: false,
    aliases: ['WAPA', 'Wapakoneta'],
  },
  {
    code: 'celina-feed',
    name: 'Celina Feed Mill',
    divisionCode: 'feed',
    city: 'Celina',
    state: 'OH',
    lat: 40.552,
    lon: -84.556,
    tier: 'high',
    harvestCritical: false,
    aliases: ['CFM', 'Celina Feed'],
  },
  {
    code: 'mps-st-marys',
    name: 'MPS Feed - St. Marys',
    divisionCode: 'mps_feed',
    city: 'St. Marys',
    state: 'OH',
    lat: 40.5423,
    lon: -84.3891,
    tier: 'high',
    harvestCritical: false,
    aliases: ['MPS', 'St Marys'],
  },
  {
    code: 'heartland-feed',
    name: 'Heartland Feed Services',
    divisionCode: 'heartland_feed',
    city: '',
    state: 'OH',
    lat: null,
    lon: null,
    tier: 'standard',
    harvestCritical: false,
    aliases: ['HFS', 'Heartland'],
  },
];

export const SEED_SITES: SeedSite[] = BASE_SITES.map((s) => ({
  ...s,
  businessHours: OFFICE,
  harvestHours: s.harvestCritical ? HARVEST : null,
}));
