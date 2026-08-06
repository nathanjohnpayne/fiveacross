import type { DayDef } from '../../src/types';
import type { SeedPrompt } from '../seed.d.mts';

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
  days: DayDef[];
};

export const ITEMS: SeedPrompt[];
export const EASY_ITEMS: SeedPrompt[];
export const CLOSING_ITEMS: SeedPrompt[];
export const ALL_ITEMS: SeedPrompt[];
