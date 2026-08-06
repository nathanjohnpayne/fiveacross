import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';
import DaySwitcher from './DaySwitcher';
import ReviewQueue from './admin/ReviewQueue';
import TutorialBanner from './TutorialBanner';
import type { DayDef, EventDoc } from '../types';

// Covers the RENDERERS of the three registers (#608), in the pattern
// `signin-edition-brand.test.tsx` establishes: flip the Edition with
// `setActiveEdition`, render the real component, assert the register.
//
// Both halves are needed and neither implies the other. `edition-lexicon.test.ts`
// proves the TABLE is right; these prove the components actually READ it — the
// table could be perfect while a component still held the string, which is
// precisely the state #608 found the app in after #554's brand sweep.

// Only the Firebase boundary is mocked — the REAL components render, which is
// the whole point: a mocked ReviewQueue would prove nothing about whether it
// reads the Edition.
vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
}));

afterEach(() => {
  cleanup();
  setActiveEdition(DEFAULT_EDITION);
});

const DAYS: DayDef[] = [
  {
    index: 0,
    date: '2026-07-15',
    place: 'Trieste',
    placeEmoji: '🇮🇹',
    theme: 'welcome-aboard',
    pool: 'embark',
    unlockAt: 0,
    tutorial: true,
  } as DayDef,
];

describe('DaySwitcher — the strip names the occasion', () => {
  it('says Cruise days on the legacy Edition', () => {
    render(<DaySwitcher days={DAYS} viewedIndex={0} onSelect={vi.fn()} now={1} />);
    expect(screen.getByRole('tablist', { name: 'Cruise days' })).toBeTruthy();
  });

  it.each([
    ['vacay', 'Trip days'],
    ['fiveacross', 'Event days'],
  ])('says %s → %s', (edition, label) => {
    setActiveEdition(edition);
    render(<DaySwitcher days={DAYS} viewedIndex={0} onSelect={vi.fn()} now={1} />);
    expect(screen.getByRole('tablist', { name: label })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Cruise days' })).toBeNull();
  });
});

describe('TutorialBanner — the warm-up caption is a whole-string override', () => {
  it('keeps the ship on the legacy Edition', () => {
    render(<TutorialBanner day={DAYS[0]} />);
    expect(screen.getByText(/all on the ship/)).toBeTruthy();
  });

  it.each(['vacay', 'fiveacross'])('drops the ship on %s', (edition) => {
    setActiveEdition(edition);
    render(<TutorialBanner day={DAYS[0]} />);
    expect(screen.queryByText(/all on the ship/)).toBeNull();
    expect(screen.getByText(/warm-up/)).toBeTruthy();
  });
});

describe('ReviewQueue — even the empty state carries a register', () => {
  const empty = (event?: EventDoc) => (
    <ReviewQueue event={event ?? null} reports={[]} pendingItems={[]} claims={[]} adminUid="admin" />
  );

  it('sends the legacy admin to enjoy the boat', () => {
    render(empty());
    expect(screen.getByText('All clear. Go enjoy the boat.')).toBeTruthy();
  });

  it.each([
    ['vacay', 'All clear. Go enjoy the trip.'],
    ['fiveacross', 'All clear. Go enjoy yourself.'],
  ])('%s reads %s', (edition, copy) => {
    setActiveEdition(edition);
    render(empty());
    expect(screen.getByText(copy)).toBeTruthy();
  });
});
