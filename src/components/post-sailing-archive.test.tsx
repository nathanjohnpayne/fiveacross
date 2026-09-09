import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClaimDoc, EventDoc, PlayerDoc } from '../types';

// specs/post-sailing-archive.md, RTL layer (#1149 and #1151, epic #134). The
// Admin console's three actions and the states they move between:
//
//   Close play → the quiesce (reversible, gameplay shut, nothing permanent)
//   Reopen play → lifting it, unconditionally, on the Event in front of the Admin
//   Archive → BOTH writes in order, behind the drain gate and a second tap
//
// The write functions are `vi.fn()`s because what is under test is the console's
// own behaviour, not Firestore: `src/data/post-sailing-archive.test.ts` pins what
// each write does, and `tests/rules/post-sailing-archive.test.ts` pins what the
// boundary accepts. The read hooks are stubbed (the `w2-leaderboard.test.tsx`
// precedent for isolating a presentational surface), but `../data/moderation` and
// `../data/eventArchive` deliberately are NOT: they own the drain gate
// (`claimsAwaitingAdmin`), the size refusal and the finale predicate this file is
// about, and a stubbed gate would prove nothing about the gate.

const H = vi.hoisted(() => {
  const state = {
    event: null as EventDoc | null,
    /** Whether the Event snapshot beside it is fully SERVER-COMMITTED — the
     *  console's own `hasServerData && !fromCache && !hasPendingWrites`. Kept
     *  separate from `event` because that is exactly the distinction the gate
     *  turns on: the persistent cache supplies a document, not a confirmation. */
    eventConfirmed: true,
    players: [] as PlayerDoc[],
    /** `useLeaderboard`'s LIFETIME latch — the server has answered this roster
     *  at least once. Kept apart from the two per-snapshot flags below because
     *  that is exactly the distinction the gate turns on (Codex P2 on PR
     *  #1162): the latch never clears, so it cannot say whether the rows on
     *  screen right now are the ones the server sent. */
    rosterSeen: true,
    rosterFromCache: false,
    rosterPending: false,
    /** `useDayMetasStatus`'s CURRENT answer: every Day's latest snapshot is
     *  fully server-committed. Not a latch, for the same reason. */
    dayMetasServerConfirmed: true,
    pendingClaims: [] as ClaimDoc[],
    pendingClaimsLoaded: true,
    /** The order the writes were issued in, so the quiesce-first contract is
     *  asserted on the SEQUENCE rather than on each spy alone. */
    writes: [] as string[],
    beginArchive: vi.fn(),
    abandonArchive: vi.fn(),
    archiveEvent: vi.fn(),
    useLeaderboard: vi.fn(() => ({
      players: state.players,
      loading: false,
      hasServerData: state.rosterSeen,
      fromCache: state.rosterFromCache,
      hasPendingWrites: state.rosterPending,
    })),
    /** At least one Day's honour subscription DIED. NOT the complement of
     *  `dayMetasServerConfirmed` — a Day answered before its listener died stays
     *  confirmed (Codex P2 and CodeRabbit on PR #1162). */
    dayMetasFailed: false,
    useDayMetasStatus: vi.fn(() => ({
      metas: new Map(),
      loaded: true,
      // The latch is still on the hook for the consumers that ask "has the
      // server ever spoken"; the archive gate reads the current answer below.
      serverLoaded: state.dayMetasServerConfirmed,
      serverConfirmed: state.dayMetasServerConfirmed,
      failed: state.dayMetasFailed,
    })),
  };
  return state;
});

vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));
vi.mock('../hooks/useData', () => ({
  useDayMetasStatus: H.useDayMetasStatus,
  useLeaderboard: H.useLeaderboard,
}));
vi.mock('../data/admin', () => ({
  beginArchive: (...args: unknown[]) => {
    H.writes.push('begin');
    return H.beginArchive(...args);
  },
  abandonArchive: (...args: unknown[]) => {
    H.writes.push('abandon');
    return H.abandonArchive(...args);
  },
  archiveEvent: (...args: unknown[]) => {
    H.writes.push('archive');
    return H.archiveEvent(...args);
  },
}));

// eslint-disable-next-line import/first -- the component must load AFTER the mocks above.
import ArchiveEvent from './admin/ArchiveEvent';

