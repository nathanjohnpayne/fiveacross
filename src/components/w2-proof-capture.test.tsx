import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoardDoc, Cell, EventDoc, PlayerDoc } from '../types';

// w2-proof-capture, capture + gating layer (RTL-jsdom). Two real components:
//   1. ProofSheet — each capture type (photo / audio / text) produces a valid
//      submit that calls attachProof and closes the sheet; Cancel closes WITHOUT
//      attaching (so the Square is never marked); and a failed submit KEEPS the
//      capture (capture-then-retry — the offline story: attachProof can't queue,
//      so the Player retries when signal returns without re-capturing).
//   2. Board proof-to-mark gating — in proof_required an unmarked Square opens
//      ProofSheet instead of marking (friction, not trust — ADR 0001), a
//      cancelled sheet leaves it unmarked, and unmark stays instant; in honor a
//      claim tap opens the sheet too, where the 🎖️ pledge marks WITHOUT any
//      Proof (issue #181 — the full pledge matrix is w4-honor-pledge.test.tsx).
// attachProof / setMark are stubbed so the assertions are about the flow, not
// the write (that is w2-proof-capture.test.ts / w1-board-mark-win.test.ts).

const H = vi.hoisted(() => ({
  user: { uid: 'u1', displayName: 'Deck Daddy', photoURL: null } as { uid: string; displayName: string | null; photoURL: string | null },
  board: null as BoardDoc | null,
  player: null as PlayerDoc | null,
  event: null as EventDoc | null,
  setMark: vi.fn(),
  attachProof: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useDayBoard: () => ({ data: H.board, loading: false, hasServerData: true }),
  useMyPlayer: () => ({ data: H.player, loading: false, hasServerData: true }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  useItems: () => ({ items: [], loading: false, hasServerData: true }),
  // Board renders the per-Prompt TallyBadge on a marked, non-free Square (ADR
  // 0002, #31), so a test that marks a Square exercises useTally; an empty Tally
  // keeps these gating tests focused on the mark flow, not the count.
  useTally: () => ({ markers: [], count: 0, loading: false, hasServerData: true }),
  // Board reads the roster for the First-to-BINGO Moment (#34); these gating
  // tests never cross a bingo edge, so an empty roster suffices.
  useLeaderboard: () => ({ players: [], loading: false }),
  // Board subscribes the per-Square Doubt count + the Feed's Proofs (#33); these
  // proof-gating tests never assert a Doubt, so empty streams suffice.
  useDoubts: () => ({ doubts: [], count: 0, loading: false, hasServerData: true }),
  // Board reads its viewer-scoped own Proofs for the DoubtBadge (#106 finding 4)
  // rather than the Board-wide feed; these proof-gating tests never assert a Doubt.
  useMyProofs: () => ({ proofs: [], loading: false, hasServerData: true }),
  useProofsForItemText: () => ({ proofs: [], loading: false, hasServerData: true }),
}));
// Stub the Moment broadcasts (#34): these tests never cross a bingo/blackout edge
// so none fires, and mocking the module also keeps Board's real
// src/data/moments.ts (which imports the prod ../firebase singleton) from loading
// getAuth() into this suite, which does not stub ../firebase.
// hasPriorBingoWitness (the finding-D durable-witness check) is stubbed to the
// no-witness default for the same reason; with no edge crossed it is never called.
// The pending-Moment queue exports (issue #104) are stubbed too: Board's drain runs
// on mount and doMark enqueues on every honor mark, so peekPendingMoments must
// resolve to an empty triple (these gating tests never cross an edge, so the stubs'
// behaviour is inert — no broadcast fires).
vi.mock('../data/moments', () => ({
  // #267: the per-card blackout queue reads — inert stubs (empty queue).
  pendingBlackoutDayIndexes: vi.fn(() => []),
  pendingBingoDayIndex: vi.fn(() => undefined),
  pendingFirstBingoDayIndex: vi.fn(() => undefined),
  removePendingBlackoutDay: vi.fn(),
  broadcastBingo: vi.fn(),
  broadcastBlackout: vi.fn(),
  broadcastFirstBingo: vi.fn(),
  hasPriorBingoWitness: vi.fn(() => Promise.resolve(false)),
  enqueueWinMoments: vi.fn(),
  enqueueFirstBingoMoment: vi.fn(),
  peekPendingMoments: vi.fn(() => ({ bingo: false, blackout: false, firstBingo: false })),
  clearPendingMoment: vi.fn(),
  // PR #110 hardening: doMark drops fallen wins on every unmark (dropPendingWins),
  // reads the action generation around the witness await, and the drain checks the
  // ceremonial candidate's enqueue stamp (firstBingoCandidateCurrent); inert here.
  dropPendingWins: vi.fn(),
  enqueueRetraction: vi.fn(),
  drainRetractions: vi.fn(),
  pendingActionGeneration: vi.fn(() => 0),
  firstBingoCandidateCurrent: vi.fn(() => false),
}));
// Board imports the Doubt derivation (#33), whose real module pulls the prod
// ../firebase singleton (like ../data/moments above). This suite does NOT stub
// ../firebase, so stub ../data/doubts to keep getAuth() from loading. No Doubt is
// exercised here (useDoubts is empty and the Tally sheet never opens), so the
// derivation stubs just need to yield "no open Doubts".
vi.mock('../data/doubts', () => ({
  raiseDoubt: vi.fn(),
  openDoubts: () => [],
  doubtStatusFor: () => 'none',
}));
// Board resolves the caller's display name via resolveDisplayName (fed the player
// row) for BOTH the Tally marker and ProofSheet (#31/#78). Stub it here to mirror
// the real resolver for the mark flow; its validated behaviour is unit-tested in
// src/data/w2-tally.test.ts and against the rules in tests/rules/w2-tally.test.ts.
vi.mock('../data/api', () => ({
  // Reshuffle (#378): Board reads the allowance for the day-bar chip and
  // ReshuffleSheet imports the write; stubbed so the imports resolve. The chip's
  // own behaviour is proven in src/components/reshuffle-chip.test.tsx.
  RESHUFFLE_ALLOWANCE: 3,
  reshuffleBoard: vi.fn(async () => 1),
  setMark: H.setMark,
  dealDayCard: vi.fn(() => Promise.resolve(false)),
  resolveDisplayName: (
    profile: { displayName?: unknown } | null | undefined,
    fallback: string | null | undefined,
  ) =>
    typeof profile?.displayName === 'string' &&
    profile.displayName.trim().length > 0 &&
    profile.displayName.length <= 100
      ? profile.displayName
      : (fallback ?? 'Anonymous'),
}));
vi.mock('../data/proofs', () => ({ attachProof: H.attachProof }));
vi.mock('../analytics', () => ({ track: H.track }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: H.user, loading: false, signIn: vi.fn(), signOutUser: vi.fn() }),
}));
// CoachOverlay (#214) imports EVENT_ID from '../firebase' — mocked so
// mounting Board here never touches the real Firebase app init.
vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));

