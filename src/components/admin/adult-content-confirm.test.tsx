import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActiveAdultContent } from '../../adultContent';
import { DEFAULT_EDITION, setActiveEdition } from '../../editions';
import ReviewQueue from './ReviewQueue';
import { AdultContentConfirmDialog } from './AdultContentConfirm';
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

const approveItem = vi.fn(async (..._a: unknown[]) => {});
const bulkApproveItems = vi.fn(async () => {});

vi.mock('../../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));
// #559: ReviewQueue now imports `track` (for `prompt_suggestion_approved`),
// so the module graph reaches `../../analytics` — mock it directly rather
// than letting the real module's own `../../firebase` (analyticsReady)
// dependency leak into this suite's mock, the same posture
// ItemPool.test.tsx already takes.
vi.mock('../../analytics', () => ({ track: vi.fn() }));
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
  // Existing assertions use the general register's “Event” wording. Dedicated
  // cases below prove the same component follows another resolved Edition.
  setActiveEdition('fiveacross');
});
afterEach(() => {
  cleanup();
  setActiveAdultContent(true);
  setActiveEdition(DEFAULT_EDITION);
});

describe('resolved Edition register', () => {
  it('uses trip copy and the correct add verb for Vacay Bingo', () => {
    setActiveEdition('vacay');
    render(
      <AdultContentConfirmDialog
        pending={{ reason: 'add', run: vi.fn() }}
        busy={false}
        failed={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText('This makes the whole Trip 18+')).toBeTruthy();
    expect(screen.getByText(/first explicit prompt in this trip\. Adding it means/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add and make this Trip 18+' })).toBeTruthy();
  });
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
    await waitFor(() => expect(approveItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'admin'));
  });

  it('says nothing about a tame Prompt', async () => {
    queue([item('a', false)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'admin'));
    expect(screen.queryByText('This makes the whole Event 18+')).toBeNull();
  });

  it('says nothing on an Event that is ALREADY 18+', async () => {
    // Once the Event is adults-only, approving the second explicit Prompt
    // changes nothing and a confirm is pure noise.
    setActiveAdultContent(true);
    queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'admin'));
    expect(screen.queryByText('This makes the whole Event 18+')).toBeNull();
  });
});

describe('the failure surface (Codex P2 on #615)', () => {
  // `guard()` resolves the caller's AsyncButton the moment the dialog opens, so
  // its inline "Didn't work" affordance is already spent by the time the real
  // write runs. If the dialog closed on rejection, a rules denial would look
  // exactly like a successful approval.
  it('keeps the dialog up and says so when the write rejects', async () => {
    approveItem.mockRejectedValueOnce(new Error('permission-denied'));
    queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: /Approve and make this Event 18\+/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('try again'));
    expect(screen.getByText('This makes the whole Event 18+')).toBeTruthy();
  });

  it('lets the admin retry from the same dialog', async () => {
    approveItem.mockRejectedValueOnce(new Error('permission-denied'));
    queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const confirm = await screen.findByRole('button', { name: /Approve and make this Event 18\+/ });
    fireEvent.click(confirm);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /Approve and make this Event 18\+/ }));
    await waitFor(() => expect(screen.queryByText('This makes the whole Event 18+')).toBeNull());
    expect(approveItem).toHaveBeenCalledTimes(2);
  });
});

describe('the 🔞 tick the snapshot has not caught up with (Codex P2 on #615)', () => {
  // The toggle writes to Firestore and the row re-renders from the NEXT
  // snapshot. An admin who ticks and immediately approves would otherwise hand
  // the guard a stale `false` — and the write that actually flips the Event
  // would skip its confirm.
  it("confirms on the admin's own tick, before the snapshot returns", async () => {
    queue([item('a', false)]);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This makes the whole Event 18+')).toBeTruthy();
    expect(approveItem).not.toHaveBeenCalled();
  });

  it('counts that tick in the bulk confirm too', async () => {
    queue([item('a', false), item('b', false)]);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }));
    expect(await screen.findByText(/1 of the 2 prompts you’re approving is explicit/)).toBeTruthy();
    expect(bulkApproveItems).not.toHaveBeenCalled();
  });
});

// Phase 4b P2. Confirming the LAST pending Prompt removes it from the pending
// query by Firestore's latency compensation — immediately, before the server has
// accepted or rejected — so the queue is empty while the write is still in
// flight. A dialog living below the `!total` early return unmounts right then:
// the admin watches the confirm vanish and "All clear." appear, and a rejection
// takes its own error state down with it. The write silently did not happen, on
// the one action in this console that cannot be undone.
describe('the last pending Prompt (Phase 4b P2)', () => {
  it('keeps the dialog up after the queue empties under it', async () => {
    const { rerender } = queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This makes the whole Event 18+')).toBeTruthy();

    // Latency compensation drops the row; the queue is now empty.
    rerender(
      <ReviewQueue event={null} reports={[]} pendingItems={[]} claims={[]} adminUid="admin" />,
    );
    expect(screen.getByText('This makes the whole Event 18+')).toBeTruthy();
    expect(approveItem).not.toHaveBeenCalled();
  });

  it('still surfaces a rejection after the queue has emptied', async () => {
    approveItem.mockRejectedValueOnce(new Error('permission-denied'));
    const { rerender } = queue([item('a', true)]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: /Approve and make this Event 18\+/ }));
    rerender(
      <ReviewQueue event={null} reports={[]} pendingItems={[]} claims={[]} adminUid="admin" />,
    );
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('try again'),
    );
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
