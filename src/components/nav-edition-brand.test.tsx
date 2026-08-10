import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import Nav from './Nav';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';

// Covers the Edition-branded app header (#602). #543 branded the sign-in gate
// from the Edition table and #580 made `setActiveEdition` the one switch, but
// the POST-auth chrome still hardcoded `GAY CRUISE <b>BINGO</b>` — so a Bodega
// guest signed in under the right brand and then played the whole event under
// the wrong one. Same shape as `signin-edition-brand.test.tsx`: the table's
// correctness is proven in `src/editions.test.ts`; this proves the header
// actually READS it.
//
// Only the Firebase-backed boundaries are mocked: the REAL Nav renders (in a
// MemoryRouter, for the TabBar's NavLinks).

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock('../hooks/useData', () => ({
  useEventDoc: () => ({ data: null }),
}));

afterEach(() => {
  cleanup();
  setActiveEdition(DEFAULT_EDITION);
});

const renderBrand = () => {
  const { container } = render(
    <MemoryRouter>
      <Nav />
    </MemoryRouter>,
  );
  const brand = container.querySelector('.brand');
  expect(brand).not.toBeNull();
  return brand!;
};

describe('Nav — the header wears the resolved Edition (#602)', () => {
  it('shows the cruise wordmark on the legacy Edition, last word bold', () => {
    const brand = renderBrand();
    // Byte-identical to the pre-#602 hardcoded header: "GAY CRUISE " plain,
    // "BINGO" inside <b>.
    expect(brand.querySelector('.brand-wordmark')?.textContent).toBe('GAY CRUISE BINGO');
    expect(brand.querySelector('b')?.textContent).toBe('BINGO');
  });

  it('flips to the Vacay wordmark once the resolver installs that Edition', () => {
    setActiveEdition('vacay');
    const brand = renderBrand();
    // The regression: a signed-in Bodega guest played the whole event under a
    // header naming another product and a cruise that is not happening.
    expect(brand.querySelector('.brand-wordmark')?.textContent).toBe('VACAY BINGO');
    expect(brand.textContent).not.toMatch(/cruise/i);
    expect(brand.querySelector('b')?.textContent).toBe('BINGO');
  });
});

// The endorsement micro-line under the wordmark (daily-cards-wireframes §
// in-app header lockup): every Edition OF the platform wears it — Vacay from
// #647, GCB from #688 — and only Five Across goes without, because it IS the
// platform. The header must follow the brand table's `wordmarkByline`, not
// hardcode either the line or the set of Editions that carry it.
describe('Nav — the platform endorsement byline', () => {
  it.each(['vacay', 'gcb'])('draws BY FIVE ACROSS under the %s wordmark', (edition) => {
    setActiveEdition(edition);
    const brand = renderBrand();
    expect(brand.querySelector('.brand-byline')?.textContent).toBe('BY FIVE ACROSS');
  });

  // The endorsement is a byline, not a rename: it must sit in its own element
  // BELOW the wordmark, never inside it. `.brand-wordmark` is what the header
  // brand tests above read brand-for-brand, and what `white-space: nowrap`
  // holds to one line — smuggling four more words into it would both break
  // that assertion and put "GAY CRUISE BINGO BY FIVE ACROSS" on one line.
  it('keeps the byline OUT of the gcb wordmark', () => {
    setActiveEdition('gcb');
    const brand = renderBrand();
    expect(brand.querySelector('.brand-wordmark')?.textContent).toBe('GAY CRUISE BINGO');
  });

  it('draws no byline for fiveacross, which IS the platform', () => {
    setActiveEdition('fiveacross');
    const brand = renderBrand();
    expect(brand.querySelector('.brand-byline')).toBeNull();
  });
});
