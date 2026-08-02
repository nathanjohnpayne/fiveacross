import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router';
import type { EventDoc } from '../types';
import type { Cell } from '../types';

// Covers specs/d15-icons-lucide.md (#220) — lucide-react adopted for chrome
// and controls (tab bar, More menu rows, the claim sheet, the locked-Day
// badge, BugReport's trigger icon), emoji left untouched everywhere else.
//
// All `vi.mock` calls live at module top level (not inside `describe`
// blocks) — Vitest's hoisting only reliably lifts top-level calls above
// imports, matching every other suite in this repo (see d15-more-menu.test
// and w4-bug-report-inbox.test). The mocked modules don't overlap across
// the components under test here, so one shared mock set is safe.

const H = vi.hoisted(() => ({
  user: { uid: 'player-uid' } as { uid: string } | null,
  event: {
    name: 'Test Cruise',
    sailStart: '2027-01-01',
    sailEnd: '2027-01-08',
    admins: ['player-uid'] as string[],
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
  // `deferred` set so the Install row renders (it's hidden once standalone).
  useInstallPrompt: () => ({ standalone: false, deferred: () => {}, showIOSHint: false, install: vi.fn() }),
}));
vi.mock('./ProfileEditor', () => ({ default: () => <button type="button">Profile card</button> }));
vi.mock('./ThemeSwitcher', () => ({ default: () => <div>Theme switcher chips</div> }));
vi.mock('./ItemPool', () => ({ default: () => <div>Suggest-a-square panel</div> }));
vi.mock('./Admin', () => ({ default: () => <div>Admin console</div> }));
vi.mock('./BugReport', () => ({
  default: ({ variant }: { variant?: string }) => <button type="button">{`Report a bug (${variant})`}</button>,
}));
vi.mock('./AcceptableUse', () => ({
  default: ({ variant }: { variant?: string }) => <button type="button">{`18+ guidelines (${variant})`}</button>,
}));
vi.mock('../data/proofs', () => ({ attachProof: vi.fn() }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../data/bugReports', () => ({
  BUG_REPORT_DESCRIPTION_MAX: 4000,
  captureAppSurface: vi.fn(),
  submitBugReport: vi.fn(),
  blobToDataUrl: vi.fn(),
  buildBugReportInput: vi.fn((value: unknown) => value),
}));
// "How to play" reopens the REAL CoachOverlay (#214, merged in from main) —
// left un-stubbed so the More-menu row-icon test below still exercises its
// real DOM; it imports EVENT_ID from '../firebase', mocked here like every
// other component suite stubs that module (see d15-more-menu.test.tsx).
vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));

import TabBar from './TabBar';

describe('TabBar (specs/d15-icons-lucide.md)', () => {
  it('renders Card/Feed/Ranks with their Lucide icons, not plain text or emoji', () => {
    render(
      <MemoryRouter>
        <TabBar morePhotoURL={null} />
      </MemoryRouter>,
    );
    // Each non-More tab shows a `.tab-icon` <svg> ahead of its label.
    const cardLink = screen.getByRole('link', { name: /card/i });
    const feedLink = screen.getByRole('link', { name: /feed/i });
    const ranksLink = screen.getByRole('link', { name: /ranks/i });
    expect(cardLink.querySelector('svg.tab-icon')).toBeTruthy();
    expect(feedLink.querySelector('svg.tab-icon')).toBeTruthy();
    expect(ranksLink.querySelector('svg.tab-icon')).toBeTruthy();
  });

  it('renders the signed-out More tab as a Lucide ellipsis icon, not a literal "⋯" character', () => {
    render(
      <MemoryRouter>
        <TabBar morePhotoURL={null} />
      </MemoryRouter>,
    );
    const moreLink = screen.getByRole('link', { name: 'More' });
    const ellipsisIcon = moreLink.querySelector('svg.tab-ellipsis');
    expect(ellipsisIcon).toBeTruthy();
    expect(moreLink.textContent).not.toContain('⋯');
    // #297: the accessible name comes from the visible "More" caption under
    // the glyph — same shape as Card/Feed/Ranks — not from an aria-label.
    expect(moreLink.textContent).toContain('More');
    expect(moreLink.getAttribute('aria-label')).toBeNull();
  });
});