function mkEvent(over: Partial<EventDoc> = {}): EventDoc {
  // `finaleCompletedAt` present by default, so the FINALE gate is satisfied and
  // every case that is not about it reads as an ordinary post-finale archive.
  // It is the MARKER rather than the freeze stamp beside it, because the stamp
  // alone never proved the podium landed (#1151, Codex P1 on PR #1162).
  return {
    name: 'Test Event',
    status: 'active',
    frozenAt: 8_000,
    finaleCompletedAt: 8_100,
    ...over,
  } as EventDoc;
}

function mkPlayer(uid: string, over: Partial<PlayerDoc> = {}): PlayerDoc {
  return {
    uid,
    displayName: uid,
    photoURL: null,
    joinedAt: 0,
    bingoCount: 1,
    squaresMarked: 5,
    firstBingoAt: 1000,
    reshufflesUsed: 0,
    ...over,
  } as PlayerDoc;
}

function mkClaim(over: Partial<ClaimDoc> = {}): ClaimDoc {
  return {
    id: 'claim-1',
    uid: 'late-riser',
    displayName: 'Late Riser',
    cellIndex: 3,
    itemText: 'Something happened',
    status: 'pending',
    createdAt: 1_000,
    ...over,
  } as ClaimDoc;
}

beforeEach(() => {
  vi.clearAllMocks();
  H.event = mkEvent();
  H.eventConfirmed = true;
  H.players = [mkPlayer('alice'), mkPlayer('bob', { squaresMarked: 3 })];
  H.rosterSeen = true;
  H.rosterFromCache = false;
  H.rosterPending = false;
  H.dayMetasServerConfirmed = true;
  H.dayMetasFailed = false;
  H.pendingClaims = [];
  H.pendingClaimsLoaded = true;
  H.writes = [];
  H.beginArchive.mockResolvedValue({
    result: 'closing',
    token: 1,
    created: true,
    eventId: 'test-event',
  });
  H.abandonArchive.mockResolvedValue('reopened');
  H.archiveEvent.mockResolvedValue('archived');
});

const props = (event: EventDoc | null = H.event) => ({
  event,
  eventConfirmed: H.eventConfirmed,
  pendingClaims: H.pendingClaims,
  pendingClaimsLoaded: H.pendingClaimsLoaded,
});
const renderConsole = () => render(<ArchiveEvent {...props()} />);

describe('ArchiveEvent — the two reversible lifecycle actions (#1149)', () => {
  it('offers Close play on a LIVE Event, and no way back yet', () => {
    renderConsole();
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen play' })).not.toBeInTheDocument();
  });

  it('takes the quiesce and nothing else when Close play is pressed', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    // Reversible on purpose: gameplay is shut, and nothing permanent happened.
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(H.writes).toEqual(['begin']);
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
  });

  it('offers Reopen play on a CLOSING Event, and no second Close play', () => {
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close play' })).not.toBeInTheDocument();
  });

  it('reopens UNCONDITIONALLY from the closing-state surface', async () => {
    // A deliberate act on the Event in front of the Admin, not an automatic
    // cleanup of a call that already failed — the token binding exists to stop a
    // STALE handler, and there is no stale handler at this button.
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen play' }));
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    expect(H.abandonArchive).toHaveBeenCalledWith();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is open again/);
  });

  it('clears the action message when someone else moves the Event on (Codex P2, PR #1157)', async () => {
    // The message is a sentence about the state the action left the Event in.
    // It stays through the transition this Admin caused, and goes the moment
    // another Admin moves the Event somewhere the sentence no longer describes.
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
    // The subscription delivers the closing state this Admin produced: still true.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Play is closed/);
    // Another Admin archives it: "Reopen play to put it back" is now false.
    view.rerender(
      <ArchiveEvent {...props(mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 }))} />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('records the state observed when the action RESOLVES, not the render it started in', async () => {
    // Codex P2, PR #1157 round 7. Another Admin closes the Event while this
    // Close play is still pending: the prop reaches `closing` and the phase
    // effect runs before any result exists. Reporting against the render the
    // click happened in would leave `from: 'open'`, and a later reopen would
    // then match it and keep "Play is closed" beside the open controls.
    let settle: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    settle({ result: 'closing', token: 1, created: false, eventId: 'test-event' });
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing after a completed ROUND TRIP back to the starting phase', async () => {
    // Phase 4b P2, PR #1157 run 3. Close play commits, another Admin observes
    // it and reopens, and only then does beginArchive() settle: the Event is
    // back where the action started, but equality with the starting phase is
    // not evidence the message is true — the phase moved during the action.
    let settle: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    settle({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('shows nothing when the Event has moved somewhere the outcome does not describe', async () => {
    let settle: (value: unknown) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    // Another Admin archives it outright while the close is in flight.
    view.rerender(
      <ArchiveEvent {...props(mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 }))} />,
    );
    settle({ result: 'closing', token: 1, created: true, eventId: 'test-event' });
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears the closed message when someone else REOPENS the Event underneath it', async () => {
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await screen.findByRole('status');
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Play is closed/);
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('retires the controls once the Event is archived, and still names the state', () => {
    H.event = mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000, archiving: false });
    renderConsole();
    expect(screen.queryByRole('button', { name: 'Close play' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen play' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive…' })).not.toBeInTheDocument();
    expect(screen.getByText(/^Archived /)).toBeInTheDocument();
  });

  it('reports the frozen record on an archived Event that carries one', () => {
    H.event = mkEvent({
      status: 'archived',
      archivedAt: 1_700_000_000_000,
      archiving: false,
      archive: {
        eventName: 'Test Event',
        standings: [],
        playerCount: 2,
        firstBingo: { uid: 'alice', displayName: 'Early Bird', at: 1000 },
        firstBingoRow: null,
        dailyHonors: [],
        freezeAt: null,
        archivedAt: 1_700_000_000_000,
      },
    } as Partial<EventDoc>);
    renderConsole();
    expect(screen.getByText(/2 players · first to BINGO Early Bird/)).toBeInTheDocument();
  });
});

