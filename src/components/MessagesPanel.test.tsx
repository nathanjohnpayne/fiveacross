import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DayDef, NoticeDoc } from '../types';

// specs/admin-messages.md (#439), component layer. MessagesPanel isolated behind
// focused mocks — the three notice writers, the two data hooks, the identity/day
// helpers — so the compose + history behavior tests without Firestore.

const H = vi.hoisted(() => ({
  notices: [] as NoticeDoc[],
  player: { displayName: 'Nathan' } as { displayName?: string } | null,
}));
const writers = vi.hoisted(() => ({
  postNotice: vi.fn((..._a: unknown[]) => Promise.resolve('new-id')),
  setNoticePinned: vi.fn((..._a: unknown[]) => Promise.resolve()),
  deleteNotice: vi.fn((..._a: unknown[]) => Promise.resolve()),
  editNotice: vi.fn((..._a: unknown[]) => Promise.resolve()),
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'admin-uid', displayName: 'Nathan (auth)' } }) }));
vi.mock('../hooks/useData', () => ({
  useMyPlayer: () => ({ data: H.player }),
  useNotices: () => ({ notices: H.notices }),
}));
vi.mock('../data/api', () => ({
  resolveDisplayName: (p: { displayName?: string } | null, a?: string) => p?.displayName ?? a ?? 'Anonymous',
}));
vi.mock('./DaySwitcher', () => ({ defaultViewedIndex: () => 7 }));
vi.mock('../data/notices', () => ({
  postNotice: writers.postNotice,
  setNoticePinned: writers.setNoticePinned,
  deleteNotice: writers.deleteNotice,
  editNotice: writers.editNotice,
  NOTICE_TITLE_MAX: 60,
  NOTICE_BODY_MAX: 400,
}));

import MessagesPanel from './admin/MessagesPanel';
import { UNSAVED_WORK_ATTRIBUTE } from '../swClientBridge';

const days: DayDef[] = [{ index: 0 } as DayDef];
const notice = (id: string, pinned: boolean): NoticeDoc => ({
  id,
  title: `${id} title`,
  body: `${id} body`,
  uid: 'admin-uid',
  displayName: 'Nathan',
  createdAt: 1000,
  dayIndex: 7,
  pinned,
});

