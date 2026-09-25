import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { BlockDoc } from '../types';

// specs/player-blocking.md § Block and unblock controls (#689 part 3): the
// block confirm sheet, the Blocked players panel, and the payloads of the
// block_player / unblock_player analytics events. The writes, the own-blocks
// listener, the roster and the online signal are stubbed at their module seams.

const H = vi.hoisted(() => ({
  track: vi.fn(),
  unblockPlayer: vi.fn(),
  myBlocks: {
    data: [] as BlockDoc[],
    loading: false,
    error: false,
    confirmed: true,
    pendingTargets: new Set<string>() as ReadonlySet<string>,
  },
  players: [] as Array<{ uid: string; displayName: string }>,
  rosterConfirmed: true,
  online: true,
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../analytics', () => ({ track: H.track }));
vi.mock('../data/blocks', () => ({ blockPlayer: vi.fn(), unblockPlayer: H.unblockPlayer }));
vi.mock('../hooks/useBlocks', () => ({ useMyBlocks: () => H.myBlocks }));
vi.mock('../hooks/useData', () => ({ useLeaderboard: () => ({ players: H.players, loading: false, hasServerData: H.rosterConfirmed }),
}));
vi.mock('../hooks/useOnline', () => ({ useOnline: () => H.online }));

import BlockPlayerButton from './BlockPlayerButton';
import BlockedPlayersPanel from './BlockedPlayersPanel';

const direction = (targetUid: string, createdAt: number): BlockDoc => ({
  ownerUid: 'viewer',
  targetUid,
  eventId: 'test-event',
  createdAt,
});
const flush = () => act(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  H.myBlocks = { data: [], loading: false, error: false, confirmed: true, pendingTargets: new Set() };
  H.players = [];
  H.rosterConfirmed = true;
  H.online = true;
});

describe('BlockPlayerButton', () => {
  const open = (block: ReturnType<typeof vi.fn>) => {
    render(<BlockPlayerButton meUid="viewer" targetUid="bea" targetName="Bea" surface="proof_card" block={block} />);
    fireEvent.click(screen.getByRole('button', { name: 'Block Bea' }));
    return screen.getByRole('dialog', { name: 'Block Bea?' });
  };

  it('confirms with copy that does not overclaim, then commits and closes at once', async () => {
    const block = vi.fn(() => Promise.resolve());
    const dialog = open(block);
    expect(dialog.textContent).toContain('they may be able to tell');
    expect(dialog.textContent).toContain('You can unblock any time from More.');
    expect(dialog.textContent).toContain('Scores and standings don’t change.');
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    expect(block).toHaveBeenCalledWith({ me: 'viewer', target: 'bea', eventId: 'test-event' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await flush();
    // The payload names where the block started and nothing about either Player.
    expect(H.track).toHaveBeenCalledWith('block_player', { surface: 'proof_card' });
    const params = H.track.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(params)).toEqual(['surface']);
    expect(JSON.stringify(params)).not.toMatch(/bea|viewer/i);
  });

  it('cancel and Escape write nothing; Escape stops at this sheet, not a sheet beneath it', () => {
    const block = vi.fn(() => Promise.resolve());
    const beneath = vi.fn();
    document.addEventListener('keydown', beneath);
    open(block);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Block Bea' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(beneath).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
    document.removeEventListener('keydown', beneath);
  });

  it('when the block unmounts the trigger, focus lands on the host who-list sheet, not <body>', async () => {
    const Host = ({ showRow }: { showRow: boolean }) => (
      <div role="dialog" aria-label="Who marked it">
        <div className="sheet-title" tabIndex={-1}>
          Who marked it
        </div>
        {showRow && (
          <BlockPlayerButton meUid="viewer" targetUid="bea" targetName="Bea" surface="feed_wholist" block={() => Promise.resolve()} />
        )}
      </div>
    );
    const { rerender } = render(<Host showRow />);
    const trigger = screen.getByRole('button', { name: 'Block Bea' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    // The optimistic block hides Bea, unmounting her row and its trigger.
    rerender(<Host showRow={false} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.classList.contains('sheet-title')).toBe(true);
  });

  it('on the Board, whose TallySheet is a bare .sheet, focus lands in that sheet too', async () => {
    const TallySheet = ({ showRow }: { showRow: boolean }) => (
      <div className="sheet-backdrop">
        <div className="sheet">
          <div className="sheet-title">Who got “Towel animal”</div>
          {showRow && (
            <BlockPlayerButton meUid="viewer" targetUid="bea" targetName="Bea" surface="board_wholist" block={() => Promise.resolve()} />
          )}
        </div>
      </div>
    );
    const { rerender, container } = render(<TallySheet showRow />);
    const trigger = screen.getByRole('button', { name: 'Block Bea' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    rerender(<TallySheet showRow={false} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(container.querySelector('.sheet-title'));
  });

  it('a rejected block logs and fires no event', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejected = vi.fn(() => Promise.reject(new Error('permission-denied')));
    open(rejected);
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    await flush();
    expect(H.track).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('keeps whom a Player blocked out of autocapture and replay: trigger and sheet are ph-no-capture', () => {
    const dialog = open(vi.fn(() => Promise.resolve()));
    expect(screen.getByRole('button', { name: 'Block Bea' }).classList.contains('ph-no-capture')).toBe(true);
    // The sheet is portalled out of any ph-no-capture ancestor, so it needs its own.
    expect(dialog.closest('.ph-no-capture')).not.toBeNull();
  });

  it('a backdrop click closes this sheet only, never the host who-list backdrop beneath it', () => {
    const hostClose = vi.fn();
    render(
      <div className="sheet-backdrop" onClick={hostClose}>
        <div className="sheet" role="dialog" aria-label="Who marked it">
          <BlockPlayerButton meUid="viewer" targetUid="bea" targetName="Bea" surface="feed_wholist" block={() => Promise.resolve()} />
        </div>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Block Bea' }));
    hostClose.mockClear();
    const sheet = screen.getByRole('dialog', { name: 'Block Bea?' });
    fireEvent.click(sheet.parentElement as HTMLElement);
    expect(screen.queryByRole('dialog', { name: 'Block Bea?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Who marked it' })).toBeTruthy();
    expect(hostClose).not.toHaveBeenCalled();
  });

  it('a refused block keeps the sheet open with an error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = vi.fn(() => {
      throw new Error('[blocks] both uids are required');
    });
    const dialog = open(refused);
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    expect(dialog.textContent).toContain('Couldn’t block Bea. Try again.');
  });
});

describe('BlockedPlayersPanel', () => {
  it('lists only the viewer’s own blocks, newest first, named from the raw roster', () => {
    H.myBlocks.data = [direction('bea', 1), direction('ghost', 2)];
    H.players = [{ uid: 'bea', displayName: 'Bea' }];
    const { container } = render(<BlockedPlayersPanel uid="viewer" />);
    expect([...container.querySelectorAll('.blocked-row .name')].map((n) => n.textContent)).toEqual(['A player', 'Bea']);
    expect(container.firstElementChild?.classList.contains('ph-no-capture')).toBe(true);
  });

  it('shows an empty state, and an error state distinct from it', () => {
    const { rerender } = render(<BlockedPlayersPanel uid="viewer" />);
    expect(screen.getByText('You haven’t blocked anyone.')).toBeTruthy();
    H.myBlocks = { ...H.myBlocks, error: true, confirmed: false };
    rerender(<BlockedPlayersPanel uid="viewer" />);
    expect(screen.queryByText('You haven’t blocked anyone.')).toBeNull();
    expect(screen.getByText(/Couldn’t load your blocked players/)).toBeTruthy();
  });

  it('an empty cache-only list waits for the server instead of claiming no blocks', () => {
    H.online = false;
    H.myBlocks = { ...H.myBlocks, confirmed: false };
    const { rerender } = render(<BlockedPlayersPanel uid="viewer" />);
    expect(screen.queryByText('You haven’t blocked anyone.')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.getByText('You’re offline. Unblocking needs a connection.')).toBeTruthy();
    H.online = true;
    H.myBlocks = { ...H.myBlocks, confirmed: true };
    rerender(<BlockedPlayersPanel uid="viewer" />);
    expect(screen.getByText('You haven’t blocked anyone.')).toBeTruthy();
  });

  it('a row whose block batch is still queued cannot be unblocked until it commits', () => {
    H.myBlocks.data = [direction('bea', 1), direction('cal', 2)];
    H.myBlocks.pendingTargets = new Set(['bea']);
    H.players = [
      { uid: 'bea', displayName: 'Bea' },
      { uid: 'cal', displayName: 'Cal' },
    ];
    const { rerender } = render(<BlockedPlayersPanel uid="viewer" />);
    expect(screen.getByRole('button', { name: 'Unblock Bea' })).toBeDisabled();
    expect(screen.getByText('Saving this block…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unblock Cal' })).not.toBeDisabled();
    H.myBlocks = { ...H.myBlocks, pendingTargets: new Set() };
    rerender(<BlockedPlayersPanel uid="viewer" />);
    expect(screen.getByRole('button', { name: 'Unblock Bea' })).not.toBeDisabled();
    expect(screen.queryByText('Saving this block…')).toBeNull();
  });

  it('confirms, unblocks, reports it and fires unblock_player with no identity', async () => {
    H.myBlocks.data = [direction('bea', 1)];
    H.players = [{ uid: 'bea', displayName: 'Bea' }];
    H.unblockPlayer.mockResolvedValue({ stillHidden: false });
    render(<BlockedPlayersPanel uid="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Bea' }));
    expect(screen.getByText(/If they’ve also blocked you, you’ll stay hidden from each other/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unblock' }));
    await flush();
    expect(H.unblockPlayer).toHaveBeenCalledWith({ me: 'viewer', target: 'bea', eventId: 'test-event' });
    expect(screen.getByRole('status').textContent).toBe('Unblocked Bea.');
    expect(H.track).toHaveBeenCalledWith('unblock_player', { stillHidden: false });
    expect(Object.keys(H.track.mock.calls[0][1] as object)).toEqual(['stillHidden']);
  });

  it('says a still-standing pair is likely mutual without claiming it', async () => {
    H.myBlocks.data = [direction('bea', 1)];
    H.players = [{ uid: 'bea', displayName: 'Bea' }];
    H.unblockPlayer.mockResolvedValue({ stillHidden: true });
    render(<BlockedPlayersPanel uid="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Bea' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unblock' }));
    await flush();
    expect(screen.getByRole('status').textContent).toBe(
      'Unblocked Bea. You’re still hidden from each other for now—usually that means they’ve blocked you too.',
    );
    expect(H.track).toHaveBeenCalledWith('unblock_player', { stillHidden: true });
  });

  it('a failed unblock keeps the row, says to retry and fires nothing; a pending one reads Unblocking…', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    H.myBlocks.data = [direction('bea', 1)];
    H.players = [{ uid: 'bea', displayName: 'Bea' }];
    let fail: (e: unknown) => void = () => {};
    H.unblockPlayer.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    render(<BlockedPlayersPanel uid="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Bea' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unblock' }));
    const trigger = screen.getByRole('button', { name: 'Unblock Bea' });
    expect(trigger.textContent).toBe('Unblocking…');
    expect(trigger).toBeDisabled();
    await act(async () => fail(Object.assign(new Error('unavailable'), { code: 'unavailable' })));
    expect(screen.getByRole('status').textContent).toBe('Couldn’t unblock Bea. Check your connection and try again.');
    expect(screen.getByRole('button', { name: 'Unblock Bea' })).not.toBeDisabled();
    expect(H.track).not.toHaveBeenCalled();
  });

  it('offline: never starts an unblock, and says it needs a connection', () => {
    H.online = false;
    H.myBlocks.data = [direction('bea', 1)];
    render(<BlockedPlayersPanel uid="viewer" />);
    expect(screen.getByText('You’re offline. Unblocking needs a connection.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unblock A player' })).toBeDisabled();
    expect(H.unblockPlayer).not.toHaveBeenCalled();
  });

  it('a confirmed unblock drops its row at once, even before the listener delivers the deletion', async () => {
    H.myBlocks.data = [direction('bea', 1), direction('cal', 2)];
    H.players = [
      { uid: 'bea', displayName: 'Bea' },
      { uid: 'cal', displayName: 'Cal' },
    ];
    H.unblockPlayer.mockResolvedValue({ stillHidden: false });
    render(<BlockedPlayersPanel uid="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Bea' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unblock' }));
    await flush();
    // The listener still reports Bea's record; the row stays gone regardless.
    expect(screen.queryByRole('button', { name: 'Unblock Bea' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Unblock Cal' })).not.toBeDisabled();
    expect(screen.getByRole('status').textContent).toBe('Unblocked Bea.');
    expect(H.unblockPlayer).toHaveBeenCalledTimes(1);
  });

  it('an unnamed target waits for the roster instead of offering an anonymous unblock', () => {
    H.rosterConfirmed = false;
    H.myBlocks.data = [direction('bea', 1), direction('dee', 2)];
    H.players = [{ uid: 'dee', displayName: 'Dee' }];
    const { container } = render(<BlockedPlayersPanel uid="viewer" />);
    expect([...container.querySelectorAll('.blocked-row .name')].map((n) => n.textContent)).toEqual(['Dee', 'Loading…']);
    expect(screen.getByRole('button', { name: 'Unblock Loading…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unblock Dee' })).not.toBeDisabled();
  });

  it('a blank or whitespace-only cached name stays disabled until the roster confirms', () => {
    H.rosterConfirmed = false;
    H.myBlocks.data = [direction('bea', 1), direction('cal', 2)];
    H.players = [
      { uid: 'bea', displayName: '' },
      { uid: 'cal', displayName: '   ' },
    ];
    const { container, rerender } = render(<BlockedPlayersPanel uid="viewer" />);
    expect([...container.querySelectorAll('.blocked-row .name')].map((n) => n.textContent)).toEqual([
      'Loading…',
      'Loading…',
    ]);
    for (const button of screen.getAllByRole('button', { name: 'Unblock Loading…' })) expect(button).toBeDisabled();
    H.rosterConfirmed = true;
    rerender(<BlockedPlayersPanel uid="viewer" />);
    for (const button of screen.getAllByRole('button', { name: 'Unblock A player' })) expect(button).not.toBeDisabled();
  });

  it('a non-string roster name neither crashes the panel nor names the target', () => {
    H.myBlocks.data = [direction('bea', 1), direction('cal', 2)];
    // The Player row's rules do not type-check displayName, so a target can store anything.
    H.players = [
      { uid: 'bea', displayName: { trim: null } as unknown as string },
      { uid: 'cal', displayName: 42 as unknown as string },
    ];
    const { container } = render(<BlockedPlayersPanel uid="viewer" />);
    expect([...container.querySelectorAll('.blocked-row .name')].map((n) => n.textContent)).toEqual([
      'A player',
      'A player',
    ]);
    for (const button of screen.getAllByRole('button', { name: 'Unblock A player' })) expect(button).not.toBeDisabled();
  });

  it('moves focus onto the confirmation when it opens, and back to Unblock when it is cancelled', () => {
    H.myBlocks.data = [direction('bea', 1)];
    H.players = [{ uid: 'bea', displayName: 'Bea' }];
    render(<BlockedPlayersPanel uid="viewer" />);
    const unblock = screen.getByRole('button', { name: 'Unblock Bea' });
    unblock.focus();
    fireEvent.click(unblock);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Unblock Bea' }));
    expect(H.unblockPlayer).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus inside the panel when the focused confirm and then the row unmount', async () => {
    H.myBlocks.data = [direction('bea', 1)];
    H.players = [{ uid: 'bea', displayName: 'Bea' }];
    let land: (v: { stillHidden: boolean }) => void = () => {};
    H.unblockPlayer.mockReturnValue(new Promise((r) => (land = r)));
    const { container } = render(<BlockedPlayersPanel uid="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Bea' }));
    const yes = screen.getByRole('button', { name: 'Yes, unblock' });
    yes.focus();
    fireEvent.click(yes);
    expect(document.activeElement).toBe(container.firstElementChild);
    await act(async () => land({ stillHidden: false }));
    expect(document.activeElement).toBe(screen.getByRole('status'));
  });
});

