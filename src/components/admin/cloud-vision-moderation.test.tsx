import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ClaimDoc, EventDoc, ProofDoc } from '../../types';

// specs/cloud-vision-moderation.md, component layer (RTL-jsdom). Drives the REAL
// admin Review queue with the data boundary stubbed, and pins the Vision
// treatment #133 adds: a Vision-flagged Proof carries its REASON on the row, a
// Vision-hidden one is marked hidden and offers Restore, and the report-count
// auto-hide keeps its own distinct pill and its own distinct lift (Clear
// reports). The REAL isReportHidden is kept via importOriginal so the two
// mechanisms are compared at their real boundaries, not against a
// re-implementation.

const H = vi.hoisted(() => ({
  user: { uid: 'admin-uid' } as { uid: string } | null,
  event: {
    admins: ['admin-uid'],
    settings: { reportHideThreshold: 4 },
    claimMode: 'honor',
    defaultTheme: 'neon-playground',
  } as unknown as EventDoc,
  flagged: [] as ProofDoc[],
  claims: [] as ClaimDoc[],
  hideProof: vi.fn(),
  restoreProof: vi.fn(),
  clearProofReports: vi.fn(),
  confirmClaim: vi.fn(),
}));

vi.mock('../../firebase', () => ({ db: {}, EVENT_ID: 'test-event', storage: {}, auth: {}, googleProvider: {}, analytics: null }));
vi.mock('../../analytics', () => ({ track: vi.fn() }));
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
vi.mock('../../hooks/useData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useData')>();
  return {
    ...actual,
    useEventDoc: () => ({ data: H.event, loading: false, hasServerData: true }),
    usePendingClaims: () => ({ claims: H.claims }),
    usePendingItems: () => ({ items: [] }),
    useReportedProofs: () => ({ flagged: H.flagged, loading: false }),
    useAllItems: () => ({ items: [], loading: false }),
  };
});
vi.mock('../../data/admin', () => ({
  confirmClaim: (...a: unknown[]) => H.confirmClaim(...a),
  rejectClaim: vi.fn(),
  hideProof: (...a: unknown[]) => H.hideProof(...a),
  restoreProof: (...a: unknown[]) => H.restoreProof(...a),
  clearProofReports: (...a: unknown[]) => H.clearProofReports(...a),
  hideItem: vi.fn(),
  restoreItem: vi.fn(),
  deleteItem: vi.fn(),
  clearItemReports: vi.fn(),
  approveItem: vi.fn(),
  rejectItem: vi.fn(),
  bulkApproveItems: vi.fn(),
  setItemSpicy: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
}));
vi.mock('../../data/proofs', () => ({ deleteProof: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user }) }));

import Admin from '../Admin';

const renderQueue = () =>
  render(
    <MemoryRouter initialEntries={['/more/admin/queue']}>
      <Admin />
    </MemoryRouter>,
  );

const proof = (id: string, reportCount: number, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id,
    uid: `u-${id}`,
    displayName: id,
    photoURL: null,
    type: 'photo',
    cellIndex: 0,
    itemText: `prompt ${id}`,
    storagePath: `proofs/e/u/${id}.jpg`,
    mediaURL: null,
    thumbURL: null,
    text: null,
    createdAt: 1,
    reportCount,
    status: 'active',
    visionFlag: null,
    ...over,
  }) as ProofDoc;

const rowFor = (displayName: string) =>
  within(screen.getByText(displayName).closest('.row') as HTMLElement);

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'admin-uid' };
  H.flagged = [];
  H.claims = [];
  H.event = {
    admins: ['admin-uid'],
    settings: { reportHideThreshold: 4 },
    claimMode: 'honor',
    defaultTheme: 'neon-playground',
  } as unknown as EventDoc;
});

