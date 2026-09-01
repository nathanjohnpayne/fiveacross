import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell } from '../types';

// w2-proof-capture, data layer. Drives the REAL attachProof / deleteProof write
// paths (src/data/proofs.ts) with Firestore stubbed to inspectable spies — no
// emulator. Three concerns:
//   1. attachProof posts an `active`, Feed-visible Proof (ADR 0002: the Proof
//      IS the Feed entry) carrying the Player name + Prompt text + type, and
//      marks the backing cell — for photo, audio, AND text. admin_confirmed
//      starts the Proof `pending` (admin-only readable) + files a claim.
//   2. The proof→cell link is written into the proof DOC itself (uid +
//      cellIndex) — the authoritative, clobber-resilient link the PR #75
//      cross-writer constraint requires — and deleteProof resolves the backing
//      cell by that cellIndex, not by scanning cells[i].proofId.
//   3. attachProof is ONLINE-only (ADR 0006): the media upload needs signal and
//      the transaction rejects offline, so it does NOT queue — it rejects, and
//      the capture is retried (ProofSheet, w2-proof-capture.test.tsx). The
//      offline-durable path is the bare honor Mark (tests/offline/w1-...).

const EVENT_ID = 'med-2026'; // src/firebase.ts default when VITE_EVENT_ID is unset

type Ref = { __kind: 'doc' | 'collection'; id?: string; path: string };
type Snap = { data: () => unknown };

const { activeEvent, txGet, txSet, txDelete, runTx, uploadSpy, deleteStorageSpy, purgeCacheSpy } = vi.hoisted(() => ({
  activeEvent: { id: 'med-2026' },
  txGet: vi.fn(),
  txSet: vi.fn(),
  txDelete: vi.fn(),
  runTx: vi.fn(),
  uploadSpy: vi.fn(),
  deleteStorageSpy: vi.fn(),
  purgeCacheSpy: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: {},
  get EVENT_ID() {
    return activeEvent.id;
  },
  storage: {},
}));
// storage.ts talks to Cloud Storage; stub the two functions proofs.ts uses so we
// never touch a real bucket (uploadProofMedia is exercised for real against the
// emulator by tests/rules/w0-storage-rules.test.ts).
vi.mock('./storage', () => ({ uploadProofMedia: uploadSpy, deleteStoragePath: deleteStorageSpy }));
// #373: deleteProof's post-commit local-cache purge — spied so the wiring
// tests below can assert WHEN/WITH-WHAT it's called without touching a real
// `caches` bucket (the purge helper itself is unit-tested for real against a
// stubbed `caches` global in proofMediaCache.test.ts).
vi.mock('./proofMediaCache', () => ({ purgeProofMediaFromCaches: purgeCacheSpy }));

let autoSeq = 0;
vi.mock('firebase/firestore', () => {
  class MockFieldPath {
    segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
    isEqual(other: MockFieldPath) {
      return this.segments.join('\u0001') === other.segments.join('\u0001');
    }
  }
  return {
  FieldPath: MockFieldPath,
  collection: (_db: unknown, ...segments: string[]): Ref => ({
    __kind: 'collection',
    path: segments.join('/'),
  }),
  doc: (a: unknown, ...rest: string[]): Ref => {
    // doc(collectionRef) — an auto-id child ref (proofs / claims).
    if (a && (a as Ref).__kind === 'collection' && rest.length === 0) {
      const col = (a as Ref).path;
      const id = `auto-${col.split('/').pop()}-${autoSeq++}`;
      return { __kind: 'doc', id, path: `${col}/${id}` };
    }
    // doc(db, ...segments) — an explicit path ref (boards / players / a proof by id).
    return { __kind: 'doc', id: rest[rest.length - 1], path: rest.join('/') };
  },
  runTransaction: (_db: unknown, fn: (tx: unknown) => unknown) => runTx(_db, fn),
  increment: (n: number) => ({ __inc: n }),
  updateDoc: vi.fn(),
  };
});

import { attachProof, deleteProof } from './proofs';

