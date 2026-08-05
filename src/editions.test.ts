import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_EDITION, activeEdition, setActiveEdition, editionBrand } from './editions';
import { themesForEdition, defaultThemeForEdition } from './theme/themes';

// Covers the pre-auth Edition brand (#543, ADR 0009 § Consequences). The whole
// point of this module is that the sign-in gate can be branded BEFORE there is
// an authenticated user to read the Event doc with, so these tests assert the
// resolution → brand path without any Firestore or React involved.

afterEach(() => setActiveEdition(DEFAULT_EDITION));

describe('editions — the pre-auth brand', () => {
  it('defaults to the legacy Edition, so the existing build is unchanged', () => {
    expect(activeEdition()).toBe('gcb');
    expect(editionBrand().wordmark).toBe('GAY CRUISE BINGO');
  });

  it('serves the Vacay brand once the resolver installs that Edition', () => {
    // The regression this pins: before #543 the wordmark and the July-2026
    // itinerary were hardcoded, so a Bodega guest opened the app to another
    // product's name and a cruise that is not happening (Codex on #576).
    setActiveEdition('vacay');
    expect(activeEdition()).toBe('vacay');
    const brand = editionBrand();
    expect(brand.wordmark).toBe('VACAY BINGO');
    expect(brand.tagline).not.toMatch(/Trieste|Barcelona|July 2026/);
    expect(brand.offlineNote).not.toMatch(/at sea/i);
  });

  it('falls back to the legacy Edition for an unknown or missing value', () => {
    // Degrading to the shipped experience beats an unbranded screen. `null` is
    // the real case: `Resolution.edition` is nullable on the env short-circuit.
    for (const value of ['no-such-edition', '', null, undefined]) {
      setActiveEdition(value);
      expect(activeEdition()).toBe(DEFAULT_EDITION);
      expect(editionBrand().wordmark).toBe('GAY CRUISE BINGO');
    }
  });

  it('gives every Edition all three strings, none of them empty', () => {
    // A half-filled Edition would render a blank <h1> on the one screen a new
    // player sees first.
    for (const edition of ['gcb', 'vacay']) {
      const brand = editionBrand(edition);
      expect(brand.wordmark.length).toBeGreaterThan(0);
      expect(brand.tagline.length).toBeGreaterThan(0);
      expect(brand.offlineNote.length).toBeGreaterThan(0);
    }
  });

  it('keeps the cruise itinerary OUT of every non-cruise Edition', () => {
    for (const edition of ['vacay']) {
      const brand = editionBrand(edition);
      const all = `${brand.wordmark} ${brand.tagline} ${brand.offlineNote}`;
      expect(all).not.toMatch(/cruise|sailing|at sea|aboard/i);
    }
  });
});

// #580: Edition identity is ONE piece of state. Before this, editions.ts and
// theme/themes.ts each held their own `currentEdition`, so the resolver's
// single setActiveEdition call rebranded the sign-in shell while every Theme
// picker kept serving the build-time Edition (split-brain). This is the
// assertion from the issue: one call moves BOTH surfaces.
describe('editions × themes — one setActiveEdition call drives both (#580)', () => {
  it('changes the brand AND the theme pick list together', () => {
    setActiveEdition('vacay');
    expect(editionBrand().wordmark).toBe('VACAY BINGO');
    expect(themesForEdition().map((t) => t.id)).toEqual([
      'the-birds',
      'side-quests',
      'fog-froth-farewells',
    ]);
    expect(defaultThemeForEdition()).toBe('the-birds');

    setActiveEdition(DEFAULT_EDITION);
    expect(editionBrand().wordmark).toBe('GAY CRUISE BINGO');
    expect(themesForEdition().map((t) => t.id)).toContain('neon-playground');
    expect(defaultThemeForEdition()).toBe('neon-playground');
  });

  it('themes.ts re-exports ARE the editions.ts state, not a second copy', async () => {
    const themed = await import('./theme/themes');
    setActiveEdition('vacay');
    expect(themed.activeEdition()).toBe('vacay');
    themed.setActiveEdition(DEFAULT_EDITION);
    expect(activeEdition()).toBe(DEFAULT_EDITION);
  });
});