describe('Review queue — the Vision treatment (specs/cloud-vision-moderation.md)', () => {
  it('marks a Vision-hidden Proof as hidden WITH its reason, and offers Restore', () => {
    H.flagged = [proof('vh', 0, { displayName: 'Vision Hidden', status: 'hidden', visionFlag: 'violence' })];
    renderQueue();

    const row = rowFor('Vision Hidden');
    expect(row.getByText('hidden · AI screen: violence')).toBeInTheDocument();
    // The reason pill is the hidden-state pill, not a bare enum echo.
    expect(row.queryByText('violence')).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Restore' }));
    expect(H.restoreProof).toHaveBeenCalledWith('vh');
  });

  it('says what Restore is about to undo when an AI verdict stands', () => {
    H.flagged = [proof('vh', 0, { displayName: 'Vision Hidden', status: 'hidden', visionFlag: 'extreme' })];
    renderQueue();

    expect(rowFor('Vision Hidden').getByRole('button', { name: 'Restore' })).toHaveAttribute(
      'title',
      'Put this proof back in the Feed. The AI screen flagged it: extreme.',
    );
  });

  it('carries no such warning on a plain report-count Restore — there is no AI verdict to undo', () => {
    H.flagged = [proof('rh', 6, { displayName: 'Report Hidden', status: 'hidden' })];
    renderQueue();

    expect(rowFor('Report Hidden').getByRole('button', { name: 'Restore' })).not.toHaveAttribute('title');
  });

  it('shows the reason WITHOUT the hidden marker while a flagged Proof is still awaiting its hide', () => {
    // The window between moderateProof's flag write and hideProofOnVisionFlag's
    // hide — and the state a merely-racy verdict would never leave (nothing racy
    // is ever flagged), so the row offers Hide, not Restore.
    H.flagged = [proof('fl', 0, { displayName: 'Just Flagged', status: 'flagged', visionFlag: 'violence' })];
    renderQueue();

    const row = rowFor('Just Flagged');
    expect(row.getByText('AI screen: violence')).toBeInTheDocument();
    expect(row.queryByText(/hidden · AI screen/)).toBeNull();
    expect(row.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('keeps the AI reason on a Proof an admin restored, so the override stays visible', () => {
    // restoreProof leaves visionFlag set; the row must still say what was overridden
    // (and the Function will not re-hide it — the Proof is no longer flagged).
    H.flagged = [proof('ov', 0, { displayName: 'Overridden', status: 'active', visionFlag: 'violence' })];
    renderQueue();

    const row = rowFor('Overridden');
    expect(row.getByText('AI screen: violence')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
  });

  it('keeps the report-count hide DISTINCT: auto-hidden + Clear reports, and no AI pill', () => {
    H.flagged = [proof('rc', 6, { displayName: 'Over Threshold' })];
    renderQueue();

    const row = rowFor('Over Threshold');
    expect(row.getByText(/auto-hidden/i)).toBeInTheDocument();
    expect(row.queryByText(/AI screen/)).toBeNull();
    fireEvent.click(row.getByRole('button', { name: /clear reports/i }));
    expect(H.clearProofReports).toHaveBeenCalledWith('rc');
  });

  it('shows BOTH mechanisms on a Proof that is over the threshold AND AI-flagged', () => {
    // Truthful rather than causal: the row states the report bar was crossed and
    // the AI screen returned a verdict, without claiming which one hid it.
    H.flagged = [proof('both', 9, { displayName: 'Doubly Flagged', status: 'hidden', visionFlag: 'violence' })];
    renderQueue();

    const row = rowFor('Doubly Flagged');
    expect(row.getByText('hidden · AI screen: violence')).toBeInTheDocument();
    expect(row.getByText(/auto-hidden/i)).toBeInTheDocument();
    expect(row.getByRole('button', { name: /clear reports/i })).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('never marks a merely-racy verdict as hidden — raciness reaches the queue as a reason only', () => {
    // ADR 0004: the app is intentionally racy. Nothing auto-hides for raciness, so
    // a hypothetical racy verdict leaves an ACTIVE Proof carrying only its reason.
    H.flagged = [proof('racy', 0, { displayName: 'Racy Proof', status: 'active', visionFlag: 'racy' })];
    renderQueue();

    const row = rowFor('Racy Proof');
    expect(row.getByText('AI screen: racy')).toBeInTheDocument();
    expect(row.queryByText(/hidden/)).toBeNull();
    expect(row.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
  });
});

// --- Pending claims: the Confirm that no longer un-hides ---------------------

const claim = (over: Partial<ClaimDoc> = {}): ClaimDoc =>
  ({
    id: 'claim-1',
    uid: 'u-1',
    displayName: 'Deck Daddy',
    cellIndex: 4,
    itemText: 'Saw a sailor in Speedos',
    proofId: 'P',
    status: 'pending',
    createdAt: 1,
    resolvedBy: null,
    ...over,
  }) as ClaimDoc;

/** The admin_confirmed Event whose console shows the Pending claims group. */
const adminConfirmedEvent = () => {
  H.event = {
    admins: ['admin-uid'],
    settings: { reportHideThreshold: 4 },
    claimMode: 'admin_confirmed',
    defaultTheme: 'neon-playground',
  } as unknown as EventDoc;
};

describe('Pending claims — a Vision-held photo is named on the row (specs/cloud-vision-moderation.md)', () => {
  it('says the photo stays hidden, and names the verdict, when a Vision hide stands on it', () => {
    // `confirmClaim` (src/data/admin.ts) deliberately does NOT publish this
    // Proof, so the row must say so: the Confirm control shows only the
    // submitter and the Prompt, and is not the warned moderation Restore.
    adminConfirmedEvent();
    H.flagged = [proof('P', 0, { displayName: 'Held Photo', status: 'hidden', visionFlag: 'violence' })];
    H.claims = [claim()];
    renderQueue();

    const row = rowFor('Deck Daddy');
    expect(row.getByText('hidden · AI screen: violence')).toBeInTheDocument();
    expect(
      row.getByText('Confirming credits the mark; the photo stays hidden for moderation.'),
    ).toBeInTheDocument();
  });

  it('says the same while the Proof is still FLAGGED and the hide has not landed yet', () => {
    adminConfirmedEvent();
    H.flagged = [proof('P', 0, { displayName: 'Held Photo', status: 'flagged', visionFlag: 'extreme' })];
    H.claims = [claim()];
    renderQueue();

    const row = rowFor('Deck Daddy');
    expect(row.getByText('hidden · AI screen: extreme')).toBeInTheDocument();
    expect(row.getByText(/the photo stays hidden for moderation/)).toBeInTheDocument();
  });

  it('leaves an ordinary claim unannotated — Confirm still publishes its pending Proof', () => {
    adminConfirmedEvent();
    H.claims = [claim()];
    renderQueue();

    const row = rowFor('Deck Daddy');
    expect(row.queryByText(/AI screen/)).toBeNull();
    expect(row.queryByText(/stays hidden for moderation/)).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Confirm' }));
    expect(H.confirmClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'claim-1' }), 'admin-uid');
  });

  it('leaves a merely-racy verdict unannotated — nothing withholds the photo for raciness', () => {
    // ADR 0004 again, on the claim side: a racy verdict is not a safety hide, so
    // the confirm publishes exactly as it always did and the row says nothing.
    adminConfirmedEvent();
    H.flagged = [proof('P', 0, { displayName: 'Racy Photo', status: 'hidden', visionFlag: 'racy' })];
    H.claims = [claim()];
    renderQueue();

    expect(rowFor('Deck Daddy').queryByText(/stays hidden for moderation/)).toBeNull();
  });

  it('annotates only the claim whose OWN proofId carries the verdict', () => {
    adminConfirmedEvent();
    H.flagged = [proof('P', 0, { displayName: 'Held Photo', status: 'hidden', visionFlag: 'violence' })];
    H.claims = [claim(), claim({ id: 'claim-2', displayName: 'Pool Boy', proofId: 'Q' })];
    renderQueue();

    expect(rowFor('Deck Daddy').getByText(/stays hidden for moderation/)).toBeInTheDocument();
    expect(rowFor('Pool Boy').queryByText(/stays hidden for moderation/)).toBeNull();
  });
});
