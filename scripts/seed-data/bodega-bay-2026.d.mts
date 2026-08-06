import type { ThemeId } from '../../src/types';
import type { SeedPrompt } from '../seed.d.mts';

/**
 * A Bodega Bay Day. Deliberately NOT DayDef: this Event was seeded with the
 * neutral field names (`place`/`placeEmoji`, #566) and the per-Day Scoring
 * Policy (`scoring`) ahead of the type-contract migrations, while `pool` still
 * persists the LEGACY values ('embark' = the easy pool, 'farewell' = the
 * closing pool) that deployed Cloud Functions and firestore.rules key off
 * (#565). This local shape states exactly what is persisted.
 */
export type BodegaSeedDay = {
  index: number;
  date: string;
  place: string;
  placeEmoji: string;
  /** Transition dual-write: the legacy field names the shipped bundle reads. */
  port: string;
  portEmoji: string;
  theme: ThemeId;
  tonight: string[];
  pool: 'main' | 'embark' | 'farewell';
  tutorial: boolean;
  scoring: 'competitive' | 'ceremonial';
  unlockAt: number;
  freeText: string;
  snapshotItemIds?: string[];
};

export const EVENT_SEED: {
  name: string;
  startsOn: string;
  endsOn: string;
  /** Transition dual-write: the legacy window names the shipped bundle reads. */
  sailStart: string;
  sailEnd: string;
  status: 'active';
  defaultTheme: ThemeId;
  claimMode: string;
  settings: {
    reportHideThreshold: number;
    spicyRatio: number;
    easyMixRatio: number;
  };
  timezone: string;
  standingsFreezeAt: number;
  days: BodegaSeedDay[];
};

export const ITEMS: SeedPrompt[];
export const EASY_ITEMS: SeedPrompt[];
export const CLOSING_ITEMS: SeedPrompt[];
export const ALL_ITEMS: SeedPrompt[];
