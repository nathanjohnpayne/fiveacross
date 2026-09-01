import { afterEach, describe, expect, it, vi } from 'vitest';

const RENAMED_EDITION_IDS = Object.freeze({
  GAY_CRUISE_BINGO: 'gcb',
  VACAY_BINGO: 'vacay-renamed',
  FIVE_ACROSS: 'fiveacross-renamed',
} as const);

afterEach(() => {
  vi.doUnmock('../edition-registry.ts');
  vi.resetModules();
});

describe('Edition registry drives brand and Theme behavior together', () => {
  it('keeps Theme scopes and defaults attached when registered Edition ids change', async () => {
    // Load both public consumers against an alternate valid registry. A local
    // string copy in either consumer turns this into a visible split-brain.
    const registeredIds = new Set<string>(Object.values(RENAMED_EDITION_IDS));
    vi.doMock('../edition-registry.ts', () => ({
      EDITION_IDS: RENAMED_EDITION_IDS,
      isRegisteredEdition: (edition: unknown) =>
        typeof edition === 'string' && registeredIds.has(edition),
      assertEditionRegistryParity: (brandEditionIds: Iterable<string>) => {
        const brandIds = new Set(brandEditionIds);
        if ([...registeredIds].some((edition) => !brandIds.has(edition))) {
          throw new Error('mock registry/brand-table mismatch');
        }
      },
    }));

    const editions = await import('../editions');
    const themes = await import('./themes');

    editions.setActiveEdition(RENAMED_EDITION_IDS.VACAY_BINGO);
    expect(editions.editionBrand().wordmark).toBe('VACAY BINGO');
    expect(themes.themesForEdition().map((theme) => theme.id)).toEqual([
      'the-birds',
      'side-quests',
      'fog-froth-farewells',
    ]);
    expect(themes.defaultThemeForEdition()).toBe('the-birds');

    editions.setActiveEdition(RENAMED_EDITION_IDS.FIVE_ACROSS);
    expect(editions.editionBrand().wordmark).toBe('FIVE ACROSS');
    expect(themes.themesForEdition().map((theme) => theme.id)).toEqual([
      'marquee',
      'confetti-hour',
      'afterglow',
    ]);
    expect(themes.defaultThemeForEdition()).toBe('marquee');
  });
});
