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
  mixedIdentity?: {
    canonical: string[];
    legacy: string[];
  };
  orphanedSnapshotIds: Array<{ dayIndex: number; id: string }>;
};

export type ReseedPlan =
  | { action: 'replace' }
  | { action: 'metadata-only'; reason: string }
  | { action: 'refuse'; reason: string };

/**
 * One Event's seed payload (a scripts/seed-data module's EVENT_SEED). Shapes
 * differ per Event — med-2026 carries the legacy sailStart/sailEnd field
 * names, bodega-bay-2026 the neutral startsOn/endsOn plus standingsFreezeAt —
 * so the shared contract is the common core; each module's own .d.mts narrows
 * it.
 */
export type SeedEventPayload = {
  name: string;
  status: 'active';
  defaultTheme: string;
  claimMode: string;
  settings: {
    reportHideThreshold: number;
    spicyRatio: number;
    easyMixRatio?: number;
  };
  timezone: string;
  days: readonly object[];
};

export type SeedEventModule = {
  EVENT_SEED: SeedEventPayload;
  ITEMS: SeedPrompt[];
  EASY_ITEMS: SeedPrompt[];
  CLOSING_ITEMS: SeedPrompt[];
  ALL_ITEMS: SeedPrompt[];
  /** Optional historic identities the live Event deliberately retained after
   *  an in-place text edit; must align one-to-one with ALL_ITEMS. */
  VERIFY_ITEM_IDS?: readonly string[];
};

export function adminRoster(raw?: string): string[];
export function eventWritePayload(
  eventSeed: SeedEventPayload,
  admins: string[],
  deleteBlackoutEnabled?: unknown,
  includeDays?: boolean,
): Record<string, unknown>;
export function seedItemDocId(text: string): string;
export function reseedGuard(
  seedOwnedCount: number,
  reseedEnv: string | undefined,
): { allowed: boolean; reason?: string };
export function reseedPlan(
  seedOwnedCount: number,
  reseedEnv: string | undefined,
  includeDays: boolean,
): ReseedPlan;
export function orphanedSnapshotDays(
  days: unknown,
  deleteIds: readonly string[],
  writeIds: readonly string[],
): number[];
export function stampedDayIndexes(days: unknown): number[];
export function seedEntryTimestamp(
  existingDocs: Array<{ id: string; createdBy: string; createdAt?: number }>,
  days: unknown,
  now?: number,
): number;
export function effectiveSeedSchedule(
  existingDays: unknown,
  seedDays: readonly object[],
  includeDays: boolean,
): unknown;
export function seedItemMutations(
  existingDocs: Array<{ id: string; createdBy: string; createdAt?: number }>,
  now: number,
  pool: SeedPrompt[],
  fallbackCreatedAt?: number,
): {
  deleteIds: string[];
  writes: Array<{ id: string; data: Record<string, unknown> }>;
};
export function verifySeedPool(
  existingDocs: SeedDoc[],
  pool: SeedPrompt[],
  reportHideThreshold?: number,
  verifyItemIds?: readonly string[],
  days?: unknown,
): SeedPoolReport;
export function formatDriftReport(report: SeedPoolReport, eventId: string): string;
