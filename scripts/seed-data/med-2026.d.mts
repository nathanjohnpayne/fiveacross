import type { DayDef } from '../../src/types';
import type { SeedPrompt } from '../seed.d.mts';

/**
 * A seeded Day AS PERSISTED: identical to the app-side `DayDef` except the
 * `pool` value, which stays on the LEGACY vocabulary ('embark'/'farewell')
 * during the #565 transition — the seed writes what the live docs, deployed
 * Functions and firestore.rules speak; the app reads it through `migratePool`.
 */
export type SeedDayDef = Omit<DayDef, 'pool'> & { pool: 'main' | 'embark' | 'farewell' };

export const EVENT_SEED: {
  name: string;
  startsOn: string;
  endsOn: string;
  status: 'active';
  defaultTheme: string;
  claimMode: string;
  settings: {
    reportHideThreshold: number;
    spicyRatio: number;
  };
  timezone: string;
  days: SeedDayDef[];
};

export const ITEMS: SeedPrompt[];
export const EASY_ITEMS: SeedPrompt[];
export const CLOSING_ITEMS: SeedPrompt[];
export const ALL_ITEMS: SeedPrompt[];
