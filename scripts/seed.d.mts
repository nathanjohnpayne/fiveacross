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
};

export function adminRoster(raw?: string): string[];
export function eventWritePayload(
  eventSeed: SeedEventPayload,
  admins: string[],
  deleteBlackoutEnabled?: unknown,
  includeDays?: boolean,
): Record<string, unknown>;
export function seedItemDocId(text: string): string;
export function seedItemMutations(
  existingDocs: Array<{ id: string; createdBy: string }>,
  now: number,
  pool: SeedPrompt[],
): {
  deleteIds: string[];
  writes: Array<{ id: string; data: Record<string, unknown> }>;
};
export function verifySeedPool(
  existingDocs: SeedDoc[],
  pool: SeedPrompt[],
  reportHideThreshold?: number,
): SeedPoolReport;
export function formatDriftReport(report: SeedPoolReport, eventId: string): string;
