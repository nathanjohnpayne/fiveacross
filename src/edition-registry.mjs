// Runtime-neutral Edition identity registry. This module deliberately imports
// nothing from the browser app so Node deployment tooling can validate Edition
// metadata against the same identifiers that key the app's brand table.

export const EDITION_IDS = Object.freeze({
  GAY_CRUISE_BINGO: 'gcb',
  VACAY_BINGO: 'vacay',
  FIVE_ACROSS: 'fiveacross',
});

const REGISTERED_EDITION_IDS = new Set(Object.values(EDITION_IDS));

/** @param {unknown} edition */
export function isRegisteredEdition(edition) {
  return typeof edition === 'string' && REGISTERED_EDITION_IDS.has(edition);
}

/**
 * Fail when a consumer's Edition-keyed table and the runtime registry differ.
 * The declaration file protects TypeScript consumers, but this runtime check
 * also catches a new ID added here without the declaration or brand table.
 *
 * @param {Iterable<string>} brandEditionIds
 */
export function assertEditionRegistryParity(brandEditionIds) {
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
