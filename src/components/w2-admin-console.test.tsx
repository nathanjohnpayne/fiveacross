import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { EventDoc, ItemDoc, ProofDoc } from '../types';

// specs/w2-admin-console.md, component layer (RTL-jsdom). Drives the REAL Admin
// console with the data boundary (useData hooks + the admin/proofs write modules)
// stubbed. Proves: the report queue is surfaced (via useReportedProofs + the
// reported Prompts derived from useAllItems); a threshold-hidden row is REACHABLE
// there and tagged "auto-hidden" (through the REAL isReportHidden, kept via
// importOriginal, not a re-implementation); the moderation controls on a
// threshold-hidden row invoke the data/admin writes — so an Admin can restore or
// delete content the ADR 0004 Phase 0 community hide removed from every Player's
// Feed. The Admin ban control (#108, consuming the #113 rules) now DOES render on
// each queue row; its behaviour is pinned in depth by
// src/components/w2-ban-console.test.tsx — here we only confirm the control appears
// (the deferred-skip this file once pinned was flipped when #108 landed).

const H = vi.hoisted(() => ({
  user: { uid: 'admin-uid' } as { uid: string } | null,
  event: {
    admins: ['admin-uid'],
    settings: { reportHideThreshold: 4 },
    claimMode: 'honor',
    defaultTheme: 'neon-playground',
  } as unknown as EventDoc,
  claims: [] as unknown[],
  flagged: [] as ProofDoc[],
  items: [] as ItemDoc[],
  hideProof: vi.fn(),
  restoreProof: vi.fn(),
  clearProofReports: vi.fn(),
  hideItem: vi.fn(),
  restoreItem: vi.fn(),
  deleteItem: vi.fn(),
  clearItemReports: vi.fn(),
  deleteProof: vi.fn(),
  confirmClaim: vi.fn(),
  rejectClaim: vi.fn(),
  setClaimMode: vi.fn(),
  setEventTheme: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
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

// Keep the REAL isReportHidden (the auto-hidden boundary under test) — override
// only the subscription hooks the console reads.
vi.mock('../hooks/useData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useData')>();
  return {
    ...actual,
    useEventDoc: () => ({ data: H.event, loading: false, hasServerData: true }),
    usePendingClaims: () => ({ claims: H.claims }),
    useReportedProofs: () => ({ flagged: H.flagged, loading: false }),
    useAllItems: () => ({ items: H.items, loading: false }),
  };
});
vi.mock('../data/admin', () => ({
  confirmClaim: (...a: unknown[]) => H.confirmClaim(...a),
  rejectClaim: (...a: unknown[]) => H.rejectClaim(...a),
  hideProof: (...a: unknown[]) => H.hideProof(...a),
  restoreProof: (...a: unknown[]) => H.restoreProof(...a),
  clearProofReports: (...a: unknown[]) => H.clearProofReports(...a),
  hideItem: (...a: unknown[]) => H.hideItem(...a),
  restoreItem: (...a: unknown[]) => H.restoreItem(...a),
  deleteItem: (...a: unknown[]) => H.deleteItem(...a),
  clearItemReports: (...a: unknown[]) => H.clearItemReports(...a),
  setClaimMode: (...a: unknown[]) => H.setClaimMode(...a),
  setEventTheme: (...a: unknown[]) => H.setEventTheme(...a),
  setDayTheme: vi.fn(),
  // #222 Proof & Claims panel no-op stubs (coverage: Admin.test.tsx).
  setPhotoProofSource: vi.fn(),
  setStripPhotoExif: vi.fn(),
  setVisionGate: vi.fn(),
  setReportHideThreshold: vi.fn(),
  banUser: (...a: unknown[]) => H.banUser(...a),
  unbanUser: (...a: unknown[]) => H.unbanUser(...a),
}));
vi.mock('../data/proofs', () => ({ deleteProof: (...a: unknown[]) => H.deleteProof(...a) }));
// Admin pickers read the EDITION-SCOPED list, not the registry (#555).
vi.mock('../theme/themes', () => {
  const THEMES = [{ id: 'neon-playground', emoji: '🎉', label: 'Neon' }];
  return { THEMES, themesForEdition: () => THEMES, themesForEditionIncluding: () => THEMES };
});
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user }) }));

import Admin from './Admin';

// The report queue is the Reports group of the merged Review queue at
// /more/admin/queue (specs/admin-console-ia.md) — render straight at that route.
const renderAdmin = (path = '/more/admin/queue') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Admin />
    </MemoryRouter>,
  );

const proof = (id: string, reportCount: number, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id,
    uid: `u-${id}`,
    displayName: id,
    photoURL: null,
    type: 'text',
    cellIndex: 0,
    itemText: `prompt ${id}`,
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: 'x',
    createdAt: 1,
    reportCount,
    status: 'active',
    visionFlag: null,
    ...over,
  }) as ProofDoc;

