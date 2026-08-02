import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import type { EventDoc, ItemDoc, ProofDoc } from '../types';

// specs/admin-console-ia.md, component layer (RTL-jsdom). Drives the REAL
// Admin console through its route-driven hub-and-detail IA: the hub's five
// cards and their badge math, card → detail → back → hub navigation, the
// AdminSheet dismissal contract (Done from any depth, Escape, backdrop,
// header swipe-down), the Review queue's mode-gated claims group and
// oldest-first grouping, and the Easy mix slider's squares bubble +
// commit-on-release write. The per-section control behaviors are pinned in
// Admin.test.tsx / w2-admin-console.test.tsx / w2-ban-console.test.tsx /
// w3-claim-modes.test.tsx — this file owns the IA contract itself.

const H = vi.hoisted(() => ({
  user: { uid: 'admin-uid' } as { uid: string } | null,
  event: {} as unknown as EventDoc,
  claims: [] as unknown[],
  flagged: [] as ProofDoc[],
  items: [] as ItemDoc[],
  pendingItems: [] as ItemDoc[],
  setEasyMixRatio: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', storage: {}, auth: {}, googleProvider: {}, analytics: null }));
vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref;
    return ref;
  };
  return {
    doc: (...a: unknown[]) => makeRef('doc', a),
    collection: (...a: unknown[]) => makeRef('collection', a),
    query: (...a: unknown[]) => ({ query: a }),
    where: (...a: unknown[]) => ({ where: a }),
    onSnapshot: vi.fn(() => () => {}),
  };
});
vi.mock('../hooks/useData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useData')>();
  return {
    ...actual,
    useEventDoc: () => ({ data: H.event, loading: false, hasServerData: true }),
    usePendingClaims: () => ({ claims: H.claims }),
    usePendingItems: () => ({ items: H.pendingItems, loading: false }),
    useReportedProofs: () => ({ flagged: H.flagged, loading: false }),
    useAllItems: () => ({ items: H.items, loading: false }),
  };
});
vi.mock('../data/admin', () => ({
  confirmClaim: vi.fn(),
  rejectClaim: vi.fn(),
  hideProof: vi.fn(),
  restoreProof: vi.fn(),
  clearProofReports: vi.fn(),
  hideItem: vi.fn(),
  restoreItem: vi.fn(),
  deleteItem: vi.fn(),
  clearItemReports: vi.fn(),
  approveItem: vi.fn(),
  rejectItem: vi.fn(),
  bulkApproveItems: vi.fn(),
  setItemSpicy: vi.fn(),
  adminAddItem: vi.fn(),
  adminUpdateItemText: vi.fn(),
  setClaimMode: vi.fn(),
  setEventTheme: vi.fn(),
  setDayTheme: vi.fn(),
  setDayTonight: vi.fn(),
  setPhotoProofSource: vi.fn(),
  setStripPhotoExif: vi.fn(),
  setVisionGate: vi.fn(),
  setReportHideThreshold: vi.fn(),
  setEasyMixRatio: (...a: unknown[]) => H.setEasyMixRatio(...a),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  unlockDayNow: vi.fn(),
  resnapshotDayNow: vi.fn(),
}));
vi.mock('../data/proofs', () => ({ deleteProof: vi.fn() }));
vi.mock('../theme/themes', () => ({ THEMES: [{ id: 'neon-playground', emoji: '🎉', label: 'Neon' }] }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user }) }));

import Admin from './Admin';

