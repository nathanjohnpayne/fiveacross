import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { EventDoc, ProofDoc } from '../../types';

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
  hideProof: vi.fn(),
  restoreProof: vi.fn(),
  clearProofReports: vi.fn(),
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
    usePendingClaims: () => ({ claims: [] }),
    usePendingItems: () => ({ items: [] }),
    useReportedProofs: () => ({ flagged: H.flagged, loading: false }),
    useAllItems: () => ({ items: [], loading: false }),
  };
});
vi.mock('../../data/admin', () => ({
  confirmClaim: vi.fn(),
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