const item = (id: string, reportCount: number, over: Partial<ItemDoc> = {}): ItemDoc =>
  ({
    id,
    text: `prompt ${id}`,
    createdBy: `u-${id}`,
    createdAt: 1,
    isFreeSpace: false,
    status: 'active',
    reportCount,
    spicy: false,
    ...over,
  }) as ItemDoc;

const queue = () => document.querySelector('.admin-section.queue') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'admin-uid' };
  H.event = {
    admins: ['admin-uid'],
    settings: { reportHideThreshold: 4 },
    claimMode: 'honor',
    defaultTheme: 'neon-playground',
  } as unknown as EventDoc;
  H.claims = [];
  H.flagged = [];
  H.items = [];
});

describe('Admin gate', () => {
  it('shows "Admins only." to a non-admin and renders no report queue', () => {
    H.user = { uid: 'rando' };
    renderAdmin();
    expect(screen.getByText(/admins only/i)).toBeInTheDocument();
    expect(queue()).toBeNull();
  });
});

describe('Report queue (specs/w2-admin-console.md)', () => {
  it('lists a reported Proof with its report count', () => {
    H.flagged = [proof('p1', 2, { displayName: 'Barnacle Betty', itemText: 'Wore Crocs to dinner' })];
    renderAdmin();

    const q = within(queue());
    expect(q.getByText(/Reports \(1\)/)).toBeInTheDocument();
    expect(q.getByText('Barnacle Betty')).toBeInTheDocument();
    expect(q.getByText(/2 ⚑/)).toBeInTheDocument();
  });

  it('tags a threshold-hidden row "auto-hidden" and leaves a below-threshold row untagged (real isReportHidden at the boundary)', () => {
    // Threshold is 4: reportCount 4 is AT the threshold (hidden), 2 is below.
    H.flagged = [
      proof('over', 4, { displayName: 'Over Threshold' }),
      proof('under', 2, { displayName: 'Under Threshold' }),
    ];
    renderAdmin();

    const overRow = screen.getByText('Over Threshold').closest('.row') as HTMLElement;
    const underRow = screen.getByText('Under Threshold').closest('.row') as HTMLElement;
    expect(within(overRow).getByText(/auto-hidden/i)).toBeInTheDocument();
    expect(within(underRow).queryByText(/auto-hidden/i)).toBeNull();
  });

  it('restore reaches a threshold-hidden Proof — clicking Restore invokes the data/admin write', () => {
    // A Proof both hard-hidden (status) AND over the community threshold: it is
    // gone from every Player's Feed, yet reachable here so an Admin can restore it.
    H.flagged = [proof('buried', 5, { status: 'hidden', displayName: 'Buried Proof' })];
    renderAdmin();

    const q = within(queue());
    expect(q.getByText(/auto-hidden/i)).toBeInTheDocument(); // 5 ≥ 4
    fireEvent.click(q.getByRole('button', { name: 'Restore' }));
    expect(H.restoreProof).toHaveBeenCalledWith('buried');
  });

  it('deletes a threshold-hidden Proof through the queue', () => {
    H.flagged = [proof('gone', 9, { displayName: 'Deleteme', storagePath: 'proofs/e/u/gone.jpg' })];
    renderAdmin();

    fireEvent.click(within(queue()).getByTitle('Delete'));
    // #246: deleteProof now carries day-scoping opts. This fixture's Event has no
    // `days[]`, so the admin delete is legacy-mode (daily false, no tutorial set).
    expect(H.deleteProof).toHaveBeenCalledWith('gone', 'proofs/e/u/gone.jpg', {
      daily: false,
      tutorialDayIndexes: undefined,
      // #265 (Codex P2 on #278 round 3): the admin delete threads the same
      // freeze/ceremonial gates the player's own delete uses.
      ceremonialDayIndexes: undefined,
      statsFrozen: expect.any(Function),
    });
  });

  it('keeps a hard-hidden ZERO-count Proof reachable with Restore + Delete (clear-then-restore, Codex P2 round 2)', () => {
    // The state Clear reports leaves a doubly-hidden Proof in: count 0, status
    // still 'hidden'. The row must render with Restore + Delete — and with
    // neither the auto-hidden pill nor Clear reports (0 < threshold: no
    // community hide left to mark or lift), just the status hard-hide controls.
    H.flagged = [
      proof('half-lifted', 0, {
        status: 'hidden',
        displayName: 'Half Lifted',
        storagePath: 'proofs/e/u/half-lifted.jpg',
      }),
    ];
    renderAdmin();

    const q = within(queue());
    expect(q.getByText('Half Lifted')).toBeInTheDocument(); // still queued at count 0
    expect(q.queryByText(/auto-hidden/i)).toBeNull();
    expect(q.queryByRole('button', { name: /clear reports/i })).toBeNull();
    fireEvent.click(q.getByRole('button', { name: 'Restore' }));
    expect(H.restoreProof).toHaveBeenCalledWith('half-lifted');
    fireEvent.click(q.getByTitle('Delete'));
    expect(H.deleteProof).toHaveBeenCalledWith('half-lifted', 'proofs/e/u/half-lifted.jpg', {
      ceremonialDayIndexes: undefined,
      statsFrozen: expect.any(Function),
      daily: false,
      tutorialDayIndexes: undefined,
    });
  });

  it('surfaces reported Prompts in the queue and omits unreported ones', () => {
    H.items = [
      item('i1', 3, { text: 'Reported prompt' }),
      item('i2', 0, { text: 'Clean prompt' }),
    ];
    renderAdmin();

    const q = within(queue());
    expect(q.getByText('Reported prompt')).toBeInTheDocument();
    expect(q.queryByText('Clean prompt')).toBeNull(); // unreported, active → not queued
  });

  it('lifts the community auto-hide on a reported Proof — Clear reports resets its reportCount (Codex P2, PR #107 finding 3)', () => {
    // An auto-hidden but status-active Proof: previously the queue offered only
    // Hide, so there was NO way to lift the community auto-hide (the auto-hidden-
    // but-active gap). Clear reports zeroes reportCount so it reappears everywhere.
    H.flagged = [proof('hot', 6, { displayName: 'Hot Proof', status: 'active' })];
    renderAdmin();

    const q = within(queue());
    expect(q.getByText(/auto-hidden/i)).toBeInTheDocument(); // 6 ≥ 4
    fireEvent.click(q.getByRole('button', { name: /clear reports/i }));
    expect(H.clearProofReports).toHaveBeenCalledWith('hot');
  });

  it('lifts the community auto-hide on a reported Prompt — Clear reports resets its reportCount (finding 3)', () => {
    H.items = [item('hot', 6, { text: 'Hot Prompt', status: 'active' })];
    renderAdmin();

    const q = within(queue());
    expect(q.getByText(/auto-hidden/i)).toBeInTheDocument();
    fireEvent.click(q.getByRole('button', { name: /clear reports/i }));
    expect(H.clearItemReports).toHaveBeenCalledWith('hot');
  });

  it('offers NO Clear reports control on a below-threshold row — nothing to lift', () => {
    // reportCount 2 is below the threshold of 4: the row is reported (so it queues)
    // but not auto-hidden, so there is no community hide to lift.
    H.flagged = [proof('mild', 2, { displayName: 'Mild Proof' })];
    renderAdmin();
    expect(within(queue()).queryByRole('button', { name: /clear reports/i })).toBeNull();
  });

  it('orders the mixed Reports group OLDEST-FIRST across kinds (admin-console-ia, superseding the reportCount sort)', () => {
    // The merged Review queue's triage order is arrival order (createdAt asc),
    // uniform with the Approvals and Claims groups — a heavily-reported row no
    // longer jumps the line, it just arrives where it arrived.
    H.flagged = [
      proof('p-new', 1, { displayName: 'ProofNewest', createdAt: 300 }),
      proof('p-old', 5, { displayName: 'ProofOldest', createdAt: 50 }),
    ];
    H.items = [
      item('i-hi', 9, { text: 'ItemHeavy', createdAt: 200 }),
      item('i-mid', 5, { text: 'ItemMiddle', createdAt: 100 }),
    ];
    renderAdmin();

    const labels = Array.from(queue().querySelectorAll('.row .name')).map((n) => n.textContent ?? '');
    const idx = (needle: string) => labels.findIndex((l) => l.includes(needle));
    expect(idx('ProofOldest')).toBe(0); // createdAt 50 leads regardless of counts
    expect(idx('ItemMiddle')).toBe(1); // 100
    expect(idx('ItemHeavy')).toBe(2); // 200 — its 9 reports do not promote it
    expect(idx('ProofNewest')).toBe(3); // 300 last
  });

  it('renders the #108 Ban author control on a queue row (deeper assertions in w2-ban-console.test.tsx)', () => {
    // Flipped from the old deferred-skip pin: the #113 rules landed the bannedUids
    // surface and #108 built the console consumer, so a Ban author control now
    // renders on each queue row.
    H.flagged = [proof('p1', 4, { displayName: 'Someone' })];
    renderAdmin();
    expect(within(queue()).getByRole('button', { name: 'Ban author' })).toBeInTheDocument();
  });
});