// #1151. The irreversible flip returns to the console WITH the two things that
// make it safe to press: the pending-claim DRAIN GATE and the durable snapshot.
describe('ArchiveEvent — the Archive action (#1151)', () => {
  it('needs a second, explicit confirmation before it freezes anything', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirm archive' })).toBeInTheDocument();
    // The confirm states what is about to be frozen, from the same builder the
    // write uses, so the preview cannot drift from the record.
    expect(screen.getByText(/Freezing 2 players/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Archived. The final standings are frozen.',
    );
  });

  // Codex P1, PR #1139. The flip reads ONE document and writes ONE document, so
  // it cannot serialize against a Board write or a Claim create in another
  // collection. The quiesce is what closes that: gameplay is shut server-side
  // FIRST, and only then is the record taken.
  it('shuts gameplay before it takes the record, never the other way round', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    // The flip is handed the generation the shut left in force, and the Event
    // the shut actually landed on (#1142 item 7) — never a roster the console
    // happened to be watching, which `archiveEvent` re-reads for itself.
    expect(H.archiveEvent).toHaveBeenCalledWith(1, {
      eventId: 'test-event',
      beforeFinale: false,
    });
  });

  it('takes no record at all when the Event cannot be shut', async () => {
    H.beginArchive.mockResolvedValue({
      result: 'no-event',
      token: null,
      created: false,
      eventId: 'test-event',
    });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin']));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('No Event document to close.');
  });

  it('backs out cleanly when the Admin cancels', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Confirm archive' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeInTheDocument();
  });

  it('finishes an already-closing archive without shutting the Event a second time', async () => {
    // `beginArchive` is idempotent, so the closing-state surface JOINS the
    // quiesce in force rather than opening a new generation — which is what
    // gives the flip a token to be bound to.
    H.beginArchive.mockResolvedValue({
      result: 'closing',
      token: 4,
      created: false,
      eventId: 'test-event',
    });
    H.event = mkEvent({ archiving: true, archiveToken: 4 });
    renderConsole();
    expect(screen.queryByRole('button', { name: 'Archive…' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Freeze the record now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(H.archiveEvent).toHaveBeenCalledWith(4, {
      eventId: 'test-event',
      beforeFinale: false,
    });
  });
});

// Codex P2, PR #1139. Resolving a Claim writes the claimant's Board and Player
// row, and the freeze denies both — so a Claim still pending at the moment of the
// flip is pending FOREVER, behind a Confirm/Reject pair that can now only fail.
describe('ArchiveEvent — the pending-claim drain gate (#1151)', () => {
  it('refuses to arm while a pending claim is in the Review queue', async () => {
    H.event = mkEvent({ claimMode: 'admin_confirmed' } as Partial<EventDoc>);
    H.pendingClaims = [mkClaim()];
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Resolve the 1 pending claim in the Review queue first/,
    );
    // Closing play is still available — it is the reversible half, and shutting
    // the Event is not what strands a Claim; freezing it is.
    expect(screen.getByRole('button', { name: 'Close play' })).toBeEnabled();
  });

  it('says so in the plural, and holds the CLOSING-state freeze shut too', () => {
    // The gate outlives the quiesce: a Claim resolution writes a Board, which is
    // denied from the moment gameplay shuts — so the only way to clear it is to
    // reopen play first, and the copy has to name that.
    H.event = mkEvent({
      archiving: true,
      archiveToken: 1,
      claimMode: 'admin_confirmed',
    } as Partial<EventDoc>);
    H.pendingClaims = [mkClaim(), mkClaim({ id: 'claim-2' })];
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Resolve the 2 pending claims/);
    expect(screen.getByRole('status')).toHaveTextContent(
      /Reopen play to drain the queue, then archive again\./,
    );
  });

  it('does not treat a not-yet-loaded claim queue as drained', () => {
    // A subscription reports only what it has DELIVERED, so an empty-and-unloaded
    // queue is indistinguishable from an empty one — and a gate that passes
    // vacuously is no gate at all.
    H.event = mkEvent({ claimMode: 'admin_confirmed' } as Partial<EventDoc>);
    H.pendingClaimsLoaded = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('ignores a stale claim outside admin-confirmed mode, which has no drain path', () => {
    // #269's mode gate, unchanged: outside `admin_confirmed` the Review queue
    // offers no Confirm/Reject, so blocking here would be a dead end rather than
    // a gate.
    H.event = mkEvent({ claimMode: 'honor' } as Partial<EventDoc>);
    H.pendingClaims = [mkClaim()];
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeEnabled();
  });

  it('reopens play when a Claim commits between the tap and the close', async () => {
    // The console's gate reads a passive listener; `archiveEvent` re-takes it
    // from the SERVER after the close. When that re-read refuses, this handler
    // shut the Event, so this handler puts it back.
    H.archiveEvent.mockResolvedValue('claims-pending');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    // CONDITIONAL on the generation this handler opened (Codex P2, PR #1139) and
    // on the Event it opened it on (#1142 item 7).
    expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'A claim arrived as play was closing, so nothing was frozen. Resolve the Review queue, then archive again.',
    );
  });

  it('keeps the explanation on the OPEN controls after its own automatic reopen', async () => {
    // Codex P2 on PR #1162. Every refusal was classified as describing a CLOSING
    // Event, but an open-phase archive reopens for all four of them when it
    // created the quiesce — so the Event ends up OPEN and the message was
    // discarded twice over: the handler's own reopen moved the phase away from
    // `closing`, and the phase having moved at all during the action disqualified
    // the still-where-it-started fallback. The Admin was left looking at reopened
    // controls with no explanation of why nothing was frozen.
    let settle: (value: unknown) => void = () => {};
    H.archiveEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    void userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    // The subscription delivers what this handler's OWN writes produced: the
    // quiesce it took…
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 1 }))} />);
    settle('claims-pending');
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event'));
    // …and then the reopen it performed when the freeze refused.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'A claim arrived as play was closing, so nothing was frozen. Resolve the Review queue, then archive again.',
    );
    // Against the controls the Admin is actually looking at.
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('still clears it when someone ELSE moves the Event after that reopen', async () => {
    // The reopen settles where the message belongs; it does not exempt it from
    // the staleness rule. Another Admin archiving afterwards makes "archive
    // again" false, so it goes.
    H.archiveEvent.mockResolvedValue('config-changed');
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    await screen.findByRole('status');
    view.rerender(
      <ArchiveEvent {...props(mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 }))} />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('leaves a quiesce it only JOINED closed, and says why', async () => {
    // #1142 item 6. `beginArchive` is idempotent, so a call that joined another
    // Admin's in-flight quiesce comes back holding a token that matches
    // perfectly — and a reopen keyed on the token alone would succeed at exactly
    // the write the binding exists to refuse.
    H.beginArchive.mockResolvedValue({
      result: 'closing',
      token: 4,
      created: false,
      eventId: 'test-event',
    });
    H.archiveEvent.mockResolvedValue('too-large');
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    expect(H.abandonArchive).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play was left closed/);
    // …and because no reopen was attempted, the explanation is a sentence about
    // a CLOSING Event and stays with the controls that describe one (Codex P2 on
    // PR #1162): the quiesce belongs to whoever opened it, and this Admin's way
    // out is **Reopen play** beside the message.
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: true, archiveToken: 4 }))} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Play was left closed/);
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
  });

  it('leaves the Event shut when the quiesce it read was taken over by another', async () => {
    // `quiesce-changed` is deliberately outside the reopen set: the closing state
    // now in force is a DIFFERENT one, so clearing it would reopen an Event
    // underneath somebody else's in-flight freeze.
    H.archiveEvent.mockResolvedValue('quiesce-changed');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    expect(H.abandonArchive).not.toHaveBeenCalled();
  });

  it('says so when the settings moved underneath the record, and reopens play', async () => {
    H.archiveEvent.mockResolvedValue('config-changed');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /The Event settings changed while the record was being taken/,
    );
  });
});

