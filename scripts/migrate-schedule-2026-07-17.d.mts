import type { DayDef } from '../src/types';

export type MigrationDay = Omit<DayDef, 'tonight' | 'pool'> & {
  tonight?: string[];
  snapshotItemIds?: string[];
  /** RAW persisted pool value — the live doc holds the legacy vocabulary. */
  pool: string;
};

export type DayDiff = {
  index: number | undefined;
  corrected: MigrationDay;
  allowed: Partial<Record<'theme' | 'place' | 'placeEmoji' | 'tonight', { from: unknown; to: unknown }>>;
  forbidden: string[];
  misalignedFields: string[];
};

export type MigrationPlan = {
  corrected: MigrationDay[];
  diffs: DayDiff[];
  forbidden: DayDiff[];
  misaligned: boolean;
  lengthMismatch: boolean;
  changed: boolean;
};

export const ALLOWED_FIELDS: ReadonlyArray<'theme' | 'place' | 'placeEmoji' | 'tonight'>;
export const IMMUTABLE_FIELDS: ReadonlyArray<keyof MigrationDay>;
export const TARGET_DAYS: DayDef[];
export function correctDay(liveDay: MigrationDay, targetDay: DayDef): MigrationDay;
export function diffDay(liveDay: MigrationDay, targetDay: DayDef): DayDiff;
export function planScheduleMigration(liveDays: MigrationDay[], targetDays?: DayDef[]): MigrationPlan;
export function formatMigrationReport(plan: MigrationPlan): string;
