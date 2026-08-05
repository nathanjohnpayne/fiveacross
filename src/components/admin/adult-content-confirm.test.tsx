import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActiveAdultContent } from '../../adultContent';
import ReviewQueue from './ReviewQueue';
import type { ItemDoc } from '../../types';

// Covers the confirm that stands between an admin action and an Event turning
// 18+ (#610's admin half, required by #608's acceptance: "the flip is never
// silent — this ticket must not ship the flag without it").
//
// The one thing to get right, and the one the obvious implementation gets wrong:
// the confirm belongs on the ADMIN's approve, not on the player's checkbox. A
// player checking 🔞 writes `status: 'pending'`, and the derivation only counts
// `active` — so the box is a REQUEST, and warning there would put a consequence
// notice on the one action that has none.

const approveItem = vi.fn(async () => {});
const bulkApproveItems = vi.fn(async () => {});

vi.mock('../../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));
vi.mock('../../data/admin', () => ({
  approveItem: (...a: unknown[]) => approveItem(...(a as [])),
  bulkApproveItems: (...a: unknown[]) => bulkApproveItems(...(a as [])),
  rejectItem: vi.fn(),
  setItemSpicy: vi.fn(),
  confirmClaim: vi.fn(),
  rejectClaim: vi.fn(),
  hideProof: vi.fn(),
  restoreProof: vi.fn(),
  clearProofReports: vi.fn(),
  hideItem: vi.fn(),
  restoreItem: vi.fn(),
  deleteItem: vi.fn(),
  clearItemReports: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
}));
vi.mock('../../data/proofs', () => ({ deleteProof: vi.fn() }));

const item = (id: string, spicy: boolean): ItemDoc =>
  ({
    id,
    text: `prompt ${id}`,
    createdBy: 'player',
    createdAt: 1,
    isFreeSpace: false,
    status: 'pending',
    reportCount: 0,
    spicy,
    pool: 'main',
  }) as ItemDoc;

function queue(pendingItems: ItemDoc[]) {
  return render(
    <ReviewQueue event={null} reports={[]} pendingItems={pendingItems} claims={[]} adminUid="admin" />,
  );
}

beforeEach(() => {
  approveItem.mockClear();
  bulkApproveItems.mockClear();
  // The interesting posture: an Event that is NOT yet 18+, so the next explicit
  // approval is the flip.
  setActiveAdultContent(false);
});
afterEach(() => {
  cleanup();
  setActiveAdultContent(true);
});

describe('approving the first explicit Prompt', () => {
  it('names the consequence before writing anything', async () => {
    queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This makes the whole Event 18+')).toBeTruthy();
    expect(screen.getByText(/every player is asked to confirm/)).toBeTruthy();
    expect(screen.getByText(/can't be undone/)).toBeTruthy();
    // NOTHING has been written yet — the action is parked, not raced.
    expect(approveItem).not.toHaveBeenCalled();
  });

  it('leaves the Prompt pending when the admin cancels', async () => {
    queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('This makes the whole Event 18+')).toBeNull());
    expect(approveItem).not.toHaveBeenCalled();
  });

  it('writes once the admin confirms', async () => {
    queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: /Approve and make this Event 18\+/ }));
    await waitFor(() => expect(approveItem).toHaveBeenCalledWith('a', 'admin'));
  });

  it('says nothing about a tame Prompt', async () => {
    queue([item('a', false)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveItem).toHaveBeenCalledWith('a', 'admin'));
    expect(screen.queryByText('This makes the whole Event 18+')).toBeNull();
  });

  it('says nothing on an Event that is ALREADY 18+', async () => {
    // Once the Event is adults-only, approving the second explicit Prompt
    // changes nothing and a confirm is pure noise.
    setActiveAdultContent(true);
    queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveItem).toHaveBeenCalledWith('a', 'admin'));
    expect(screen.queryByText('This makes the whole Event 18+')).toBeNull();
  });
});

describe('bulk approve — the easy one to miss', () => {
  it('confirms, and names the explicit count out of the batch', async () => {
    queue([item('a', false), item('b', true), item('c', false)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }));
    expect(await screen.findByText('This makes the whole Event 18+')).toBeTruthy();
    expect(screen.getByText(/1 of the 3 prompts you’re approving is explicit/)).toBeTruthy();
    expect(bulkApproveItems).not.toHaveBeenCalled();
  });

  it('applies NONE of the batch on cancel — never a partial apply', async () => {
    queue([item('a', false), item('b', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('This makes the whole Event 18+')).toBeNull());
    expect(bulkApproveItems).not.toHaveBeenCalled();
    expect(approveItem).not.toHaveBeenCalled();
  });

  it('goes straight through when nothing in the batch is explicit', async () => {
    queue([item('a', false), item('b', false)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }));
    await waitFor(() => expect(bulkApproveItems).toHaveBeenCalled());
    expect(screen.queryByText('This makes the whole Event 18+')).toBeNull();
  });
});