import Board from './Board';
import ProofSheet from './ProofSheet';

// A dealt board: every non-free Square unmarked, the free center (12) "on".
function dealt(): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `i${index}`,
    text: index === 12 ? 'FREE' : `Prompt ${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
}

const cell = (over: Partial<Cell> = {}): Cell => ({
  index: 0,
  itemId: 'i0',
  text: 'Saw a sailor in Speedos',
  free: false,
  marked: false,
  markedAt: null,
  ...over,
});

// jsdom lacks these browser APIs ProofSheet touches. Stub them once. Three
// module-level knobs simulate the platform surface #295 exercises:
//   - `isTypeSupportedMock` — which mimeType candidates the "browser" claims
//     to support (a Safari-like env: webm variants false, mp4 variants true).
//   - `reportedMimeType` — what the constructed recorder's OWN `.mimeType`
//     reports once started, independent of the requested option (a real
//     recorder can normalize what it was asked for — e.g. drop a codecs
//     suffix — so ProofSheet must read THIS, not the requested candidate).
//   - `nextStopEmpty` — makes the next `stop()` fire with NO data chunks, to
//     exercise the empty-clip guard.
const isTypeSupportedMock = vi.fn((_type: string) => true);
let reportedMimeType: string | undefined;
let nextStopEmpty = false;

class FakeMediaRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  mimeType: string;
  static isTypeSupported = isTypeSupportedMock;
  constructor(
    public stream: unknown,
    options?: { mimeType?: string },
  ) {
    this.mimeType = reportedMimeType ?? options?.mimeType ?? '';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    if (!nextStopEmpty) {
      this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType || 'audio/webm' }) });
    }
    this.onstop?.();
  }
}

beforeAll(() => {
  (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
  (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'u1', displayName: 'Deck Daddy', photoURL: null };
  H.board = null;
  H.player = null;
  H.event = null;
  H.setMark.mockResolvedValue({ cells: [], bingo: false, blackout: false });
  H.attachProof.mockResolvedValue(undefined);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  // Reset the #295 platform knobs to the "most browsers" default (every
  // candidate supported) before every test; individual tests below override.
  (FakeMediaRecorder as unknown as { isTypeSupported?: unknown }).isTypeSupported = isTypeSupportedMock;
  isTypeSupportedMock.mockReset();
  isTypeSupportedMock.mockImplementation(() => true);
  reportedMimeType = undefined;
  nextStopEmpty = false;
});

describe('ProofSheet — each capture type produces a valid submit and closes', () => {
  const baseProps = () => ({
    uid: 'u1',
    displayName: 'Deck Daddy',
    photoURL: null,
    cells: dealt(),
    cell: cell(),
    claimMode: 'proof_required' as const,
    currentFirstBingoAt: null,
    onClose: vi.fn(),
  });

  it('a photo submit attaches a photo Proof and closes the sheet', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const { container } = render(<ProofSheet {...props} />);

    // Photo opens pre-selected (#309 — specs/w4-honor-pledge.md § Tightened
    // sheet), so this click is a harmless re-select of the default segment.
    await user.click(screen.getByRole('button', { name: /photo/i }));
    const file = new File(['img'], 'proof.jpg', { type: 'image/jpeg' });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    expect(H.attachProof.mock.calls[0][0]).toMatchObject({
      uid: 'u1',
      cellIndex: 0,
      itemText: 'Saw a sailor in Speedos',
      proof: { type: 'photo', blob: file },
    });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('a text submit attaches a trimmed text Proof and closes the sheet', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /callout/i }));
    await user.type(screen.getByRole('textbox'), '  he did NOT  ');
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    expect(H.attachProof.mock.calls[0][0].proof).toEqual({ type: 'text', text: 'he did NOT' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('an audio submit attaches a recorded audio Proof and closes the sheet', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /sound/i }));
    await user.click(screen.getByRole('button', { name: /record/i }));
    // startRec awaits getUserMedia; once recording, a Stop button appears.
    await user.click(await screen.findByRole('button', { name: /stop/i }));
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    expect(H.attachProof.mock.calls[0][0].proof.type).toBe('audio');
    expect(H.attachProof.mock.calls[0][0].proof.blob).toBeInstanceOf(Blob);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('Cancel closes the sheet WITHOUT attaching a Proof (the Square stays unmarked)', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(H.attachProof).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it('keeps the capture for retry when a submit fails, then closes on the retry (capture-then-retry, ADR 0006)', async () => {
    // attachProof cannot queue offline (transaction + media upload need signal),
    // so a failed submit must not lose the captured photo — the sheet stays open
    // with the preview so the Player retries when signal returns.
    const user = userEvent.setup();
    const props = baseProps();
    const { container } = render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /photo/i }));
    const file = new File(['img'], 'proof.jpg', { type: 'image/jpeg' });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    H.attachProof.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    // The sheet stays open (not closed) and the captured preview is retained.
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    expect(props.onClose).not.toHaveBeenCalled();
    expect(container.querySelector('img.preview')).toBeInTheDocument();

    // Retry now succeeds — same capture, no re-shoot — and the sheet closes.
    H.attachProof.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole('button', { name: /mark it/i }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(H.attachProof).toHaveBeenCalledTimes(2);
  });

  it('re-selecting a photo revokes the previous object URL (no blob: leak on retake / Take photo ↔ Library switch — mirrors the audio re-record revoke)', async () => {
    // The e2e runner would exercise the real upload end-to-end, but it is
    // emulator-backed (Java) and not runnable here; this component regression
    // covers the fixed failure path — onPhoto used to createObjectURL on every
    // pick without ever revoking the prior URL, orphaning it for the page's
    // lifetime. Distinct URLs per createObjectURL so we can assert the FIRST is
    // revoked when the second is picked.
    const user = userEvent.setup();
    const origCreate = globalThis.URL.createObjectURL;
    let n = 0;
    (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
      `blob:mock-${n++}`;
    const revokeSpy = globalThis.URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
    try {
      const props = baseProps();
      const { container } = render(<ProofSheet {...props} />);

      await user.click(screen.getByRole('button', { name: /photo/i }));
      const input = () => container.querySelector('input[type="file"]') as HTMLInputElement;

      // First pick mints blob:mock-0 — nothing to revoke yet.
      await user.upload(input(), new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
      expect(revokeSpy).not.toHaveBeenCalled();
      expect(container.querySelector('img.preview')).toHaveAttribute('src', 'blob:mock-0');

      // Second pick (a retake / Library switch) must revoke the first URL and
      // show the new one — no orphaned blob: URL.
      await user.upload(input(), new File(['b'], 'b.jpg', { type: 'image/jpeg' }));
      expect(revokeSpy).toHaveBeenCalledWith('blob:mock-0');
      expect(revokeSpy).toHaveBeenCalledTimes(1);
      expect(container.querySelector('img.preview')).toHaveAttribute('src', 'blob:mock-1');
    } finally {
      globalThis.URL.createObjectURL = origCreate;
    }
  });

  it('under React.StrictMode, re-selecting a photo leaks no object URL (dev double-invoke of the setter must not orphan a blob: URL — Codex P3, #330)', async () => {
    // StrictMode double-invokes state updaters in dev, so a createObjectURL
    // INSIDE the updater would mint a second, unstored URL that never gets
    // revoked. Track every created vs revoked URL: after a retake, every
    // created URL must be either revoked OR the one currently shown — nothing
    // orphaned.
    const user = userEvent.setup();
    const origCreate = globalThis.URL.createObjectURL;
    const created: string[] = [];
    let n = 0;
    (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
      const u = `blob:mock-${n++}`;
      created.push(u);
      return u;
    };
    const revokeSpy = globalThis.URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
    try {
      const props = baseProps();
      const { container } = render(
        <StrictMode>
          <ProofSheet {...props} />
        </StrictMode>,
      );

      await user.click(screen.getByRole('button', { name: /photo/i }));
      const input = () => container.querySelector('input[type="file"]') as HTMLInputElement;

      await user.upload(input(), new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
      await user.upload(input(), new File(['b'], 'b.jpg', { type: 'image/jpeg' }));

      const shown = container.querySelector('img.preview')?.getAttribute('src');
      const revoked = new Set(revokeSpy.mock.calls.map((c) => c[0] as string));
      const orphaned = created.filter((u) => u !== shown && !revoked.has(u));
      expect(orphaned).toEqual([]);
    } finally {
      globalThis.URL.createObjectURL = origCreate;
    }
  });

  it('never frames the Proof as required for credit (flavour, not enforcement — ADR 0001)', () => {
    render(<ProofSheet {...baseProps()} />);
    expect(screen.queryByText(/required for credit/i)).toBeNull();
    expect(screen.queryByText(/must.*(prove|proof)/i)).toBeNull();
  });
});

// #295: iOS Safari's MediaRecorder records MP4/AAC, not WebM — the pre-fix
// code always constructed `new MediaRecorder(stream)` (no mimeType) and then
// hardcoded the resulting Blob as 'audio/webm' regardless of what was
// actually recorded, so Safari's preview player couldn't decode it and the
// same mislabeled/empty clip still uploaded to the Feed. These tests drive
// the recording knobs (`isTypeSupportedMock`, `reportedMimeType`,
// `nextStopEmpty`) declared above to simulate that platform surface.
describe('ProofSheet — Sound proof records a Safari-playable format + blocks empty clips (#295)', () => {
  const baseProps = () => ({
    uid: 'u1',
    displayName: 'Deck Daddy',
    photoURL: null,
    cells: dealt(),
    cell: cell(),
    claimMode: 'proof_required' as const,
    currentFirstBingoAt: null,
    onClose: vi.fn(),
  });

  it('prefers WebM/Opus when the platform supports it, and the Blob carries the recorder’s ACTUAL reported mimeType', async () => {
    // Default knob state (set in beforeEach): every candidate "supported" —
    // the common-browser case. pickAudioMimeType() picks the FIRST candidate
    // in preference order, so the requested (and here, reported) type is
    // 'audio/webm;codecs=opus'.
    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /sound/i }));
    await user.click(screen.getByRole('button', { name: /record/i }));
    await user.click(await screen.findByRole('button', { name: /stop/i }));
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    const blob = H.attachProof.mock.calls[0][0].proof.blob as Blob;
    expect(blob.type).toBe('audio/webm;codecs=opus');
  });

  it('Safari-like environment: WebM unsupported, MP4 supported — records MP4/AAC and the Blob is typed audio/mp4, not audio/webm', async () => {
    // isTypeSupported denies every webm candidate and allows every mp4
    // candidate (Safari's real MediaRecorder behavior); the recorder then
    // REPORTS a bare 'audio/mp4' once running — normalized down from the
    // codecs-qualified candidate ProofSheet requested. ProofSheet must read
    // that ACTUAL `.mimeType`, not assume the requested candidate survived
    // verbatim, and must never fall back to the old hardcoded 'audio/webm'.
    isTypeSupportedMock.mockImplementation((type: string) => type.startsWith('audio/mp4'));
    reportedMimeType = 'audio/mp4';

    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /sound/i }));
    await user.click(screen.getByRole('button', { name: /record/i }));
    await user.click(await screen.findByRole('button', { name: /stop/i }));
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    const blob = H.attachProof.mock.calls[0][0].proof.blob as Blob;
    expect(blob.type).toBe('audio/mp4');
    expect(blob.type).not.toBe('audio/webm');
  });

  it('guards `MediaRecorder.isTypeSupported` absence: records with no mimeType option and still produces a playable, non-empty Blob', async () => {
    // A very old MediaRecorder implementation with no `isTypeSupported` at
    // all — pickAudioMimeType() must not throw or assume the method exists;
    // it returns undefined, `new MediaRecorder(stream)` is called with no
    // options (the pre-#295 call shape), and the recorded Blob still gets a
    // sane type from the recorder's own (possibly empty) `.mimeType`.
    delete (FakeMediaRecorder as unknown as { isTypeSupported?: unknown }).isTypeSupported;

    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /sound/i }));
    await user.click(screen.getByRole('button', { name: /record/i }));
    await user.click(await screen.findByRole('button', { name: /stop/i }));
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    const blob = H.attachProof.mock.calls[0][0].proof.blob as Blob;
    expect(blob.type).toBe('audio/webm'); // the documented fallback default
    expect(blob.size).toBeGreaterThan(0);
  });

  it('empty-clip guard: a recording that stops with zero data chunks shows an error and blocks "Mark it" (no unplayable Proof reaches attachProof)', async () => {
    nextStopEmpty = true;

    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /sound/i }));
    await user.click(screen.getByRole('button', { name: /record/i }));
    await user.click(await screen.findByRole('button', { name: /stop/i }));

    // The error state renders, and the audio tab offers no preview to submit.
    expect(await screen.findByRole('alert')).toHaveTextContent(/came out empty/i);
    expect(document.querySelector('audio.preview')).toBeNull();

    // "Mark it" stays disabled — the `valid` gate requires a captured audio
    // Blob for the audio tab, so a submit attempt is a no-op either way.
    expect(screen.getByRole('button', { name: /mark it/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /mark it/i }));
    expect(H.attachProof).not.toHaveBeenCalled();
  });

  it('empty-clip guard: re-recording after an empty clip clears the error and allows a normal submit', async () => {
    nextStopEmpty = true;
    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /sound/i }));
    await user.click(screen.getByRole('button', { name: /record/i }));
    await user.click(await screen.findByRole('button', { name: /stop/i }));
    await screen.findByRole('alert');

    nextStopEmpty = false;
    await user.click(screen.getByRole('button', { name: /record/i }));
    await user.click(await screen.findByRole('button', { name: /stop/i }));

    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: /mark it/i }));
    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
  });

  it('empty-clip guard: re-recording retires the prior valid clip before a new empty stop can submit stale audio', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ProofSheet {...props} />);

    await user.click(screen.getByRole('button', { name: /sound/i }));
    await user.click(screen.getByRole('button', { name: /record/i }));
    await user.click(await screen.findByRole('button', { name: /stop/i }));
    expect(screen.getByRole('button', { name: /mark it/i })).toBeEnabled();

    nextStopEmpty = true;
    await user.click(screen.getByRole('button', { name: /re-record/i }));
    expect(screen.getByRole('button', { name: /mark it/i })).toBeDisabled();

    await user.click(await screen.findByRole('button', { name: /stop/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/came out empty/i);
    expect(screen.getByRole('button', { name: /mark it/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /mark it/i }));
    expect(H.attachProof).not.toHaveBeenCalled();
  });
});

describe('Board — proof-to-mark gating (ADR 0001: friction, not trust)', () => {
  const clickCell = (index: number) => {
    // `.cell-claim` is the Square's claim button — the tile div is a
    // positioning shell, so the handler lives on the button that fills it.
    const cells = document.querySelectorAll('.grid .cell .cell-claim');
    fireEvent.click(cells[index]);
  };

  it('proof_required: tapping an unmarked Square opens ProofSheet and does NOT mark', async () => {
    H.event = { claimMode: 'proof_required' } as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);
    clickCell(0); // a non-free, unmarked Square

    expect(await screen.findByText(/proof for/i)).toBeInTheDocument();
    expect(H.setMark).not.toHaveBeenCalled(); // no Mark until a Proof is attached
  });

  it('proof_required: cancelling the sheet leaves the Square unmarked', async () => {
    const user = userEvent.setup();
    H.event = { claimMode: 'proof_required' } as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);
    clickCell(0);
    await screen.findByText(/proof for/i);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText(/proof for/i)).toBeNull());
    expect(H.setMark).not.toHaveBeenCalled();
    expect(H.attachProof).not.toHaveBeenCalled();
  });

  it('proof_required: unmarking an already-marked Square stays instant (no proof gate on unmark)', async () => {
    H.event = { claimMode: 'proof_required' } as EventDoc;
    const cells = dealt();
    cells[0] = { ...cells[0], marked: true, markedAt: 1, status: 'confirmed' };
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells };

    render(<Board />);
    clickCell(0);

    await waitFor(() => expect(H.setMark).toHaveBeenCalledTimes(1));
    expect(H.setMark.mock.calls[0][0]).toMatchObject({ index: 0, nextMarked: false });
    expect(screen.queryByText(/proof for/i)).toBeNull(); // no sheet on unmark
  });

  it('honor: a claim tap opens the sheet, and the 🎖️ pledge marks WITHOUT any Proof (issue #181; a Proof never gates credit)', async () => {
    const user = userEvent.setup();
    H.event = { claimMode: 'honor' } as EventDoc;
    H.board = { uid: 'u1', dayIndex: 0, seed: 1, createdAt: 0, cells: dealt() };

    render(<Board />);
    clickCell(0);

    // The sheet opens instead of the old instant mark…
    expect(await screen.findByText(/proof for/i)).toBeInTheDocument();
    expect(H.setMark).not.toHaveBeenCalled();

    // …and the pledge IS the claim: one tap marks through the bare setMark
    // (no attachProof — the pledge writes no Proof doc) and closes the sheet.
    await user.click(screen.getByRole('button', { name: /cross my heart/i }));

    await waitFor(() => expect(H.setMark).toHaveBeenCalledTimes(1));
    expect(H.setMark.mock.calls[0][0]).toMatchObject({ index: 0, nextMarked: true, claimMode: 'honor' });
    expect(H.attachProof).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/proof for/i)).toBeNull());
  });
});
