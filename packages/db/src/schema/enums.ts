import { pgEnum } from 'drizzle-orm/pg-core';

export const siteTier = pgEnum('site_tier', ['critical', 'high', 'standard']);
export const profileStatus = pgEnum('profile_status', ['placeholder', 'auto', 'confirmed']);
export const transitionKind = pgEnum('transition_kind', ['alert', 'node', 'interface', 'source']);
export const pollStatus = pgEnum('poll_status', ['ok', 'error', 'skipped']);
export const actorType = pgEnum('actor_type', ['user', 'kiosk', 'system']);