describe('MessagesPanel (specs/admin-messages.md)', () => {
  beforeEach(() => {
    H.notices = [];
    H.player = { displayName: 'Nathan' };
    writers.postNotice.mockClear();
    writers.setNoticePinned.mockClear();
    writers.deleteNotice.mockClear();
    writers.editNotice.mockClear();
    writers.editNotice.mockImplementation(() => Promise.resolve());
  });

  it('posts a Notice with title + body + pin, then clears the draft', async () => {
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.change(screen.getByLabelText('Notice title'), { target: { value: 'Final stretch 🏁' } });
    fireEvent.change(screen.getByLabelText('Notice body'), { target: { value: 'Last days at sea.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post to everyone' }));

    await waitFor(() =>
      expect(writers.postNotice).toHaveBeenCalledWith({
        uid: 'admin-uid',
        displayName: 'Nathan',
        title: 'Final stretch 🏁',
        body: 'Last days at sea.',
        pinned: true,
        dayIndex: 7,
      }),
    );
    // The draft clears on a settled success.
    await waitFor(() => expect(screen.getByLabelText('Notice title')).toHaveValue(''));
    expect(screen.getByLabelText('Notice body')).toHaveValue('');
  });

  it('attributes to the auth name (not Anonymous) when the player row is still loading (CodeRabbit #440)', async () => {
    H.player = null; // useMyPlayer still loading — no saved player-row name yet
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.change(screen.getByLabelText('Notice title'), { target: { value: 'T' } });
    fireEvent.change(screen.getByLabelText('Notice body'), { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post to everyone' }));
    await waitFor(() =>
      expect(writers.postNotice).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Nathan (auth)' }),
      ),
    );
  });

  it('the Post button is disabled until both title and body are non-empty', () => {
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    const post = screen.getByRole('button', { name: 'Post to everyone' });
    expect(post).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Notice title'), { target: { value: 'T' } });
    expect(post).toBeDisabled(); // body still empty
    fireEvent.change(screen.getByLabelText('Notice body'), { target: { value: 'B' } });
    expect(post).toBeEnabled();
  });

  it('Unpin flips a pinned Notice to pinned=false', () => {
    H.notices = [notice('n1', true)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    expect(writers.setNoticePinned).toHaveBeenCalledWith('n1', false);
  });

  it('Delete removes the Notice from history', () => {
    H.notices = [notice('n1', false)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(writers.deleteNotice).toHaveBeenCalledWith('n1');
  });

  it('shows the sent history newest-first with the pinned marker', () => {
    H.notices = [notice('n1', true)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    expect(screen.getByText('n1 title')).toBeInTheDocument();
    expect(screen.getByText(/📌 pinned/)).toBeInTheDocument();
  });

  // ---- in-place copy correction (#455) ----

  it('Edit opens an editor prefilled with the current copy, and Save writes it', async () => {
    H.notices = [notice('n1', true)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Prefilled with what was posted — this is a correction, not a fresh compose.
    const title = screen.getByLabelText('Edit notice title');
    const body = screen.getByLabelText('Edit notice body');
    expect(title).toHaveValue('n1 title');
    expect(body).toHaveValue('n1 body');

    // The motivating case: spaced em dashes → CMOS-compliant unspaced.
    fireEvent.change(body, { target: { value: 'happened—if' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(writers.editNotice).toHaveBeenCalledWith('n1', {
        title: 'n1 title',
        body: 'happened—if',
      }),
    );
    // The editor closes on a settled success, back to the summary row.
    await waitFor(() => expect(screen.queryByLabelText('Edit notice body')).toBeNull());
  });

  it('Save with nothing changed closes without writing — no spurious "edited" (CodeRabbit #456)', async () => {
    H.notices = [notice('n1', true)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // Straight to Save, no edits — and again with only trailing whitespace, which
    // the writer would trim away anyway.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Edit notice body')).toBeNull());
    expect(writers.editNotice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit notice body'), { target: { value: 'n1 body  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Edit notice body')).toBeNull());
    expect(writers.editNotice).not.toHaveBeenCalled();
  });

  it('Cancel closes the editor without writing', () => {
    H.notices = [notice('n1', false)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit notice body'), { target: { value: 'discarded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(writers.editNotice).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Edit notice body')).toBeNull();
    expect(screen.getByText('n1 title')).toBeInTheDocument();
  });

  it('a rejected save keeps the editor open with the draft intact and alerts', async () => {
    writers.editNotice.mockImplementation(() => Promise.reject(new Error('denied')));
    H.notices = [notice('n1', false)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit notice body'), { target: { value: 'kept draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The draft survives the failure so a retry is one tap (#411 convention).
    expect(screen.getByLabelText('Edit notice body')).toHaveValue('kept draft');
  });

  it('Save is disabled while either field is empty', () => {
    H.notices = [notice('n1', false)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Edit notice body'), { target: { value: '  ' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Edit notice body'), { target: { value: 'B' } });
    fireEvent.change(screen.getByLabelText('Edit notice title'), { target: { value: '' } });
    expect(save).toBeDisabled();
  });

  // Codex P2 round 5, PR #720. A half-written broadcast lives in `useState` and
  // nowhere else, and this panel is a plain page section — it matches neither
  // `[role=dialog][aria-modal]` nor the claim-sheet signal — so the automatic
  // post-deploy reload (src/swClientBridge.ts) had nothing to defer on and ate
  // the draft. The declaration is the marker, and it goes on only while there
  // IS a draft: an admin parked on this panel must not pin the tab to a
  // condemned build for the rest of its life.
  describe('an unsaved draft holds back the automatic post-deploy reload', () => {
    const marker = `[${UNSAVED_WORK_ATTRIBUTE}]`;

    it('marks the compose form only once something has been typed', () => {
      render(<MessagesPanel adminUid="admin-uid" days={days} />);
      expect(document.querySelector(marker)).toBeNull();
      fireEvent.change(screen.getByLabelText('Notice title'), { target: { value: 'Muster drill' } });
      expect(document.querySelector(marker)).not.toBeNull();
      fireEvent.change(screen.getByLabelText('Notice title'), { target: { value: '' } });
      expect(document.querySelector(marker)).toBeNull();
    });

    it('marks the body on its own, not just the title', () => {
      render(<MessagesPanel adminUid="admin-uid" days={days} />);
      fireEvent.change(screen.getByLabelText('Notice body'), { target: { value: 'Deck 7 is closed' } });
      expect(document.querySelector(marker)).not.toBeNull();
    });

    it('releases the reload once the broadcast is posted', async () => {
      render(<MessagesPanel adminUid="admin-uid" days={days} />);
      fireEvent.change(screen.getByLabelText('Notice title'), { target: { value: 'T' } });
      fireEvent.change(screen.getByLabelText('Notice body'), { target: { value: 'B' } });
      fireEvent.click(screen.getByRole('button', { name: 'Post to everyone' }));
      await waitFor(() => expect(document.querySelector(marker)).toBeNull());
    });

    it('marks the inline editor only once the copy actually differs', () => {
      // Opening the editor and changing nothing is not a draft — `save` itself
      // treats that as a no-op, so it must not hold the tab back either.
      H.notices = [notice('n1', false)];
      render(<MessagesPanel adminUid="admin-uid" days={days} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(document.querySelector(marker)).toBeNull();
      fireEvent.change(screen.getByLabelText('Edit notice body'), { target: { value: 'corrected' } });
      expect(document.querySelector(marker)).not.toBeNull();
    });

    // Post-review #752/#753 on PR #720: `hasDraft` used raw non-emptiness while
    // `canPost` required trimmed content, so whitespace-only text marked the
    // form as unsaved work even though "Post to everyone" stayed disabled and
    // could never clear it — pinning the tab to a condemned build forever.
    it('does not mark the compose form for whitespace-only text, which Post can never clear', () => {
      render(<MessagesPanel adminUid="admin-uid" days={days} />);
      fireEvent.change(screen.getByLabelText('Notice title'), { target: { value: '   ' } });
      expect(document.querySelector(marker)).toBeNull();
      fireEvent.change(screen.getByLabelText('Notice body'), { target: { value: '  \n ' } });
      expect(document.querySelector(marker)).toBeNull();
      expect(screen.getByRole('button', { name: 'Post to everyone' })).toBeDisabled();
    });
  });

  it('an edited Notice is marked "edited" in the history; an unedited one is not', () => {
    H.notices = [{ ...notice('n1', true), editedAt: 2000 }];
    const { unmount } = render(<MessagesPanel adminUid="admin-uid" days={days} />);
    expect(screen.getByText(/edited/)).toBeInTheDocument();
    unmount();

    H.notices = [notice('n2', true)];
    render(<MessagesPanel adminUid="admin-uid" days={days} />);
    expect(screen.queryByText(/edited/)).toBeNull();
  });
});