// A location probe alongside the console so navigation assertions can read
// where the router actually landed (Done → /more, back → the hub), plus a
// browser-back trigger so history-shape assertions can walk the real stack.
// The console renders unconditionally under /more/* here — More's own render
// gate (adminSectionFromPath) is pinned in d15-more-menu.test.tsx.
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <button data-testid="browser-back" onClick={() => navigate(-1)} />
    </>
  );
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/more/*"
          element={
            <>
              <Admin />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const at = () => screen.getByTestId('location').textContent;

const proof = (id: string, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id,
    uid: `u-${id}`,
    displayName: id,
    type: 'text',
    cellIndex: 0,
    itemText: `prompt ${id}`,
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: 'x',
    createdAt: 1,
    reportCount: 1,
    status: 'active',
    visionFlag: null,
    ...over,
  }) as ProofDoc;

const item = (id: string, over: Partial<ItemDoc> = {}): ItemDoc =>
  ({
    id,
    text: `prompt ${id}`,
    createdBy: `u-${id}`,
    createdAt: 1,
    isFreeSpace: false,
    status: 'pending',
    reportCount: 0,
    spicy: false,
    pool: 'main',
    ...over,
  }) as ItemDoc;

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'admin-uid' };
  H.event = {
    admins: ['admin-uid'],
    settings: { reportHideThreshold: 4 },
    claimMode: 'admin_confirmed',
    defaultTheme: 'neon-playground',
    bannedUids: [],
    days: [],
  } as unknown as EventDoc;
  H.claims = [];
  H.flagged = [];
  H.items = [];
  H.pendingItems = [];
});

describe('Admin hub (specs/admin-console-ia.md)', () => {
  it('renders six section cards with the merged-inbox badge math (2 reports + 3 approvals + 2 claims = 7)', () => {
    H.flagged = [proof('r1'), proof('r2')];
    H.pendingItems = [item('a1'), item('a2'), item('a3')];
    H.claims = [
      { id: 'c1', displayName: 'Alice', itemText: 'x' } as never,
      { id: 'c2', displayName: 'Bob', itemText: 'y' } as never,
    ];
    renderAt('/more/admin');

    for (const title of ['Review queue', 'Game settings', 'Schedule', 'Prompt pool', 'Players', 'Messages']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    const queueCard = screen.getByText('Review queue').closest('.more-row') as HTMLElement;
    expect(within(queueCard).getByText('7')).toBeInTheDocument();
    expect(within(queueCard).getByText(/Reports 2 · Approvals 3 · Claims 2/)).toBeInTheDocument();
  });

  it('excludes claims from the badge and subtitle outside admin-confirmed mode', () => {
    H.event = { ...H.event, claimMode: 'honor' } as unknown as EventDoc;
    H.flagged = [proof('r1')];
    H.pendingItems = [item('a1')];
    H.claims = [{ id: 'c1', displayName: 'Alice', itemText: 'x' } as never];
    renderAt('/more/admin');

    const queueCard = screen.getByText('Review queue').closest('.more-row') as HTMLElement;
    expect(within(queueCard).getByText('2')).toBeInTheDocument();
    expect(within(queueCard).queryByText(/Claims/)).toBeNull();
  });

  it('badges the Prompt pool card with the pending count', () => {
    H.items = [item('p1'), item('p2', { status: 'active' })];
    renderAt('/more/admin');
    const poolCard = screen.getByText('Prompt pool').closest('.more-row') as HTMLElement;
    expect(within(poolCard).getByText('1')).toBeInTheDocument();
    expect(within(poolCard).getByText(/2 prompts/)).toBeInTheDocument();
  });

  it('walks card → detail → ‹ Admin back → hub, with the sticky header on every surface', () => {
    renderAt('/more/admin');
    expect(document.querySelector('.admin-sheet-head')).not.toBeNull();

    fireEvent.click(screen.getByText('Game settings').closest('.more-row') as HTMLElement);
    expect(at()).toBe('/more/admin/settings');
    expect(screen.getByRole('dialog', { name: 'Game settings' })).toBeInTheDocument();
    expect(document.querySelector('.admin-sheet-head')).not.toBeNull();
    // Detail surfaces carry the ‹ Admin back affordance; the hub does not.
    fireEvent.click(screen.getByRole('button', { name: 'Admin' }));
    expect(at()).toBe('/more/admin');
    expect(screen.getByRole('dialog', { name: 'Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();
  });

  it('opens the Messages door and routes to /more/admin/messages under the dismissal contract', () => {
    renderAt('/more/admin');
    fireEvent.click(screen.getByText('Messages').closest('.more-row') as HTMLElement);
    expect(at()).toBe('/more/admin/messages');
    expect(screen.getByRole('dialog', { name: 'Messages' })).toBeInTheDocument();
    // Compose surface is present…
    expect(screen.getByRole('button', { name: 'Post to everyone' })).toBeInTheDocument();
    // …and Done from the detail closes the whole admin to /more.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(at()).toBe('/more');
  });

  it('an unknown section deep link lands on the hub, and a non-admin gets a dismissible "Admins only." sheet', () => {
    const first = renderAt('/more/admin/bogus');
    expect(screen.getByRole('dialog', { name: 'Admin' })).toBeInTheDocument();
    first.unmount();

    H.user = { uid: 'rando' };
    renderAt('/more/admin/settings');
    expect(screen.getByText(/admins only/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(at()).toBe('/more');
  });
});

describe('AdminSheet dismissal contract (specs/admin-console-ia.md)', () => {
  it('Done closes the entire admin from any depth — one tap from a detail lands on /more', () => {
    renderAt('/more/admin/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(at()).toBe('/more');
  });

  it('Escape dismisses', () => {
    renderAt('/more/admin/queue');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(at()).toBe('/more');
  });

  it('backdrop tap dismisses; a tap inside the sheet does not', () => {
    renderAt('/more/admin');
    fireEvent.click(screen.getByRole('dialog', { name: 'Admin' }));
    expect(at()).toBe('/more/admin');
    fireEvent.click(document.querySelector('.sheet-backdrop') as HTMLElement);
    expect(at()).toBe('/more');
  });

  it('Done pops the whole admin run when entered from More — browser Back cannot reopen it', () => {
    // The More row seeds adminPops: 1 (More.tsx); each hub → detail push
    // increments it, and Done pops that many entries in one go.
    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/more' }, { pathname: '/more/admin', state: { adminPops: 1 } }]}
        initialIndex={1}
      >
        <Routes>
          <Route
            path="/more/*"
            element={
              <>
                <Admin />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Game settings').closest('.more-row') as HTMLElement);
    expect(at()).toBe('/more/admin/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(at()).toBe('/more');
    // The hub and detail entries were POPPED, not buried — Back stays put.
    fireEvent.click(screen.getByTestId('browser-back'));
    expect(at()).toBe('/more');
  });

  it('a deep-link admin session occupies ONE history entry — Done leaves no admin entry for Back to reopen', () => {
    // Deep-linked hub (no adminPops): opening a detail REPLACES in place, so
    // after Done replaces with /more the stack holds no admin entry at all
    // (Phase 4b P2, PR #410).
    renderAt('/more/admin');
    fireEvent.click(screen.getByText('Game settings').closest('.more-row') as HTMLElement);
    expect(at()).toBe('/more/admin/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(at()).toBe('/more');
    fireEvent.click(screen.getByTestId('browser-back'));
    expect(at()).toBe('/more');
  });

  it('a swipe-down on the header dismisses; a short drag does not', () => {
    renderAt('/more/admin/schedule');
    const head = document.querySelector('.admin-sheet-head') as HTMLElement;
    // jsdom lacks a full PointerEvent — dispatch MouseEvent-backed pointer
    // events (via fireEvent, so React state updates flush) so clientY rides.
    const drag = (type: string, clientY: number) =>
      fireEvent(head, new MouseEvent(type, { bubbles: true, clientY }));
    drag('pointerdown', 40);
    drag('pointerup', 70); // 30px — below the 80px threshold
    expect(at()).toBe('/more/admin/schedule');
    drag('pointerdown', 40);
    drag('pointerup', 160); // 120px — dismisses
    expect(at()).toBe('/more');
  });
});

describe('Review queue grouping (specs/admin-console-ia.md)', () => {
  it('shows the three groups oldest-first with the claims group present in admin-confirmed mode', () => {
    H.flagged = [proof('r-new', { displayName: 'ReportNew', createdAt: 300 }), proof('r-old', { displayName: 'ReportOld', createdAt: 10 })];
    H.pendingItems = [item('a1', { text: 'Approval one' })];
    H.claims = [{ id: 'c1', displayName: 'Alice', itemText: 'x' } as never];
    renderAt('/more/admin/queue');

    expect(screen.getByText(/Reports \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Approvals \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Pending claims \(1\)/)).toBeInTheDocument();
    const names = Array.from(document.querySelectorAll('.admin-section.queue .row .name')).map((n) => n.textContent ?? '');
    expect(names[0]).toContain('ReportOld');
    expect(names[1]).toContain('ReportNew');
  });
});