// A dealt board: every non-free Square unmarked, the free center (12) "on".
function dealt(): Cell[] {
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `i${index}`,
    text: index === 12 ? 'FREE' : `p${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
}

// Mutable per-test server state the transaction reads through tx.get(ref).
let boardState: { cells: Cell[] } | undefined;
let playerState: Record<string, unknown> | undefined;
let proofState: Record<string, unknown> | undefined;
let markerState: Record<string, unknown> | undefined; // an existing Tally marker, if any

// The tx.set payload written to the first ref whose path contains `frag`.
function setPayload(frag: string): Record<string, unknown> | undefined {
  const call = txSet.mock.calls.find((c) => (c[0] as Ref).path.includes(frag));
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  activeEvent.id = EVENT_ID;
  autoSeq = 0;
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  boardState = { cells: dealt() };
  playerState = { firstBingoAt: null };
  proofState = undefined;
  markerState = undefined;
  uploadSpy.mockResolvedValue({
    path: `proofs/${EVENT_ID}/u1/UPLOADED.jpg`,
    url: `https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2F${EVENT_ID}%2Fu1%2FUPLOADED.jpg?alt=media`,
  });
  purgeCacheSpy.mockResolvedValue(undefined);
  runTx.mockImplementation((_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({ get: txGet, set: txSet, delete: txDelete }),
  );
  txGet.mockImplementation((ref: Ref): Promise<Snap> => {
    if (ref.path.includes('/boards/')) return Promise.resolve({ data: () => boardState });
    if (ref.path.includes('/players/')) return Promise.resolve({ data: () => playerState });
    if (ref.path.includes('/proofs/')) return Promise.resolve({ data: () => proofState });
    if (ref.path.includes('/tally/')) return Promise.resolve({ data: () => markerState });
    return Promise.resolve({ data: () => undefined });
  });
});

const baseArgs = {
  uid: 'u1',
  displayName: 'Deck Daddy',
  photoURL: null as string | null,
  cells: dealt(),
  cellIndex: 5,
  itemId: 'i5' as string | null, // the Prompt cell 5 tallies (dealt()[5].itemId)
  itemText: 'Saw a sailor in Speedos',
  currentFirstBingoAt: null as number | null,
};

describe('attachProof — posts an active Proof to the Feed and marks the cell (ADR 0002)', () => {
  it('keeps a delayed Event A media attach and every transaction ref under A', async () => {
    let releaseUpload!: (value: { path: string; url: string }) => void;
    uploadSpy.mockImplementationOnce(
      () =>
        new Promise<{ path: string; url: string }>((resolve) => {
          releaseUpload = resolve;
        }),
    );
    activeEvent.id = 'event-a';
    const attaching = attachProof({
      ...baseArgs,
      claimMode: 'proof_required',
      proof: { type: 'photo', blob: new Blob(['x'], { type: 'image/jpeg' }) },
    });
    await vi.waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));

    activeEvent.id = 'event-b';
    releaseUpload({
      path: 'proofs/event-a/u1/uploaded.jpg',
      url: 'https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2Fevent-a%2Fu1%2Fuploaded.jpg?alt=media',
    });
    await attaching;

    expect(uploadSpy.mock.calls[0][4]).toMatchObject({ eventId: 'event-a' });
    const eventPaths = [...txGet.mock.calls, ...txSet.mock.calls]
      .map(([ref]) => (ref as Ref).path)
      .filter((path) => path.startsWith('events/'));
    expect(eventPaths.length).toBeGreaterThan(0);
    expect(eventPaths.every((path) => path.startsWith('events/event-a/'))).toBe(true);
  });

  it('writes an active, Feed-visible photo Proof with the Player name + Prompt text, and marks the cell', async () => {
    await attachProof({
      ...baseArgs,
      claimMode: 'proof_required',
      proof: { type: 'photo', blob: new Blob(['x'], { type: 'image/jpeg' }) },
    });

    // Media uploaded under the owner's folder, keyed by the proof's own id. The
    // 5th arg is the #211 EXIF-strip options bag (undefined stripExif here — the
    // strip default lives in uploadProofMedia; see src/data/d15-claim-sheet-photo.test.ts).
    expect(uploadSpy).toHaveBeenCalledWith('u1', expect.any(String), expect.any(Blob), 'photo', {
      stripExif: undefined,
      eventId: EVENT_ID,
    });

    const proof = setPayload('/proofs/')!;
    // Feed-visible immediately, and it carries the name + prompt the Feed renders.
    expect(proof.status).toBe('active');
    expect(proof.displayName).toBe('Deck Daddy');
    expect(proof.itemText).toBe('Saw a sailor in Speedos');
    expect(proof.type).toBe('photo');
    expect(proof.createdAt).toBe(1000); // the feed sorts newest-first by createdAt
    expect(proof.reportCount).toBe(0);
    // Moderation fields are server-set (firestore.rules): never client-forged.
    expect(proof.visionFlag).toBeNull();
    expect(proof.thumbURL).toBeNull();
    // The upload result is wired into the doc so the Feed can render the media.
    expect(proof.storagePath).toBe(`proofs/${EVENT_ID}/u1/UPLOADED.jpg`);
    expect(proof.mediaURL).toContain('firebasestorage');
    expect(proof.text).toBeNull();

    // The backing cell is marked-confirmed and references the proof.
    const board = setPayload('/boards/') as { cells: Cell[]; directAnalyticsRequest?: Record<string, unknown> };
    expect(board.cells[5]).toMatchObject({ marked: true, markedAt: 1000, status: 'confirmed' });
    expect(board.directAnalyticsRequest).toMatchObject({
      cellIndex: 5,
      marked: true,
      mode: 'proof_required',
      source: 'proof',
      id: expect.any(String),
    });
    expect(typeof board.cells[5].proofId).toBe('string');
    // proof_required credits the square (not pending), so it counts.
    expect(setPayload('/players/')).toMatchObject({ squaresMarked: 1 });
  });

  it('turns a proofed Echo into a local Mark so the card is no longer reshuffleable', async () => {
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 999, status: 'confirmed', echo: true };
    boardState = { cells: board };

    await attachProof({
      ...baseArgs,
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'I saw it' },
    });

    const written = setPayload('/boards/') as { cells: Cell[] };
    expect(written.cells[5]).not.toHaveProperty('echo');
    expect(written.cells[5].proofId).toEqual(expect.any(String));
  });

  it('the proof→cell link lives in the proof DOC (uid + cellIndex) — the authoritative, clobber-resilient link (PR #75)', async () => {
    await attachProof({
      ...baseArgs,
      cellIndex: 5,
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'ask him yourself' },
    });

    const proof = setPayload('/proofs/')!;
    // The Proof carries its own uid + cellIndex, so the proof→cell link is
    // resolvable from the proofs doc alone. A queued bare-Mark drain can drop
    // cells[i].proofId, but never this — the Feed and any repair pass re-resolve
    // the link from here (specs/w1-board-mark-win.md § cross-writer).
    expect(proof.uid).toBe('u1');
    expect(proof.cellIndex).toBe(5);
    // The proofId written into the cell equals the proof doc's own id, so the
    // denormalized projection points back at the authoritative doc.
    const proofRef = txSet.mock.calls.find((c) => (c[0] as Ref).path.includes('/proofs/'))![0] as Ref;
    const board = setPayload('/boards/') as { cells: Cell[] };
    expect(board.cells[5].proofId).toBe(proofRef.id);
  });

  it('a text Proof uploads no media (storagePath / mediaURL null) and carries the callout text', async () => {
    await attachProof({
      ...baseArgs,
      claimMode: 'proof_required',
      proof: { type: 'text', text: '  he did NOT  ' },
    });

    expect(uploadSpy).not.toHaveBeenCalled();
    const proof = setPayload('/proofs/')!;
    expect(proof.type).toBe('text');
    expect(proof.storagePath).toBeNull();
    expect(proof.mediaURL).toBeNull();
    expect(proof.text).toBe('  he did NOT  '); // ProofSheet trims; attachProof stores as given
    expect(proof.status).toBe('active');
  });

  it('an audio Proof uploads a webm clip', async () => {
    uploadSpy.mockResolvedValueOnce({
      path: `proofs/${EVENT_ID}/u1/UPLOADED.webm`,
      url: `https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2F${EVENT_ID}%2Fu1%2FUPLOADED.webm?alt=media`,
    });
    await attachProof({
      ...baseArgs,
      claimMode: 'honor',
      proof: { type: 'audio', blob: new Blob(['x'], { type: 'audio/webm' }) },
    });

    // 5th arg = the #211 strip options bag; inert for audio (no EXIF).
    expect(uploadSpy).toHaveBeenCalledWith('u1', expect.any(String), expect.any(Blob), 'audio', {
      stripExif: undefined,
      eventId: EVENT_ID,
    });
    const proof = setPayload('/proofs/')!;
    expect(proof.type).toBe('audio');
    expect(proof.storagePath).toBe(`proofs/${EVENT_ID}/u1/UPLOADED.webm`);
  });

  it('admin_confirmed starts the Proof pending (admin-only readable), holds the cell pending, and files a claim', async () => {
    await attachProof({
      ...baseArgs,
      claimMode: 'admin_confirmed',
      proof: { type: 'text', text: 'confirm me' },
    });

    const proof = setPayload('/proofs/')!;
    expect(proof.status).toBe('pending'); // NOT publicly visible until an admin confirms

    const board = setPayload('/boards/') as { cells: Cell[] };
    expect(board.cells[5].status).toBe('pending');
    // A pending square does not yet count toward stats (the mask excludes pending).
    expect(setPayload('/players/')).toMatchObject({ squaresMarked: 0 });

    // A claim is filed for the admin queue, referencing the proof + cell.
    const claim = setPayload('/claims/')!;
    expect(claim).toMatchObject({ uid: 'u1', cellIndex: 5, status: 'pending' });
    expect(typeof claim.proofId).toBe('string');
  });

  it('folds onto the LIVE board inside the transaction so a concurrent mark is not clobbered', async () => {
    // Another of the owner's writes already marked index 3 on the server; the
    // caller's `cells` prop predates it. The transaction reads the live board,
    // so both marks survive — this live read is exactly why attachProof needs a
    // server round-trip (and therefore cannot queue offline).
    const live = dealt();
    live[3] = { ...live[3], marked: true, markedAt: 1, status: 'confirmed' };
    boardState = { cells: live };

    await attachProof({
      ...baseArgs,
      cells: dealt(), // stale: does not know about index 3
      cellIndex: 7,
      itemId: 'i7', // marker follows the marked cell (dealt()[7].itemId)
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'both' },
    });

    const board = setPayload('/boards/') as { cells: Record<string, Cell> };
    // #457 per-cell merge: only the proofed cell rides the write; the live
    // concurrent mark at 3 survives by never being written.
    expect(board.cells['7'].marked).toBe(true); // this proof's mark
    expect('3' in board.cells).toBe(false); // untouched → never clobbered
    expect(setPayload('/players/')).toMatchObject({ squaresMarked: 2 });
  });
});

// #211 (specs/d15-claim-sheet-photo.md): attachProof stamps the photo affordance
// (`source`) and the viewed Day (`dayIndex`) onto the Proof doc, and threads the
// event's `stripPhotoExif` down to uploadProofMedia. The strip mechanism itself
// is unit-tested against a re-encoded blob in src/data/d15-claim-sheet-photo.test.tsx.
describe('attachProof — #211: source / dayIndex stamp + EXIF-strip flag pass-through', () => {
  it('stamps source and dayIndex on the Proof doc from a 🖼️ library pick, and passes stripExif through', async () => {
    await attachProof({
      ...baseArgs,
      claimMode: 'proof_required',
      source: 'library',
      dayIndex: 2,
      stripExif: true,
      proof: { type: 'photo', blob: new Blob(['x'], { type: 'image/jpeg' }) },
    });
    const proof = setPayload('/proofs/')!;
    expect(proof.source).toBe('library');
    expect(proof.dayIndex).toBe(2);
    expect(uploadSpy).toHaveBeenCalledWith('u1', expect.any(String), expect.any(Blob), 'photo', {
      stripExif: true,
      eventId: EVENT_ID,
    });
  });

  it('leaves source/dayIndex null when omitted and threads stripExif:false to leave the existing re-encode', async () => {
    await attachProof({
      ...baseArgs,
      claimMode: 'proof_required',
      stripExif: false,
      proof: { type: 'photo', blob: new Blob(['x'], { type: 'image/jpeg' }) },
    });
    const proof = setPayload('/proofs/')!;
    expect(proof.source).toBeNull();
    expect(proof.dayIndex).toBeNull();
    expect(uploadSpy).toHaveBeenCalledWith('u1', expect.any(String), expect.any(Blob), 'photo', {
      stripExif: false,
      eventId: EVENT_ID,
    });
  });
});

// A dealt board with `indices` already marked-confirmed (for verdict tests).
function withMarked(indices: number[]): Cell[] {
  const cells = dealt();
  for (const i of indices) cells[i] = { ...cells[i], marked: true, markedAt: 1, status: 'confirmed' };
  return cells;
}

describe('attachProof — returns the win-transition verdict (PR #110 round 2 finding 1)', () => {
  // The SAME verdict shape setMark returns (return-shape change only — the write
  // set/transaction are untouched): Board broadcasts the proofed win's Moment off
  // it, exactly like an honor win. Transitions are computed against the LIVE prior
  // cells the transaction read, so a stale caller prop cannot fake an edge.

  it('reports a bingo TRANSITION when the attach completes the first line', async () => {
    boardState = { cells: withMarked([0, 1, 2, 3]) }; // row 0 one Square shy
    const res = await attachProof({
      ...baseArgs,
      cellIndex: 4,
      itemId: 'i4',
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'saw it happen' },
    });
    expect(res.bingo).toBe(true);
    expect(res.bingoTransition).toBe(true); // no-bingo → bingo, THIS attach crossed it
    expect(res.blackout).toBe(false);
    expect(res.blackoutTransition).toBe(false);
    // The folded post-attach board rides back for the drain's fire-time revalidation.
    expect(res.cells[4]).toMatchObject({ marked: true, status: 'confirmed' });
  });

  it('reports NO transition when the attach completes no line, and none while a line already stood', async () => {
    const res = await attachProof({
      ...baseArgs,
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'a lone mark' },
    });
    expect(res.bingo).toBe(false);
    expect(res.bingoTransition).toBe(false);

    boardState = { cells: withMarked([0, 1, 2, 3, 4]) }; // a standing top-row BINGO
    const further = await attachProof({
      ...baseArgs,
      cellIndex: 6,
      itemId: 'i6',
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'another one' },
    });
    expect(further.bingo).toBe(true); // still standing…
    expect(further.bingoTransition).toBe(false); // …but NOT a fresh edge
  });

  it('admin_confirmed: the pending cell is excluded from the win mask — NO transition at attach (the Moment belongs to the confirm path, #41)', async () => {
    boardState = { cells: withMarked([0, 1, 2, 3]) }; // would complete row 0 if confirmed
    const res = await attachProof({
      ...baseArgs,
      cellIndex: 4,
      itemId: 'i4',
      claimMode: 'admin_confirmed',
      proof: { type: 'text', text: 'pending claim' },
    });
    // The cell IS marked (the tally marker publishes at attach, #87) but PENDING —
    // and a pending claim can be REJECTED, so no immutable win Moment may exist for
    // it yet: the win mask excludes pending, and the verdict is structurally clean.
    expect(res.cells[4]).toMatchObject({ marked: true, status: 'pending' });
    expect(res.bingo).toBe(false);
    expect(res.bingoTransition).toBe(false);
    expect(res.blackoutTransition).toBe(false);
  });
});

describe('attachProof — ONLINE-only: it rejects offline rather than queuing (ADR 0006)', () => {
  it('rejects (does not queue) when the media upload has no signal — no proof doc is written', async () => {
    uploadSpy.mockRejectedValueOnce(new Error('storage/retry-limit-exceeded (offline)'));

    await expect(
      attachProof({
        ...baseArgs,
        claimMode: 'proof_required',
        proof: { type: 'photo', blob: new Blob(['x'], { type: 'image/jpeg' }) },
      }),
    ).rejects.toThrow();

    // The upload precedes the write, so nothing durable was written: the caller
    // (ProofSheet) keeps the capture and retries on reconnect — it does not queue.
    expect(txSet).not.toHaveBeenCalled();
    expect(runTx).not.toHaveBeenCalled();
  });

  it('rejects when the transaction cannot reach the server (a transaction rejects offline)', async () => {
    // Even a media-free text Proof cannot queue: attachProof rides a
    // runTransaction, which needs a round-trip and rejects offline.
    runTx.mockRejectedValueOnce(new Error('Failed to get document because the client is offline.'));

    await expect(
      attachProof({
        ...baseArgs,
        claimMode: 'proof_required',
        proof: { type: 'text', text: 'no signal' },
      }),
    ).rejects.toThrow(/offline/);
  });
});

describe('per-Prompt Tally marker — every proofed Mark publishes too (ADR 0002, specs/w2-tally.md)', () => {
  // #31 AC 3 + ADR 0002: a Mark is private on the Board but PUBLIC as an attributed
  // per-Prompt Tally; EVERY Mark — proofed or not — publishes a marker. setMark does
  // it for a bare honor Mark; attachProof must do it for a proofed Mark, in the SAME
  // transaction as the proof + board + player. Path/shape mirror setMark and
  // carry the path Event plus the Feed's denormalized Prompt/Day fields; doc id
  // IS the uid (forgery-deniable), name bounded to the rule's non-empty ≤100.
  const markerSet = () => txSet.mock.calls.find((c) => (c[0] as Ref).path.includes('/tally/'));

  it('proof_required: writes the attributed marker in the SAME transaction as the proof + board + player', async () => {
    await attachProof({
      ...baseArgs, // uid u1, cellIndex 5, itemId i5, displayName 'Deck Daddy'
      dayIndex: 2,
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'saw it' },
    });

    // One transaction — the marker is not a second write path (no extra runTx).
    expect(runTx).toHaveBeenCalledTimes(1);
    const call = markerSet();
    expect(call).toBeDefined();
    expect((call![0] as Ref).path).toBe(`events/${EVENT_ID}/tally/i5/markers/u1`);
    // The exact rules-valid shape: uid == doc id, non-empty ≤100 name, numeric stamp.
    // No marker existed (fresh mark), so markedAt is stamped `now` (1000).
    expect(call![1]).toEqual({
      uid: 'u1',
      eventId: EVENT_ID,
      displayName: 'Deck Daddy',
      markedAt: 1000,
      itemText: 'Saw a sailor in Speedos',
      dayIndex: 2,
    });
    // A Firestore transaction requires ALL reads before ANY write, and the marker
    // read (for the preserve-markedAt rule below) must obey it: pin that every
    // tx.get in the transaction ran before its first tx.set.
    expect(Math.max(...txGet.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...txSet.mock.invocationCallOrder),
    );
  });

  it('admin_confirmed: still publishes the marker — the pending cell is marked immediately, so it tallies like setMark', async () => {
    // The cell is set marked:true (status 'pending') in this same txn, so it
    // publishes exactly as setMark writes the marker on a pending Mark. If an admin
    // later REJECTS the claim and unmarks it, rejectClaim (src/data/admin.ts)
    // deletes this marker in ITS transaction — the marked→unmarked ↔ marker-delete
    // symmetry, pinned in src/data/w2-tally.test.ts.
    await attachProof({
      ...baseArgs,
      claimMode: 'admin_confirmed',
      proof: { type: 'text', text: 'confirm me' },
    });

    const call = markerSet();
    expect(call).toBeDefined();
    expect((call![0] as Ref).path).toBe(`events/${EVENT_ID}/tally/i5/markers/u1`);
    expect(call![1]).toEqual({
      uid: 'u1',
      eventId: EVENT_ID,
      displayName: 'Deck Daddy',
      markedAt: 1000,
      itemText: 'Saw a sailor in Speedos',
    });
  });

  it('preserves an existing marker’s original markedAt and refreshes its attribution (proof on an already-marked square)', async () => {
    // The Player marked this square earlier (bare Mark at t=111, under an older
    // name) and now attaches a Proof to it. Re-stamping markedAt with `now` would
    // reorder the chronological who-list by proof-attach time (Codex P2, PR #87):
    // the original stamp must survive, while uid/displayName refresh is fine.
    markerState = {
      uid: 'u1',
      eventId: EVENT_ID,
      displayName: 'Old Salt',
      markedAt: 111,
      itemText: 'Saw a sailor in Speedos',
      dayIndex: 2,
    };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 111, status: 'confirmed' };
    boardState = { cells: board };

    await attachProof({
      ...baseArgs, // displayName 'Deck Daddy'
      dayIndex: 2,
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'told you' },
    });

    const call = markerSet();
    expect(call![1]).toEqual({
      uid: 'u1',
      eventId: EVENT_ID,
      displayName: 'Deck Daddy',
      markedAt: 111,
      itemText: 'Saw a sailor in Speedos',
      dayIndex: 2,
    });
    expect(call![2]).toEqual({ merge: true });
    // The preserve requires reading the marker — and that read still precedes
    // every write, per the transaction contract.
    expect(Math.max(...txGet.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...txSet.mock.invocationCallOrder),
    );
  });

  it('bounds an over-long attributed name to the marker rule’s 100-char cap', async () => {
    await attachProof({
      ...baseArgs,
      displayName: 'x'.repeat(140),
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'long name' },
    });

    expect((markerSet()![1].displayName as string).length).toBe(100);
  });

  it('the free centre (null itemId) never writes a Tally marker', async () => {
    await attachProof({
      ...baseArgs,
      cellIndex: 12,
      itemId: null, // the free centre carries no Prompt
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'free' },
    });

    // The proof + board + player still write, but there is NO Tally marker.
    expect(setPayload('/proofs/')).toBeDefined();
    expect(markerSet()).toBeUndefined();
  });
});

describe('deleteProof — resolves the backing cell by the proof doc cellIndex (PR #75)', () => {
  it('keeps a delete that waits on Event A storage cleanup under Event A', async () => {
    let releaseStorageDelete!: () => void;
    deleteStorageSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStorageDelete = resolve;
        }),
    );
    activeEvent.id = 'event-a';
    proofState = { uid: 'u1', cellIndex: 5, storagePath: 'proofs/event-a/u1/P.jpg' };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 9, proofId: 'P', status: 'confirmed' };
    boardState = { cells: board };

    const deleting = deleteProof('P', 'proofs/event-a/u1/P.jpg');
    await vi.waitFor(() => expect(deleteStorageSpy).toHaveBeenCalledTimes(1));
    activeEvent.id = 'event-b';
    releaseStorageDelete();
    await deleting;

    const eventPaths = [...txGet.mock.calls, ...txSet.mock.calls, ...txDelete.mock.calls]
      .map(([ref]) => (ref as Ref).path)
      .filter((path) => path.startsWith('events/'));
    expect(eventPaths.length).toBeGreaterThan(0);
    expect(eventPaths.every((path) => path.startsWith('events/event-a/'))).toBe(true);
  });

  it('deletes the storage object + doc and unmarks the cell the proof backs (found via cellIndex)', async () => {
    proofState = { uid: 'u1', cellIndex: 5, storagePath: `proofs/${EVENT_ID}/u1/P.jpg` };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 9, proofId: 'P', status: 'confirmed' };
    boardState = { cells: board };
    playerState = { firstBingoAt: null };

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    // Storage first so a doc is never left referencing deleted media.
    expect(deleteStorageSpy).toHaveBeenCalledWith(`proofs/${EVENT_ID}/u1/P.jpg`);
    // The backing cell — resolved by the proof's cellIndex — is unmarked +
    // unlinked, and carries the SAME echoOptOut a manual unmark persists
    // (Phase 4b P1 on #447): open-time reconciliation must not restore the
    // Prompt from a standing sibling and undo this deletion.
    const written = setPayload('/boards/') as { cells: Cell[] };
    expect(written.cells[5]).toMatchObject({
      marked: false,
      markedAt: null,
      proofId: null,
      echoOptOut: true,
    });
    expect('echo' in written.cells[5]).toBe(false);
    expect(setPayload('/players/')).toMatchObject({ squaresMarked: 0 });
    // The proof doc itself is removed...
    const proofDelete = txDelete.mock.calls.find((c) => (c[0] as Ref).path.includes('/proofs/'));
    expect((proofDelete![0] as Ref).path).toContain('/proofs/P');
    // ...and the owner's per-Prompt Tally marker for the backing Prompt is removed
    // in the SAME transaction (ADR 0002: unmarking removes exactly that Player's
    // entry) — the same marker path setMark deletes on a bare unmark.
    const markerDelete = txDelete.mock.calls.find((c) => (c[0] as Ref).path.includes('/tally/'));
    expect((markerDelete![0] as Ref).path).toBe(`events/${EVENT_ID}/tally/i5/markers/u1`);
  });

  it('keeps the shared tally marker when a sibling Day still carries the echoed Prompt', async () => {
    proofState = { uid: 'u1', cellIndex: 5, dayIndex: 0, storagePath: null };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 9, proofId: 'P', status: 'confirmed' };
    boardState = { cells: board };
    const sibling = dealt();
    sibling[9] = { ...sibling[9], itemId: 'i5', marked: true, markedAt: 8, status: 'confirmed', echo: true };
    txGet.mockImplementation((ref: Ref): Promise<Snap> => {
      if (ref.path.includes('/days/1/boards/')) return Promise.resolve({ data: () => ({ cells: sibling }) });
      if (ref.path.includes('/boards/')) return Promise.resolve({ data: () => boardState });
      if (ref.path.includes('/players/')) return Promise.resolve({ data: () => playerState });
      if (ref.path.includes('/proofs/')) return Promise.resolve({ data: () => proofState });
      return Promise.resolve({ data: () => undefined });
    });

    await deleteProof('P', undefined, { daily: true, dayIndexes: [0, 1] });

    expect(setPayload('/days/0/boards/')).toBeDefined();
    expect(txDelete.mock.calls.find((c) => (c[0] as Ref).path.includes('/tally/'))).toBeUndefined();
  });

  it('after a bare-Mark drain dropped cells[i].proofId, it still deletes the proof but leaves the clobbered cell (accepted residual, ADR 0001)', async () => {
    // The queued bare-Mark drain wholesale-replaced cells and dropped the
    // proofId projection: cell 5 is marked but no longer references the proof.
    // deleteProof resolves the cell by cellIndex but gates the unmark on
    // proofId === id, so it does NOT fight the drained bare Mark — it removes the
    // proof doc and leaves the cell to the Mark that now owns it.
    proofState = { uid: 'u1', cellIndex: 5, storagePath: null };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 9, proofId: null, status: 'confirmed' };
    boardState = { cells: board };

    await deleteProof('P');

    expect(setPayload('/boards/')).toBeUndefined(); // the live Mark's cell is left intact
    expect(setPayload('/players/')).toBeUndefined();
    const deleted = txDelete.mock.calls[0][0] as Ref;
    expect(deleted.path).toContain('/proofs/P'); // the proof doc is still removed
    // It never unmarked the cell, so it must NOT touch the Tally marker either —
    // the drained bare Mark owns the cell and its own marker (accepted residual).
    expect(txDelete.mock.calls.find((c) => (c[0] as Ref).path.includes('/tally/'))).toBeUndefined();
  });
});

// #373 (follow-up to #369): deleteProof's Storage delete is the authoritative
// revocation, but the deleting device may itself have the proof's media sitting
// in the `proof-media` service-worker cache. deleteProof purges that local copy
// AFTER the transaction commits — never from inside the retryable callback,
// and never in a way a purge rejection could fail the delete.
describe('deleteProof — purges the deleting device’s own cached copy after commit (#373)', () => {
  it('calls the purge helper with the proof doc’s own mediaURL, after the transaction commits', async () => {
    const mediaURL = `https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2F${EVENT_ID}%2Fu1%2FP.jpg?alt=media&token=t`;
    proofState = { uid: 'u1', cellIndex: 5, storagePath: `proofs/${EVENT_ID}/u1/P.jpg`, mediaURL };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 9, proofId: 'P', status: 'confirmed' };
    boardState = { cells: board };

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(purgeCacheSpy).toHaveBeenCalledTimes(1);
    expect(purgeCacheSpy).toHaveBeenCalledWith(mediaURL);
    // "After commit": the purge fires once the transaction's own writes (the
    // proof doc's tx.delete) have already been issued, not before/during.
    expect(Math.min(...purgeCacheSpy.mock.invocationCallOrder)).toBeGreaterThan(
      Math.max(...txDelete.mock.invocationCallOrder),
    );
  });

  it('purges with the mediaURL even when the backing cell was already clobbered by a bare-Mark drain', async () => {
    // Mirrors the accepted-residual case above: the cell/board/player writes are
    // skipped, but the proof doc (and its media) is still gone from Storage, so
    // the local cache purge must still run.
    const mediaURL = `https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2F${EVENT_ID}%2Fu1%2FP.jpg?alt=media&token=t`;
    proofState = { uid: 'u1', cellIndex: 5, storagePath: null, mediaURL };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 9, proofId: null, status: 'confirmed' };
    boardState = { cells: board };

    await deleteProof('P');

    expect(purgeCacheSpy).toHaveBeenCalledWith(mediaURL);
  });

  it('is not called when the transaction fails — nothing was committed to purge for', async () => {
    proofState = { uid: 'u1', cellIndex: 5, storagePath: null, mediaURL: 'https://firebasestorage.googleapis.com/x' };
    runTx.mockRejectedValueOnce(new Error('aborted'));

    await expect(deleteProof('P')).rejects.toThrow('aborted');

    expect(purgeCacheSpy).not.toHaveBeenCalled();
  });

  it('purges with undefined (a no-op in the real helper) when the proof doc has no mediaURL — e.g. a text-only Proof', async () => {
    proofState = { uid: 'u1', cellIndex: 5, storagePath: null };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 9, proofId: 'P', status: 'confirmed' };
    boardState = { cells: board };

    await deleteProof('P');

    expect(purgeCacheSpy).toHaveBeenCalledWith(undefined);
  });
});