describe('More menu row icons (specs/d15-icons-lucide.md)', () => {
  it('gives every sub-panel row a leading icon and a trailing chevron; Install/Sign out get an icon but no chevron', async () => {
    const { default: More } = await import('./More');
    render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);

    for (const name of ['Cruise schedule', 'Suggest a square', 'How to play', 'Admin']) {
      const row = screen.getByRole('button', { name: new RegExp(name) });
      expect(row.querySelector('svg.more-row-icon'), `${name} icon`).toBeTruthy();
      expect(row.querySelector('svg.more-row-chevron'), `${name} chevron`).toBeTruthy();
    }

    const install = screen.getByRole('button', { name: /install the app/i });
    expect(install.querySelector('svg.more-row-icon')).toBeTruthy();
    expect(install.querySelector('svg.more-row-chevron')).toBeNull();

    const signOut = screen.getByRole('button', { name: 'Sign out' });
    expect(signOut.querySelector('svg.more-row-icon')).toBeTruthy();
    expect(signOut.querySelector('svg.more-row-chevron')).toBeNull();
  });

  it('gives the Theme section header a leading Palette icon', async () => {
    const { default: More } = await import('./More');
    const { container } = render(<MemoryRouter initialEntries={['/more']}><More /></MemoryRouter>);
    const themeHeading = Array.from(container.querySelectorAll('h3')).find((h) => h.textContent?.includes('Theme'));
    expect(themeHeading?.querySelector('svg.more-section-icon')).toBeTruthy();
  });
});

describe('ProofSheet claim-sheet icons (specs/d15-icons-lucide.md)', () => {
  const cell: Cell = { index: 0, itemId: 'item-1', text: 'Do a thing', free: false, marked: false, markedAt: null };

  it('renders a Lucide glyph on each segment and photo affordance', async () => {
    const { default: ProofSheet } = await import('./ProofSheet');
    const { container } = render(
      <ProofSheet
        uid="u1"
        displayName="Deck Daddy"
        photoURL={null}
        cells={[cell]}
        cell={cell}
        claimMode="honor"
        currentFirstBingoAt={null}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('svg.seg-btn-icon')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: /photo/i }));
    expect(container.querySelectorAll('svg.photo-affordance-icon').length).toBeGreaterThan(0);
  });

  it('renders an icon-only dismiss control that closes the sheet like Cancel does', async () => {
    const { default: ProofSheet } = await import('./ProofSheet');
    const onClose = vi.fn();
    render(
      <ProofSheet
        uid="u1"
        displayName="Deck Daddy"
        photoURL={null}
        cells={[cell]}
        cell={cell}
        claimMode="honor"
        currentFirstBingoAt={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('BugReport icon (specs/d15-icons-lucide.md)', () => {
  it('renders the Lucide Bug glyph as .bug-report-icon in the row variant', async () => {
    // The More-menu block above renders `./More`, which imports `./BugReport`
    // and caches the hoisted `vi.mock('./BugReport')` stub in the module
    // registry. `vi.doUnmock()` only stops future resolutions from using the
    // mock — it doesn't evict the already-cached mocked instance — so without
    // `vi.resetModules()` the dynamic import below would silently re-import
    // the cached stub instead of the real component.
    vi.doUnmock('./BugReport');
    vi.resetModules();
    // The launcher requires the app-shell provider since #324 (the sheet and
    // capture flow render from BugReportProvider, not the trigger).
    const { default: BugReport, BugReportProvider } = await import('./BugReport');
    render(
      <BugReportProvider>
        <BugReport variant="row" />
      </BugReportProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Report a bug' });
    const icon = trigger.querySelector('svg.bug-report-icon');
    expect(icon).toBeTruthy();
    // A lucide icon carries its stroke/path data as <path>/<line> children —
    // a hand-inlined single-path glyph would only ever have exactly one.
    expect(icon!.children.length).toBeGreaterThan(0);
  });
});

describe('No duplicated hand-inlined SVGs (specs/d15-icons-lucide.md)', () => {
  it('BugReport.tsx no longer defines its own bug-shaped <svg> path data', () => {
    const dir = join(process.cwd(), 'src/components');
    const bugReportSrc = readFileSync(join(dir, 'BugReport.tsx'), 'utf8');
    // The old hand-inlined bug glyph's signature path data — if this string
    // reappears, someone reintroduced the duplicate this ticket retired.
    expect(bugReportSrc).not.toContain('M12 20v-9M14 7a4 4 0 0 1 4 4v3a6');
    // Sanity: the directory read succeeds and BugReport.tsx is really there.
    expect(readdirSync(dir)).toContain('BugReport.tsx');
  });
});
