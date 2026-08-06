import type { SeedEventModule } from '../seed.d.mts';

export const SEED_EVENTS: Record<string, SeedEventModule>;
export const PROJECT_DEFAULT_EVENT: Record<string, string>;
export function resolveSeedEvent(eventId: string): SeedEventModule;