describe('ArchiveEvent — the archive waits for its inputs to be server-confirmed', () => {
  // Codex P1: the write is permanent behind write-once rules. Until the server
  // has spoken, an empty roster and an unpinned Day are indistinguishable from a
  // cold ADR 0006 cache, and archiving on one would freeze empty standings and
  // missing honours forever.
  it('disables the control while the roster is still cache-only', () => {
    H.rosterSeen = false;
    H.rosterFromCache = true;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('disables the control while a Day-meta subscription is unconfirmed', () => {
    H.dayMetasServerConfirmed = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
  });

  it('disables the control while the Event document itself has not arrived', () => {
    H.event = null;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
  });

  // Codex P2 on PR #1162. A present Event is what the ADR 0006 persistent cache
  // delivers; it is not what the server said. The roster and the Day-meta
  // listeners latch INDEPENDENTLY, so both can confirm while the Event is still
  // the cached copy — and the schedule, name and ban list the preview is built
  // from are then whatever that cache held, on a write that cannot be undone.
  it('does NOT arm on a cached-only Event, however confirmed the other inputs are', () => {
    H.eventConfirmed = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('holds the CLOSING-state freeze shut on a cached-only Event too', () => {
    // The other surface that reaches the flip. An Admin who has already used
    // Close play cannot get back to the confirm row, so the gate has to hold
    // here on its own terms.
    H.eventConfirmed = false;
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
  });

  it('enables it once the Event, the roster and every Day-meta subscription are confirmed', () => {
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // Codex P2 on PR #1162. A day-meta listener that dies before any server
  // snapshot can never be confirmed, so "loading" would be a message that never
  // resolves — and the preview beside it is showing the roster-DERIVED honour,
  // or none, where the freeze's own server re-read may find the PINNED holder
  // and keep them instead.
  it('says the honours could not be READ when a Day subscription failed, not "loading"', () => {
    H.dayMetasFailed = true;
    H.dayMetasServerConfirmed = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /The daily honours could not be read from the server/,
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(/Loading the final standings/);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing has been closed\./);
  });

  it('holds the CLOSING-state freeze shut on unreadable honours, and says nothing was frozen', () => {
    H.dayMetasFailed = true;
    H.dayMetasServerConfirmed = false;
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /The daily honours could not be read from the server.*Play is already closed—nothing has been frozen\./,
    );
  });

  // CodeRabbit, PR #1162. `failed` is not the complement of the confirmation: a
  // Day the server answered before its listener died stays confirmed, and
  // nothing clears it. So `failed` alone printed a TERMINAL "reload the console"
  // message beside an ENABLED control, sending the Admin after a problem that
  // was not standing in their way.
  it('says nothing about unreadable honours while every Day is still confirmed', () => {
    H.dayMetasFailed = true;
    H.dayMetasServerConfirmed = true;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // Codex P2 on PR #1162. `hasServerData` and `serverLoaded` are LATCHES: they
  // say the server HAS spoken, never that this is what it says. They never
  // clear, so a console that confirmed its inputs and then went offline armed
  // Archive over a preview the persistent cache re-served — and the record the
  // freeze takes is permanent.
  it('disarms when a CONFIRMED roster starts coming back from the cache', () => {
    H.rosterSeen = true; // the latch holds — the server did answer, once
    H.rosterFromCache = true; // …and this is not that answer
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('disarms while a local roster write is still pending', () => {
    // Emitted server-backed but UNDECIDED, exactly as an Admin's own optimistic
    // `archiving: true` is on the Event document — and a refusal rolls it back.
    H.rosterSeen = true;
    H.rosterFromCache = false;
    H.rosterPending = true;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });

  it('holds the CLOSING-state freeze shut on a cache-served roster too', () => {
    // The other surface that reaches the flip, which an Admin who has already
    // used Close play cannot get back from.
    H.rosterSeen = true;
    H.rosterFromCache = true;
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
  });

  it('disarms when a CONFIRMED Day fan starts coming back from the cache', () => {
    // The Day-meta half of the same claim: the honour the preview shows has to
    // be the one the server is answering with now, because `archiveEvent`'s own
    // re-read may recover a PINNED holder the cached view never had.
    H.dayMetasServerConfirmed = false;
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the final standings/);
  });
});

describe('ArchiveEvent — a record it could not store is refused before anything is shut', () => {
  // `players/{uid}` validates none of its fields, so a Player can leave a row the
  // record cannot carry. The builder coerces and skips what it can and REFUSES
  // what it cannot — and that refusal has to be read BEFORE the first write, or
  // every attempt closes play and then fails on the second one.
  const whale = () =>
    mkPlayer('whale', {
      dayStats: Object.fromEntries(
        Array.from({ length: 6_000 }, (_, i) => [
          i,
          { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1_000 + i },
        ]),
      ),
    } as Partial<PlayerDoc>);

  it('will not arm, and says so before anything is closed', () => {
    H.players = [whale()];
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/too large to freeze onto the Event/);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing has been closed\./);
  });

  // Codex P2 on PR #1162. The copy used to blame extra text on a Player row and
  // recommend banning that Player. The archive copies six SELECTED fields per
  // row, clips every name at 100 characters and pins each uid to a bounded
  // document id, so unrelated Player text contributes nothing — and banning is
  // the one remedy that can make the DOCUMENT bigger, because `bannedUids` is
  // stored on the very Event the record has to fit beside.
  it('names the levers that actually move the size, and does not recommend a ban', () => {
    H.players = [whale()];
    renderConsole();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(
      /The record itself is bounded: 200 standings rows, one honour per Day, and names clipped at 100 characters/,
    );
    expect(status).toHaveTextContent(
      /the Day schedule with each Day’s frozen Prompt list, the ban list, and the Most-Loved award/,
    );
    expect(status).toHaveTextContent(/Banning a Player does not/);
    expect(status).not.toHaveTextContent(/far more text than a name/);
    expect(status).not.toHaveTextContent(/ban that Player/);
  });

  it('says WHICH ceiling refused it — the record’s own share', () => {
    // This roster's `dayStats` mention 6,000 Day indexes, and with no schedule
    // on the Event the honours fall back to one derived honour per index — so
    // the RECORD is over its own quarter of the budget before the Event data is
    // counted at all.
    H.players = [whale()];
    renderConsole();
    expect(screen.getByRole('status')).toHaveTextContent(
      /The record is over its own share of the budget on its own, before the Event data is counted\./,
    );
  });

  it('says WHICH ceiling refused it — the Event document, on an ordinary record', () => {
    // The other, and the commoner one: two ordinary Players, a record of a few
    // hundred bytes, and an Event whose own retained ban list has already spent
    // the document's budget. Naming the record here would send the Admin after
    // the wrong thing entirely.
    H.event = mkEvent({
      bannedUids: Array.from({ length: 25_000 }, (_, i) => `banned-uid-${i}`.padEnd(40, 'x')),
    } as Partial<EventDoc>);
    renderConsole();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/too large to freeze onto the Event/);
    expect(status).toHaveTextContent(
      /The record fits its own share; it is the Event document that has no room left for it\./,
    );
  });

  it('holds the closing-state freeze shut too, and says nothing was frozen', () => {
    H.players = [whale()];
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Play is already closed—nothing has been frozen\./,
    );
    // …and never the ban the old copy sent an Admin after from here.
    expect(screen.getByRole('status')).not.toHaveTextContent(/ban that Player/);
  });

  it('reopens play when the record’s SHAPE is refused, and says so in its own words', async () => {
    // #1151, Codex P1 on PR #1162. The third precondition now has two refusals
    // behind it, and they send an Admin after entirely different things: the
    // ceiling names the Event data to trim, while a record the BOUNDARY would
    // refuse has nothing to trim at all. Folding them into one sentence would
    // give whichever fired the other one's advice.
    H.archiveEvent.mockResolvedValue('record-unwritable');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    // The same automatic cleanup the other flip refusals get, so a live Event is
    // never left shut over one.
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/did not produce a record the Event will accept/);
    expect(status).not.toHaveTextContent(/too large to freeze onto the Event/);
  });

  it('reopens play when the stored SCHEDULE has an unusable Day, and names the repair', async () => {
    // Codex P2 on PR #1162. `eventConverter` tolerates a `null` Day entry, so
    // this console arms over such an Event — and the freeze's own RAW read is
    // where it stops being tolerable. The refusal is what makes that a cleanup
    // the handler can perform rather than a throw that skips it, and its copy is
    // the one here with a repair the Admin can make from the surface this
    // control already sits at the bottom of.
    H.archiveEvent.mockResolvedValue('schedule-unusable');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'One of the days in the schedule above could not be read, so the daily honours could not be looked up and nothing was frozen. Fix or re-save that day, then archive again.',
    );
  });

  it('still renders Game settings when a Player row is unreadable to the selectors', () => {
    // #1142 item 10's neighbour: the draft is built during RENDER, so a row that
    // threw out of the builder took the whole surface — and the Reopen play
    // control with it — down on an Event that may already be shut.
    H.players = [
      { ...mkPlayer('broken'), dayStats: { 1: null } } as unknown as PlayerDoc,
      { ...mkPlayer('nameless'), uid: undefined } as unknown as PlayerDoc,
    ];
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeEnabled();
  });
});

// #1151, routed here from #1150's review. The quiesce only DELAYS the finale
// beats; the flip forgoes them for good, and nothing else would say so.
describe('ArchiveEvent — the pre-finale acknowledgement (#1151)', () => {
  const preFinale = (over: Partial<EventDoc> = {}) =>
    ({
      name: 'Test Event',
      status: 'active',
      standingsFreezeAt: 8_000,
      ...over,
    }) as EventDoc;

  it('will not archive before the scheduled freeze without an explicit acknowledgement', async () => {
    H.event = preFinale();
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    const confirm = screen.getByRole('button', { name: 'Archive the Event now' });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText(/the podium, the Most-Loved award and the freeze stamp will never arrive/))
      .toBeInTheDocument();
    expect(H.archiveEvent).not.toHaveBeenCalled();
  });

  it('archives once the Admin ticks it, and tells the writer they did', async () => {
    H.event = preFinale();
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(H.archiveEvent).toHaveBeenCalledWith(1, {
      eventId: 'test-event',
      beforeFinale: true,
    });
  });

  it('asks nothing once the finale has run — the control', async () => {
    H.event = mkEvent({ frozenAt: 8_000, finaleCompletedAt: 8_100 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeEnabled();
  });

  it('still asks when the freeze is stamped but the podium has not landed', async () => {
    // #1151, Codex P1 on PR #1162. `frozenAt` records the freeze transaction and
    // nothing else; the podium is a separate best-effort beat with its own retry
    // guard, so this is a real state an Event sits in — and the flip would forgo
    // that podium permanently, because a closed Event's finale is never retried.
    H.event = preFinale({ frozenAt: 8_000 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeDisabled();
  });

  it('offers the same acknowledgement on the CLOSING surface, and archives once it is given', async () => {
    // Codex P2 on PR #1162. `ready` gates **Freeze the record** exactly as it
    // gates the confirm row, but the box was rendered only in the confirm row —
    // a surface an Admin who has already used Close play cannot reach. So the
    // button was permanently disabled and the only way forward was to reopen
    // gameplay on an Event they had deliberately shut, purely to tick a box.
    H.event = preFinale({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Freeze the record now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(H.archiveEvent).toHaveBeenCalledWith(1, {
      eventId: 'test-event',
      beforeFinale: true,
    });
  });

  it('asks nothing on the closing surface once the marker is stamped — the control', () => {
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Freeze the record now' })).toBeEnabled();
  });

  it('asks nothing on an Event with no scheduled finale at all', async () => {
    // A legacy Event with no ceremonial Day and no stored freeze never freezes
    // on its own, so gating on one would ask the Admin to wait forever.
    H.event = { name: 'Test Event', status: 'active' } as EventDoc;
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeEnabled();
  });

  it('reopens play and names the finale when the writer refuses it anyway', async () => {
    // The server-side half: the finale can land — or fail to — between the
    // console's read and the commit, and the writer decides on the state the
    // flip actually meets.
    H.archiveEvent.mockResolvedValue('finale-pending');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /The scheduled standings freeze has not run yet/,
    );
  });
});

// CodeRabbit Major on PR #1162. The writer's server reads are taken after the
// quiesce, so one that does not answer used to throw straight out of
// `archiveEvent`: `runArchive` never saw a result, the automatic reopen never
// ran, and the Admin got "Freeze failed—try again." over an Event this handler
// had just shut and would now never put back.
describe('ArchiveEvent — a read that did not answer (#1162)', () => {
  it('reopens play, and says WHICH read did not answer', async () => {
    H.archiveEvent.mockResolvedValue('read-failed:roster');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    // The same cleanup the four stated refusals get, conditional on the
    // generation this handler opened and the Event it opened it on.
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    expect(H.abandonArchive).toHaveBeenCalledWith(1, 'test-event');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The final standings could not be read back from the server after play closed, so nothing was frozen. Check the connection and archive again.',
    );
  });

  it('names each of the four reads in the Admin’s own vocabulary', async () => {
    // One sentence per read, so an Admin can tell a connection problem on the
    // roster from a Review queue they have lost access to.
    const subjects = [
      ['read-failed:event', 'The Event'],
      ['read-failed:claims', 'The Review queue'],
      ['read-failed:roster', 'The final standings'],
      ['read-failed:day-meta', 'The daily honours'],
    ] as const;
    for (const [outcome, subject] of subjects) {
      H.archiveEvent.mockResolvedValue(outcome);
      const view = renderConsole();
      await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
      await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
      expect(await screen.findByRole('status')).toHaveTextContent(
        `${subject} could not be read back from the server after play closed`,
      );
      view.unmount();
    }
  });

  it('keeps the explanation on the OPEN controls its own reopen produced', async () => {
    // The refusal describes where the Event ENDS UP, and the handler's reopen is
    // what put it there — the same `settledAt` path the four stated refusals take
    // (Codex P2 on PR #1162), so the message survives the phase move it caused.
    H.archiveEvent.mockResolvedValue('read-failed:claims');
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive', 'abandon']));
    view.rerender(<ArchiveEvent {...props(mkEvent({ archiving: false }))} />);
    expect(await screen.findByRole('status')).toHaveTextContent(/The Review queue could not be/);
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('leaves a quiesce it only JOINED closed, exactly as the stated refusals do', async () => {
    // #1142 item 6 applies unchanged: a handler that merely joined another
    // Admin's in-flight quiesce holds a matching token, and reopening on it would
    // clear a closing state it never took.
    H.beginArchive.mockResolvedValue({
      result: 'closing',
      token: 7,
      created: false,
      eventId: 'test-event',
    });
    H.archiveEvent.mockResolvedValue('read-failed:day-meta');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    expect(H.abandonArchive).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play was left closed/);
  });

  it('does NOT reopen from the closing surface, which never shut the Event', async () => {
    // **Freeze the record** is pressed on an Event that was already closed when
    // the Admin arrived, and **Reopen play** sits beside it — so the message is a
    // sentence about a CLOSING Event and stays with the controls that describe one.
    H.beginArchive.mockResolvedValue({
      result: 'closing',
      token: 4,
      created: false,
      eventId: 'test-event',
    });
    H.archiveEvent.mockResolvedValue('read-failed:event');
    H.event = mkEvent({ archiving: true, archiveToken: 4 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Freeze the record now' }));
    await waitFor(() => expect(H.writes).toEqual(['begin', 'archive']));
    expect(H.abandonArchive).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/The Event could not be read back/);
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
  });
});
