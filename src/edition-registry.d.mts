export type EditionId = 'gcb' | 'vacay' | 'fiveacross';

export const EDITION_IDS: Readonly<{
  GAY_CRUISE_BINGO: 'gcb';
  VACAY_BINGO: 'vacay';
  FIVE_ACROSS: 'fiveacross';
}>;

export function isRegisteredEdition(edition: unknown): edition is EditionId;

export function assertEditionRegistryParity(brandEditionIds: Iterable<string>): void;
