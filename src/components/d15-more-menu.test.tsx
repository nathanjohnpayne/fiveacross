import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { EventDoc } from '../types';

// Covers specs/d15-more-menu.md (#208) — the full More tab: profile, theme,
// Play (schedule / suggest / how-to-play / install), Support (bug / 18+), an
// admin-only Admin row badged with the pending count, sign out, and a version
// footer, in that fixed spec order. Drives the REAL `More.tsx` composition
// with its child components and data hooks stubbed (each has its own focused
// suite already — ProfileEditor: w1-profile-avatar.test.tsx; BugReport:
// w4-bug-report-inbox.test.tsx; AcceptableUse/Admin: w2-admin-console.test.tsx
// and w3-security-hardening.test.tsx) so this file stays about ONE thing: the
// menu's shape, order, and admin gating — not re-proving those components'
// own internals.

const H = vi.hoisted(() => ({
  user: { uid: 'player-uid' } as { uid: string } | null,
  event: {
    name: 'Test Cruise',
    sailStart: '2027-01-01',
    sailEnd: '2027-01-08',
    admins: [] as string[],
    days: [],
    timezone: 'UTC',
  } as unknown as EventDoc,
  pendingCount: 0,
  signOutUser: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: H.user, signOutUser: H.signOutUser }),
}));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  useMyUser: () => ({ data: null, loading: false, hasServerData: true }),
  usePendingItemCount: (enabled: boolean) => ({ count: enabled ? H.pendingCount : 0, loading: false }),
}));
vi.mock('../hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => ({ standalone: true, deferred: null, showIOSHint: false, install: vi.fn() }),
}));
// More.tsx now imports `track` directly for the Text size row's
// `text_size_change` event (#215) — mock it the same way every other
// analytics-touching component's suite does (e.g. ThemeSwitcher.test.tsx),
// since `../analytics` -> `./firebase` throws `auth/invalid-api-key` without
// real Firebase env vars, which this unit suite deliberately never needs.
vi.mock('../analytics', () => ({ track: vi.fn() }));
// The four relocated components keep their OWN focused suites (see file
// banner) — stubbed here to plain, order-preserving rows so this suite reads
// the menu's SHAPE without pulling in their Firebase-backed internals.
vi.mock('./ProfileEditor', () => ({ default: () => <button type="button">Profile card</button> }));
vi.mock('./ThemeSwitcher', () => ({ default: () => <div>Theme switcher chips</div> }));
vi.mock('./ItemPool', () => ({ default: () => <div>Suggest-a-square panel</div> }));
vi.mock('./Admin', () => ({ default: () => <div>Admin console</div> }));
vi.mock('./BugReport', () => ({
  default: ({ variant }: { variant?: string }) => (
    <button type="button">{`Report a bug (${variant})`}</button>
  ),
}));
vi.mock('./AcceptableUse', () => ({
  default: ({ variant }: { variant?: string }) => (
    <button type="button">{`18+ guidelines (${variant})`}</button>
  ),
}));
// "How to play" reopens the REAL CoachOverlay (#214) — left un-stubbed so
// the tests below exercise it; it imports EVENT_ID from '../firebase',
// mocked like every other component suite stubs that module.
vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));

import More from './More';

describe('More menu (specs/d15-more-menu.md)', () => {
  it('renders every section/row in spec order for a non-admin Player, with no Admin row', () => {
    H.event = { ...H.event, admins: [] };
    const { container } = render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);

    const order = [
      'Profile card',
      'Theme',
      'Play',
      'Cruise schedule',
      'Suggest a square',
      'How to play',
      'Support',
      'Report a bug (row)',
      '18+ guidelines (row)',
      'Sign out',
    ];
    const text = container.textContent ?? '';
    let cursor = -1;
    for (const marker of order) {
      const idx = text.indexOf(marker);
      expect(idx, `expected to find "${marker}" after cursor ${cursor}`).toBeGreaterThan(cursor);
      cursor = idx;
    }

    // No Admin row for a non-admin Player.
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();

    // Version footer renders, presentational-only.
    expect(text).toMatch(/v[0-9a-f]+/i);
  });

  it('shows no Admin row for a signed-in Player who is not in event.admins', () => {
    H.event = { ...H.event, admins: ['someone-else'] };
    render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();
  });

  it('shows an Admin row with no badge for an admin with zero pending items', () => {
    H.event = { ...H.event, admins: ['player-uid'] };
    H.pendingCount = 0;
    render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);
    const adminRow = screen.getByRole('button', { name: 'Admin' });
    expect(adminRow).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('badges the Admin row with the pending-approvals count for an admin', () => {
    H.event = { ...H.event, admins: ['player-uid'] };
    H.pendingCount = 3;
    render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);
    const adminRow = screen.getByRole('button', { name: /Admin/ });
    expect(adminRow).toHaveTextContent('3');
  });

  it('places Admin between Support and Sign out when present', () => {
    H.event = { ...H.event, admins: ['player-uid'] };
    H.pendingCount = 0;
    const { container } = render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);
    const text = container.textContent ?? '';
    const supportIdx = text.indexOf('18+ guidelines (row)');
    const adminIdx = text.indexOf('Admin');
    const signOutIdx = text.indexOf('Sign out');
    expect(supportIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeGreaterThan(supportIdx);
    expect(signOutIdx).toBeGreaterThan(adminIdx);
  });

  it('redirects an unknown /more subpath to the Card fallback (the splat exists only for admin sub-routes)', () => {
    render(
      <MemoryRouter initialEntries={['/more/bogus']}>
        <Routes>
          <Route path="/more/*" element={<More />} />
          <Route path="/" element={<div data-testid="card-home" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('card-home')).toBeInTheDocument();
  });

  it('calls signOutUser() from useAuth() when Sign out is tapped', async () => {
    H.event = { ...H.event, admins: [] };
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(H.signOutUser).toHaveBeenCalled();
  });
});

// Covers specs/d15-coach-overlay.md's "How to play" replay path (#214).
describe('More menu — "How to play" replays the coach overlay (#214)', () => {
  it('reopens even when dismissed, then a replay dismissal closes it without clearing the flag', async () => {
    const DISMISS_KEY = 'gcb.coachOverlay.test-event.dismissedAt';
    const store = new Map<string, string>([[DISMISS_KEY, '1720000000000']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage);
    H.event = { ...H.event, admins: [] };

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: /How to play/ }));
    // #270: How to play opens the Welcome Aboard WALKTHROUGH panel first; the
    // badge-legend coach overlay is one tap further.
    expect(screen.getByText('How this works')).toBeInTheDocument();
    expect(screen.getByText(/Mark what happens/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show the badge legend/ }));
    expect(screen.getByRole('dialog', { name: 'How to read your card' })).toBeInTheDocument();
    expect(screen.getByText(/Tally count/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Got it—deal me in\./ }));
    expect(screen.queryByRole('dialog', { name: 'How to read your card' })).not.toBeInTheDocument();
    // Still set — a replay dismissal is allowed to refresh the timestamp
    // (the spec's own resolved default) — never cleared.
    expect(store.get(DISMISS_KEY)).not.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
