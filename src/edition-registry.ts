// Runtime-neutral Edition identity registry. This module deliberately imports
// nothing from the browser app so Node deployment tooling can validate Edition
// metadata against the same identifiers that key the app's brand table. Keep
// the values and their derived type in this one module: the repository's
// Node >=22.22 floor strips these erasable types when build-target.mjs imports it.

export const EDITION_IDS = Object.freeze({
  GAY_CRUISE_BINGO: 'gcb',
  VACAY_BINGO: 'vacay',
  FIVE_ACROSS: 'fiveacross',
} as const);

export type EditionId = (typeof EDITION_IDS)[keyof typeof EDITION_IDS];

const REGISTERED_EDITION_IDS = new Set<string>(Object.values(EDITION_IDS));

export function isRegisteredEdition(edition: unknown): edition is EditionId {
  return typeof edition === 'string' && REGISTERED_EDITION_IDS.has(edition);
}

/** Fail when a consumer's Edition-keyed table and the runtime registry differ. */
export function assertEditionRegistryParity(brandEditionIds: Iterable<string>): void {
  const brandIds = new Set(brandEditionIds);
  const missingBrandRows = [...REGISTERED_EDITION_IDS].filter((edition) => !brandIds.has(edition));
  const unregisteredBrandRows = [...brandIds].filter((edition) => !REGISTERED_EDITION_IDS.has(edition));
  const mismatches = [];

  if (missingBrandRows.length > 0) {
    mismatches.push(`missing BRANDS rows: ${missingBrandRows.join(', ')}`);
  }
  if (unregisteredBrandRows.length > 0) {
    mismatches.push(`unregistered BRANDS rows: ${unregisteredBrandRows.join(', ')}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`Edition registry/brand-table mismatch: ${mismatches.join('; ')}.`);
  }
}
