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
    expect(brand.textContent).toBe('GAY CRUISE BINGO');
    expect(brand.querySelector('b')?.textContent).toBe('BINGO');
  });

  it('flips to the Vacay wordmark once the resolver installs that Edition', () => {
    setActiveEdition('vacay');
    const brand = renderBrand();
    // The regression: a signed-in Bodega guest played the whole event under a
    // header naming another product and a cruise that is not happening.
    expect(brand.textContent).toBe('VACAY BINGO');
    expect(brand.textContent).not.toMatch(/cruise/i);
    expect(brand.querySelector('b')?.textContent).toBe('BINGO');
  });
});
