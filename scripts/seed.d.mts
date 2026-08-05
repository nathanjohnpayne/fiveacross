import type { DayDef } from '../src/types';

export type SeedPrompt = {
  text: string;
  spicy: boolean;
  pool?: 'main' | 'embark' | 'farewell';
};

export type SeedDoc = {
  id: string;
  text: string;
  createdBy: string;
  spicy: boolean;
  isFreeSpace: boolean;
  status: string;
  reportCount: number;
  pool?: string;
};

export type SeedPoolReport = {
  ok: boolean;
  expected: number;
  seedOwned: number;
  playerOwned: number;
  missing: Array<{ id: string; text: string }>;
  mismatched: Array<{ id: string; text: string; [key: string]: unknown }>;
  stale: Array<{ id: string; text: string }>;
};

export const EVENT_SEED: {
  name: string;
  sailStart: string;
  sailEnd: string;
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

export function adminRoster(raw?: string): string[];
export function eventWritePayload(
  admins: string[],
  deleteBlackoutEnabled?: unknown,
  includeDays?: boolean,
): Record<string, unknown>;
export const ITEMS: SeedPrompt[];
export const EASY_ITEMS: SeedPrompt[];
export const CLOSING_ITEMS: SeedPrompt[];
export const ALL_ITEMS: SeedPrompt[];
export function seedItemDocId(text: string): string;
export function verifySeedPool(
  existingDocs: SeedDoc[],
  pool?: SeedPrompt[],
  reportHideThreshold?: number,
): SeedPoolReport;
export function formatDriftReport(report: SeedPoolReport, eventId: string): string;
