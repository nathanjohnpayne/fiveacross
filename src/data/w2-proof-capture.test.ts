import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const {
  activeEvent,
  txGet,
  txSet,
  txDelete,
  runTx,
  uploadSpy,
  deleteStorageSpy,
  // The pre-transaction metadata read that binds the tombstone to the OBJECT it
  // targeted rather than to its name (#1153) — spied so the cases below can
  // assert the generation reaches the row, and that a failed read is absorbed.
  generationSpy,
  purgeCacheSpy,
  // `deleteDoc`, which this layer no longer calls at all (#1153, Codex round 3
  // P1: retiring a discharged media-revocation tombstone is SERVER-ONLY). Kept
  // as a spy precisely so the cases below can assert it never fires — a silent
  // un-mocked import would prove nothing.
  deleteDocSpy,
} = vi.hoisted(() => ({
  activeEvent: { id: 'med-2026' },
  txGet: vi.fn(),
  txSet: vi.fn(),
  txDelete: vi.fn(),
  runTx: vi.fn(),
  uploadSpy: vi.fn(),
  deleteStorageSpy: vi.fn(),
  generationSpy: vi.fn(),
  purgeCacheSpy: vi.fn(),
  deleteDocSpy: vi.fn(),
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
vi.mock('./storage', () => ({
  uploadProofMedia: uploadSpy,
  deleteStoragePath: deleteStorageSpy,
  proofMediaGeneration: generationSpy,
}));
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
  deleteDoc: (ref: Ref) => deleteDocSpy(ref),
  increment: (n: number) => ({ __inc: n }),
  updateDoc: vi.fn(),
  };
});

import {
  attachProof,
  deleteProof,
  proofMediaOwnerUid,
  ProofBacksMarkWhileClosingError,
} from './proofs';

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
  deleteStorageSpy.mockResolvedValue(undefined);
  generationSpy.mockResolvedValue('1700000000000001');
  deleteDocSpy.mockResolvedValue(undefined);
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

// #1049: in daily-cards mode each Day Card is its OWN Board, so the first-bingo
// stamp a proofed Mark preserves is that Day's `dayStats` bucket. Reading the
// Player's Event-level ROOT here copied an earlier Day's instant into the Day
// being written — a proofed Day-2 win inheriting a Day-1 First to BINGO — which
// awards the wrong daily honour and, once summed back up, the wrong headline.
// The bare-Mark path (`setMark` ← Board) already derives per-Day; these pin the
// proof path onto the same rule, and pin legacy single-board reads unchanged.
describe('attachProof — the preserved first-bingo stamp is the DAY’s, not the Event root (#1049)', () => {
  // A Player who bingoed on Day 1 at t=100 and has done nothing on Day 2 yet.
  const day1Winner = () => ({
    firstBingoAt: 100,
    dayStats: { 1: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 } },
  });

  it('stamps a cross-Day proofed win with NOW, never the root carried over from another Day', async () => {
    playerState = day1Winner();
    boardState = { cells: withMarked([0, 1, 2, 3]) }; // Day 2's card, one Square shy

    await attachProof({
      ...baseArgs,
      cellIndex: 4,
      itemId: 'i4',
      claimMode: 'proof_required',
      daily: true,
      dayIndex: 2,
      proof: { type: 'text', text: 'day two, line one' },
    });

    const write = setPayload('/players/') as {
      dayStats: Record<number, { firstBingoAt: number | null }>;
      firstBingoAt: number | null;
      bingoCount: number;
    };
    // Day 2 records the instant it actually happened (Date.now() is pinned to 1000)…
    expect(write.dayStats[2].firstBingoAt).toBe(1000);
    expect(write.dayStats[2].firstBingoAt).not.toBe(100);
    // …and only Day 2's bucket rides the write, so Day 1's stamp is untouched.
    expect(Object.keys(write.dayStats)).toEqual(['2']);
    // The root is still the re-derived Event-wide earliest across both Days.
    expect(write.firstBingoAt).toBe(100);
    expect(write.bingoCount).toBe(2);
    // The Day-scoped board is the one written (never the legacy flat board).
    expect(setPayload(`events/${EVENT_ID}/days/2/boards/u1`)).toBeDefined();
  });

  it('does not re-stamp a Day bingo that already stands when proof lands on an already-marked Square', async () => {
    playerState = {
      firstBingoAt: 100,
      dayStats: {
        1: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 },
        2: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 300 },
      },
    };
    boardState = { cells: withMarked([0, 1, 2, 3, 4]) }; // Day 2's line already stands

    await attachProof({
      ...baseArgs,
      cellIndex: 0,
      itemId: 'i0',
      claimMode: 'proof_required',
      daily: true,
      dayIndex: 2,
      proof: { type: 'text', text: 'adding proof after the fact' },
    });

    const write = setPayload('/players/') as {
      dayStats: Record<number, { firstBingoAt: number | null }>;
    };
    // Day 2 keeps its OWN earlier instant — not `now`, and not Day 1's 100.
    expect(write.dayStats[2].firstBingoAt).toBe(300);
  });

  it('keeps the LEGACY single-board read on the root, unchanged', async () => {
    // No `daily`: the pre-1.5 flat write, whose one Board's stamp IS the root.
    playerState = { firstBingoAt: 100 };
    boardState = { cells: withMarked([0, 1, 2, 3]) };

    await attachProof({
      ...baseArgs,
      cellIndex: 4,
      itemId: 'i4',
      claimMode: 'proof_required',
      proof: { type: 'text', text: 'legacy line' },
    });

    expect(setPayload('/players/')).toEqual({
      squaresMarked: 5,
      bingoCount: 1,
      firstBingoAt: 100,
      blackout: false,
    });
  });

  it('post-freeze ceremonial bucket-only write still carries the Day’s own stamp (#265 preserved)', async () => {
    playerState = {
      firstBingoAt: 100,
      dayStats: { 1: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 } },
    };
    boardState = { cells: withMarked([0, 1, 2, 3]) };

    await attachProof({
      ...baseArgs,
      cellIndex: 4,
      itemId: 'i4',
      claimMode: 'proof_required',
      daily: true,
      dayIndex: 9,
      ceremonialDayIndexes: [9],
      statsFrozen: true,
      proof: { type: 'text', text: 'farewell line' },
    });

    const write = setPayload('/players/') as {
      dayStats: Record<number, { firstBingoAt: number | null }>;
    };
    // Still bucket-only (the frozen roots never move)…
    expect(Object.keys(write)).toEqual(['dayStats']);
    // …and the farewell honour records its own instant, not the frozen root's.
    expect(write.dayStats[9].firstBingoAt).toBe(1000);
  });

  // Codex P2, round 2: the caller's sheet prop must be a fallback for an
  // UNREADABLE Player row only. A `??` chain over the live value could not tell
  // "this Day has no stamp" from "no row to read", so it revived a stamp the
  // transaction had just been told was gone.
  it('does NOT revive the stale sheet prop when the live Day bucket explicitly has no stamp', async () => {
    // The sheet opened while Day 9 held a line at t=300; another tab has since
    // unmarked that Day's last Square, so the live bucket is an explicit null.
    // Day 9 is ceremonial, so the Event root legitimately stays null too —
    // exactly the shape where the old chain had a stale value and nothing else
    // to contradict it.
    playerState = {
      firstBingoAt: null,
      dayStats: { 9: { bingoCount: 0, squaresMarked: 4, firstBingoAt: null } },
    };
    boardState = { cells: withMarked([0, 1, 2, 3]) };

    await attachProof({
      ...baseArgs,
      cellIndex: 4,
      itemId: 'i4',
      claimMode: 'proof_required',
      daily: true,
      dayIndex: 9,
      currentFirstBingoAt: 300, // the stale prop the sheet still carries
      proof: { type: 'text', text: 'relit the line' },
    });

    const write = setPayload('/players/') as {
      dayStats: Record<number, { firstBingoAt: number | null }>;
    };
    // The new win is stamped NOW, not resurrected at the sheet's old instant.
    expect(write.dayStats[9].firstBingoAt).toBe(1000);
    expect(write.dayStats[9].firstBingoAt).not.toBe(300);
  });

  it('falls back to the caller prop only when the Player row itself is unreadable', async () => {
    // No Player document at all in the transaction read — the one case the prop
    // is the best knowledge available, so it must still be honoured.
    playerState = undefined;
    boardState = { cells: withMarked([0, 1, 2, 3]) };

    await attachProof({
      ...baseArgs,
      cellIndex: 4,
      itemId: 'i4',
      claimMode: 'proof_required',
      daily: true,
      dayIndex: 2,
      currentFirstBingoAt: 300,
      proof: { type: 'text', text: 'no row to read' },
    });

    const write = setPayload('/players/') as {
      dayStats: Record<number, { firstBingoAt: number | null }>;
    };
    expect(write.dayStats[2].firstBingoAt).toBe(300);
  });
});

describe('deleteProof — the surviving first-bingo stamp is the DAY’s, not the Event root (#1049)', () => {
  // Day 2's card with two standing lines (row 0 and row 1) and a proof backing
  // cell 5 — deleting it breaks row 1 while row 0 still stands.
  function twoLineDay2Board(): Cell[] {
    const board = withMarked([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    board[5] = { ...board[5], proofId: 'P' };
    return board;
  }

  beforeEach(() => {
    proofState = { uid: 'u1', cellIndex: 5, dayIndex: 2, storagePath: null };
    playerState = {
      firstBingoAt: 100,
      dayStats: {
        1: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 },
        2: { bingoCount: 2, squaresMarked: 11, firstBingoAt: 300 },
      },
    };
  });

  it("preserves THAT Day's stamp when a line still stands after the delete", async () => {
    boardState = { cells: twoLineDay2Board() };

    await deleteProof('P', undefined, { daily: true, dayIndexes: [1, 2] });

    const write = setPayload('/players/') as {
      dayStats: Record<number, { bingoCount: number; firstBingoAt: number | null }>;
      firstBingoAt: number | null;
    };
    expect(write.dayStats[2].bingoCount).toBe(1); // row 0 survives
    // Day 2 keeps its own 300 — reading the root would write Day 1's 100 here.
    expect(write.dayStats[2].firstBingoAt).toBe(300);
    expect(write.firstBingoAt).toBe(100); // root is still the Event-wide earliest
  });

  it('clears that Day’s stamp when the delete removes the LAST standing line', async () => {
    const board = withMarked([0, 1, 2, 3, 4]); // Day 2's only line
    board[4] = { ...board[4], proofId: 'P' };
    boardState = { cells: board };
    proofState = { uid: 'u1', cellIndex: 4, dayIndex: 2, storagePath: null };

    await deleteProof('P', undefined, { daily: true, dayIndexes: [1, 2] });

    const write = setPayload('/players/') as {
      dayStats: Record<number, { bingoCount: number; firstBingoAt: number | null }>;
      firstBingoAt: number | null;
    };
    expect(write.dayStats[2].bingoCount).toBe(0);
    expect(write.dayStats[2].firstBingoAt).toBeNull();
    // Day 1's own win is untouched, so the Event-wide root still reads 100.
    expect(write.firstBingoAt).toBe(100);
  });

  it('keeps the LEGACY single-board delete reading the root, unchanged', async () => {
    playerState = { firstBingoAt: 300 };
    boardState = { cells: twoLineDay2Board() };

    await deleteProof('P', undefined);

    expect(setPayload('/players/')).toEqual({
      squaresMarked: 9,
      bingoCount: 1,
      firstBingoAt: 300,
      blackout: false,
    });
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

describe('attachProof — rolls the upload back when the transaction is refused (#134, #1157)', () => {
  // Codex P1, PR #1157. The media has to be uploaded BEFORE the transaction —
  // `firestore.rules` pins the Proof document's `storagePath`/`mediaURL` to the
  // exact object — so every rejection leaves a blob no document points at. The
  // freeze made one of those rejections routine: an Admin committing
  // `archiving: true` between the upload resolving and the transaction reading
  // denies the write, and the archive keeps the blob forever. `storage.rules`
  // authorises this cleanup in every state through its ORPHAN carve-out.
  const photoProof = () => ({
    ...baseArgs,
    claimMode: 'proof_required' as const,
    proof: { type: 'photo' as const, blob: new Blob(['x'], { type: 'image/jpeg' }) },
  });

  it('deletes the object it just uploaded when the transaction is denied', async () => {
    runTx.mockRejectedValueOnce(new Error('permission-denied'));

    await expect(attachProof(photoProof())).rejects.toThrow('permission-denied');

    expect(deleteStorageSpy).toHaveBeenCalledWith(`proofs/${EVENT_ID}/u1/UPLOADED.jpg`);
  });

  it('deletes NOTHING when the transaction commits', async () => {
    await attachProof(photoProof());

    expect(deleteStorageSpy).not.toHaveBeenCalled();
  });

  it('deletes nothing for a TEXT proof, which uploaded no object to roll back', async () => {
    runTx.mockRejectedValueOnce(new Error('permission-denied'));

    await expect(
      attachProof({ ...baseArgs, claimMode: 'proof_required', proof: { type: 'text', text: 'hi' } }),
    ).rejects.toThrow('permission-denied');

    expect(deleteStorageSpy).not.toHaveBeenCalled();
  });

  it('does NOT let a failing cleanup mask the original error', async () => {
    // The cleanup is a courtesy on a path that has already failed. Replacing
    // "your proof did not post" with a Storage error would tell the Player
    // about the wrong failure, and about one they can do nothing with.
    runTx.mockRejectedValueOnce(new Error('permission-denied'));
    deleteStorageSpy.mockRejectedValueOnce(new Error('storage/unauthorized'));

    await expect(attachProof(photoProof())).rejects.toThrow('permission-denied');

    expect(deleteStorageSpy).toHaveBeenCalledTimes(1);
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
    // The Event DOCUMENT itself is one of those refs since #134 — the freeze
    // check the transaction reads — so it is matched exactly rather than under
    // the subtree prefix. Same claim either way: every ref stays under Event A.
    expect(
      eventPaths.every((path) => path === 'events/event-a' || path.startsWith('events/event-a/')),
    ).toBe(true);
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
// #134 (specs/post-sailing-archive.md § "Moderation is not a gameplay write"):
// the admin takedown outlives the Event, and the Board unmark it used to carry
// does not. `eventOpenForPlay` denies the Board, Player and Tally writes on both
// halves of the freeze, and they shared ONE transaction with the delete — so the
// advertised moderation path failed outright on exactly the Event whose play can
// never resume, with the media already gone.
describe('deleteProof — the moderation delete survives the freeze (#134)', () => {
  // A Proof whose backing cell is genuinely marked BY IT, so the cleanup is what
  // the open-Event control below actually performs.
  function withBackingCell(): void {
    proofState = { uid: 'u1', cellIndex: 5, storagePath: `proofs/${EVENT_ID}/u1/P.jpg` };
    const board = dealt();
    board[5] = { ...board[5], marked: true, markedAt: 9, proofId: 'P', status: 'confirmed' };
    boardState = { cells: board };
    playerState = { firstBingoAt: null };
  }
  function eventReads(event: Record<string, unknown> | undefined): void {
    txGet.mockImplementation((ref: Ref): Promise<Snap> => {
      if (ref.path === `events/${EVENT_ID}`) return Promise.resolve({ data: () => event });
      if (ref.path.includes('/boards/')) return Promise.resolve({ data: () => boardState });
      if (ref.path.includes('/players/')) return Promise.resolve({ data: () => playerState });
      if (ref.path.includes('/proofs/')) return Promise.resolve({ data: () => proofState });
      return Promise.resolve({ data: () => undefined });
    });
  }

  it('completes on an ARCHIVED Event, skipping the gameplay cleanup the freeze denies', async () => {
    withBackingCell();
    eventReads({ status: 'archived' });

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    // The takedown itself: the document leaves the Feed and the media leaves
    // Storage.
    expect(txDelete.mock.calls.find((c) => (c[0] as Ref).path.includes('/proofs/P'))).toBeDefined();
    expect(deleteStorageSpy).toHaveBeenCalledWith(`proofs/${EVENT_ID}/u1/P.jpg`);
    // …and none of the three writes the freeze denies is attempted, which is
    // what used to take the delete down with it.
    expect(setPayload('/boards/')).toBeUndefined();
    expect(setPayload('/players/')).toBeUndefined();
    expect(txDelete.mock.calls.find((c) => (c[0] as Ref).path.includes('/tally/'))).toBeUndefined();
  });

  it('REFUSES a Proof that backs a marked cell while the Event is only CLOSING', async () => {
    // Phase 4b P2, PR #1157 run 4. Closing is REVERSIBLE, so the archived
    // skip is not safe here: skipping the unmark, the stat rewrite and the
    // Tally cleanup leaves a marked square backed by a Proof that no longer
    // exists the moment an Admin reopens play, and nothing repairs it later
    // because the delete already reported success. The transaction refuses
    // instead, and the message names the way through.
    withBackingCell();
    eventReads({ status: 'active', archiving: true });

    await expect(deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`)).rejects.toBeInstanceOf(
      ProofBacksMarkWhileClosingError,
    );
    await expect(deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`)).rejects.toThrow(/Reopen play/);

    // NOTHING was written, and the media is untouched — the Proof, its Board
    // cell and its blob are all exactly as they were.
    expect(txDelete).not.toHaveBeenCalled();
    expect(setPayload('/boards/')).toBeUndefined();
    expect(setPayload('/players/')).toBeUndefined();
    expect(deleteStorageSpy).not.toHaveBeenCalled();
  });

  it('still deletes on a CLOSING Event when the Proof backs NOTHING', async () => {
    // Nothing to keep consistent: the cell was already unmarked (or the Proof
    // never held one), so there is no gameplay cleanup the refusal exists to
    // protect and the takedown is the ordinary one.
    proofState = { uid: 'u1', cellIndex: 5, storagePath: `proofs/${EVENT_ID}/u1/P.jpg` };
    boardState = { cells: dealt() };
    playerState = { firstBingoAt: null };
    eventReads({ status: 'active', archiving: true });

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(txDelete.mock.calls.find((c) => (c[0] as Ref).path.includes('/proofs/P'))).toBeDefined();
    expect(deleteStorageSpy).toHaveBeenCalledWith(`proofs/${EVENT_ID}/u1/P.jpg`);
    expect(setPayload('/boards/')).toBeUndefined();
    expect(setPayload('/players/')).toBeUndefined();
  });

  it('still unmarks the backing cell on an OPEN Event — the control', async () => {
    withBackingCell();
    eventReads({ status: 'active' });

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    const written = setPayload('/boards/') as { cells: Cell[] };
    expect(written.cells[5]).toMatchObject({ marked: false, proofId: null });
    expect(setPayload('/players/')).toMatchObject({ squaresMarked: 0 });
    expect(txDelete.mock.calls.find((c) => (c[0] as Ref).path.includes('/tally/'))).toBeDefined();
  });

  it('reads the Event INSIDE the transaction, so a quiesce landing in the window aborts the attempt', async () => {
    // A transaction serializes against the documents it READS, and the quiesce
    // writes this one — so the freeze check has to be part of the read set, not
    // a decision taken before the transaction opens.
    withBackingCell();
    eventReads({ status: 'active' });

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(txGet.mock.calls.some(([ref]) => (ref as Ref).path === `events/${EVENT_ID}`)).toBe(true);
  });

  it('COMMITS BEFORE it revokes the media, on the OWNER’s live-Event path', async () => {
    // Codex P1, PR #1157. Storage first is what main shipped, and the freeze is
    // what makes it wrong: an owner's delete that starts while the Event is
    // open can revoke the media and then lose its transaction to an Admin's
    // quiesce, leaving a surviving Proof pointing at media that is gone — on
    // the one Event where nothing can be re-posted, and with no way back,
    // because the owner's document delete is now denied and the object it named
    // is already deleted. Committing first makes a lost race a no-op.
    withBackingCell();
    eventReads({ status: 'active' });

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(deleteStorageSpy).toHaveBeenCalledWith(`proofs/${EVENT_ID}/u1/P.jpg`);
    expect(Math.max(...runTx.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...deleteStorageSpy.mock.invocationCallOrder),
    );
  });

  it('commits before revoking on the ADMIN takedown path too', async () => {
    // The archived-Event skip lives INSIDE the transaction, so the ordering and
    // the freeze behaviour are independent — this pins both at once.
    withBackingCell();
    eventReads({ status: 'archived' });

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(Math.max(...runTx.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...deleteStorageSpy.mock.invocationCallOrder),
    );
  });

  it('leaves the Proof document standing when the TRANSACTION is the half that fails', async () => {
    // The point of the inversion: a delete that loses the race to the quiesce
    // changes nothing at all, rather than revoking the media first and then
    // being denied the document.
    withBackingCell();
    eventReads({ status: 'active' });
    runTx.mockRejectedValueOnce(new Error('permission-denied'));

    await expect(deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`)).rejects.toThrow(
      'permission-denied',
    );

    expect(deleteStorageSpy).not.toHaveBeenCalled();
  });
});

describe('deleteProof — the media revocation outlives the commit that removes its only reference (#134, #1153)', () => {
  // Round 1 of the #1157 review rejected commit-first because the commit takes
  // the Proof, its `storagePath` and the surface that offered the delete all at
  // once, so a post-commit Storage failure had nothing left to retry from.
  // Child 1 answered with a device-local `localStorage` queue; #1153 replaces
  // it with the DURABLE record — a tombstone at
  // `events/{eventId}/proofStorageDeletes/{proofId}` written in the SAME
  // transaction as the delete and finished by `revokeDeletedProofMedia` when
  // this client never does.
  const TOMBSTONE = `events/${EVENT_ID}/proofStorageDeletes/P`;
  const tombstoneSet = () =>
    txSet.mock.calls.findIndex((c) => (c[0] as Ref).path === TOMBSTONE);

  beforeEach(() => {
    proofState = { uid: 'u1', cellIndex: 5, storagePath: `proofs/${EVENT_ID}/u1/P.jpg` };
    boardState = { cells: dealt() };
  });

  it('writes the tombstone through the SAME transaction as the Proof delete, and AHEAD of it', async () => {
    // Same transaction, so there is no instant at which the Proof is gone and
    // the record of its media is not: either both land or neither does.
    let setsInsideTransaction: string[] = [];
    runTx.mockImplementationOnce(async (_db: unknown, fn: (tx: unknown) => unknown) => {
      const result = await fn({ get: txGet, set: txSet, delete: txDelete });
      setsInsideTransaction = txSet.mock.calls.map((c) => (c[0] as Ref).path);
      return result;
    });

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(setsInsideTransaction).toContain(TOMBSTONE);
    expect(setPayload('/proofStorageDeletes/')).toEqual({
      storagePath: `proofs/${EVENT_ID}/u1/P.jpg`,
      uid: 'u1',
      requestedAt: 1000,
      // The object's own generation, read before the transaction opened, so the
      // row targets THAT blob and not whatever later answers to its name.
      generation: '1700000000000001',
    });
    // Ahead of the delete, so the durable record exists before the only
    // reference to the object goes.
    const proofDelete = txDelete.mock.calls.findIndex((c) =>
      (c[0] as Ref).path.includes('/proofs/P'),
    );
    expect(txSet.mock.invocationCallOrder[tombstoneSet()]).toBeLessThan(
      txDelete.mock.invocationCallOrder[proofDelete],
    );
  });

  it('writes NO retirement at all — the sweeper is the only writer that may clear the row (#1153)', async () => {
    // Codex round 3 P1. This client used to retire the tombstone it had just
    // discharged, which was only ever an OPTIMISATION — and one the media's
    // OWNER could turn against an ADMIN takedown. The row's path is entirely
    // predictable, so an owner who could delete it could cancel the durable half
    // of a takedown aimed at their own reported photo the moment the Admin's
    // inline Storage delete failed or was interrupted; the sweeper would then
    // find no tombstone, abandon by design, and leave the download URL live.
    // `firestore.rules` therefore denies EVERY client delete on the row, and the
    // write is removed here rather than left in place to be denied.
    //
    // Nothing is lost: `deleteStoragePath` leaves the object gone, which is the
    // 404 `revokeDeletedProofMedia` counts as success before retiring the row
    // itself. The whole takedown still resolves, and the cache is still purged.
    proofState = {
      uid: 'u1',
      cellIndex: 5,
      storagePath: `proofs/${EVENT_ID}/u1/P.jpg`,
      mediaURL: 'https://firebasestorage.googleapis.com/x',
    };

    await expect(deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`)).resolves.toBeUndefined();

    // The row was written and the object revoked …
    expect(tombstoneSet()).toBeGreaterThanOrEqual(0);
    expect(deleteStorageSpy).toHaveBeenCalledWith(`proofs/${EVENT_ID}/u1/P.jpg`);
    // … and no `deleteDoc` was issued against the tombstone, or anything else.
    expect(deleteDocSpy).not.toHaveBeenCalled();
    expect(purgeCacheSpy).toHaveBeenCalledWith('https://firebasestorage.googleapis.com/x');
  });

  it('LEAVES the tombstone standing when the Storage delete rejects, and still surfaces the error', async () => {
    // The whole point: the sweeper still owes the revocation, and the caller is
    // still told the media was not revoked rather than shown a clean takedown.
    deleteStorageSpy.mockRejectedValueOnce(new Error('storage/retry-limit-exceeded'));

    await expect(deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`)).rejects.toThrow(
      'storage/retry-limit-exceeded',
    );

    expect(tombstoneSet()).toBeGreaterThanOrEqual(0);
    expect(deleteDocSpy).not.toHaveBeenCalled();
  });

  it('still purges this device’s cache when the revocation rejects (#1148)', async () => {
    // The commit is what the purge follows, not the blob delete: the Proof is
    // gone from the Feed either way, so this device must stop serving the photo
    // out of its own CacheFirst copy whichever half failed (#373, #1142 item
    // 12). The purge sits in a `finally`, and the Storage error still leaves.
    proofState = {
      uid: 'u1',
      cellIndex: 5,
      storagePath: `proofs/${EVENT_ID}/u1/P.jpg`,
      mediaURL: 'https://firebasestorage.googleapis.com/x',
    };
    deleteStorageSpy.mockRejectedValueOnce(new Error('storage/retry-limit-exceeded'));

    await expect(deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`)).rejects.toThrow();

    expect(purgeCacheSpy).toHaveBeenCalledWith('https://firebasestorage.googleapis.com/x');
  });

  it('writes one on an ARCHIVED Event too — the takedown the freeze leaves open still owes its media', async () => {
    txGet.mockImplementation((ref: Ref): Promise<Snap> => {
      if (ref.path === `events/${EVENT_ID}`)
        return Promise.resolve({ data: () => ({ status: 'archived' }) });
      if (ref.path.includes('/proofs/')) return Promise.resolve({ data: () => proofState });
      return Promise.resolve({ data: () => undefined });
    });

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(tombstoneSet()).toBeGreaterThanOrEqual(0);
  });

  it('keeps a DOTTED Proof id whole, stripping only the final extension', async () => {
    // `p.q` with media `p.q.jpg`: splitting on the first dot would derive the
    // owner from `p` and refuse a perfectly legitimate row (the same trap Phase
    // 4b P1 on PR #1157 fixed in storage.rules).
    proofState = { uid: 'u1', cellIndex: 5, storagePath: `proofs/${EVENT_ID}/u1/p.q.jpg` };

    await deleteProof('p.q', `proofs/${EVENT_ID}/u1/p.q.jpg`);

    const call = txSet.mock.calls.find(
      (c) => (c[0] as Ref).path === `events/${EVENT_ID}/proofStorageDeletes/p.q`,
    );
    expect(call?.[1]).toMatchObject({ uid: 'u1', storagePath: `proofs/${EVENT_ID}/u1/p.q.jpg` });
  });

  it('takes the object from the PROOF DOCUMENT, not the caller’s argument (#1153)', async () => {
    // Both call sites read `storagePath` off a Feed/queue snapshot that can be
    // stale, and an authorized caller could construct the batch by hand. The
    // Proof document is the only thing that ever recorded which object was its
    // own, and the commit destroys it — so a takedown that trusted the argument
    // could revoke a name this Proof never used while its real media stayed
    // reachable, with nothing left to notice. `firestore.rules` binds the row to
    // the stored path for the same reason, so a disagreement would be DENIED and
    // the denial would fail the whole takedown.
    //
    // `.webm` under the same owner and the same Proof id is the shape that
    // passes every OTHER check the rules make.
    const stored = `proofs/${EVENT_ID}/u1/P.jpg`;
    const stale = `proofs/${EVENT_ID}/u1/P.webm`;
    proofState = { uid: 'u1', cellIndex: 5, storagePath: stored };

    await deleteProof('P', stale);

    expect(setPayload('/proofStorageDeletes/')).toEqual({
      storagePath: stored,
      uid: 'u1',
      requestedAt: 1000,
      // NO generation. The metadata read aims at the argument, because that is
      // the only path in hand before the transaction opens — so when the two
      // disagree the value it returned describes some other blob, and binding
      // the sweep to it would answer 412 against the RIGHT object and retire the
      // row with the media still in place. The key is optional exactly so this
      // can be dropped rather than written wrong.
    });
    expect(generationSpy).toHaveBeenCalledWith(stale);
    // The fast path follows the row, so the two can never target different blobs.
    expect(deleteStorageSpy).toHaveBeenCalledWith(stored);
    expect(deleteStorageSpy).not.toHaveBeenCalledWith(stale);
  });

  it('revokes NOTHING for a TEXT Proof, whatever object the caller names', async () => {
    // A Proof that stored no object owns none, and an argument cannot conjure
    // one: the row would be refused by the rules and the Storage delete would be
    // aimed at a blob this Proof never referenced.
    proofState = { uid: 'u1', cellIndex: 5, storagePath: null };

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(tombstoneSet()).toBe(-1);
    expect(deleteStorageSpy).not.toHaveBeenCalled();
  });

  it('writes NO tombstone for a text Proof, an already-deleted Proof, or an unparseable path', async () => {
    // Each still behaves exactly as it did before the tombstone existed. A text
    // Proof has no object; an already-deleted Proof has nothing to record (and
    // its `set` would be an update the rules deny — the first attempt's row is
    // still standing anyway); an unparseable path would be denied at the
    // boundary, and a denial inside this transaction fails the whole takedown.
    const rewire = () => {
      vi.clearAllMocks();
      runTx.mockImplementation((_db: unknown, fn: (tx: unknown) => unknown) =>
        fn({ get: txGet, set: txSet, delete: txDelete }),
      );
      deleteStorageSpy.mockResolvedValue(undefined);
      generationSpy.mockResolvedValue('1700000000000001');
      txGet.mockImplementation((ref: Ref): Promise<Snap> => {
        if (ref.path.includes('/boards/')) return Promise.resolve({ data: () => boardState });
        if (ref.path.includes('/players/')) return Promise.resolve({ data: () => playerState });
        if (ref.path.includes('/proofs/')) return Promise.resolve({ data: () => proofState });
        return Promise.resolve({ data: () => undefined });
      });
    };

    proofState = { uid: 'u1', cellIndex: 5, storagePath: null };
    await deleteProof('P');
    expect(tombstoneSet()).toBe(-1);

    rewire();
    proofState = undefined; // the Proof document is already gone
    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);
    expect(tombstoneSet()).toBe(-1);
    // …and the media is still revoked inline, exactly as before.
    expect(deleteStorageSpy).toHaveBeenCalledWith(`proofs/${EVENT_ID}/u1/P.jpg`);

    rewire();
    proofState = { uid: 'u1', cellIndex: 5, storagePath: 'legacy/not-a-proof-path.png' };
    await deleteProof('P', 'legacy/not-a-proof-path.png');
    expect(tombstoneSet()).toBe(-1);
    expect(deleteStorageSpy).toHaveBeenCalledWith('legacy/not-a-proof-path.png');
  });

  it('writes NO tombstone when the path’s owner disagrees with the Proof’s own uid', async () => {
    // The rule binds the row to the live Proof document, so a disagreement
    // would be DENIED — and a denial inside this transaction takes the whole
    // takedown down with it. Only a hand-written document can produce one.
    proofState = { uid: 'u2', cellIndex: 5, storagePath: `proofs/${EVENT_ID}/u1/P.jpg` };

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(tombstoneSet()).toBe(-1);
    expect(deleteStorageSpy).toHaveBeenCalledWith(`proofs/${EVENT_ID}/u1/P.jpg`);
  });

  it('OMITS the generation rather than failing when the object’s metadata cannot be read', async () => {
    // Best effort by construction. The read is one extra Storage round trip on a
    // takedown path whose whole design goal is that it cannot be made to fail,
    // so a metadata failure must not become a missing — or denied — tombstone.
    // The rules arm accepts the key as optional for exactly this reason, and a
    // row without one is revoked by path, still guarded by the sweeper's own
    // Proof-absence check.
    generationSpy.mockResolvedValueOnce(null);

    await deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`);

    expect(setPayload('/proofStorageDeletes/')).toEqual({
      storagePath: `proofs/${EVENT_ID}/u1/P.jpg`,
      uid: 'u1',
      requestedAt: 1000,
    });
  });

  it('spends no metadata round trip when no tombstone can be written', async () => {
    // A text Proof has no object, and a path this layer cannot parse writes no
    // row — asking Storage about either buys nothing on a path that already
    // behaves exactly as it did before the tombstone existed.
    proofState = { uid: 'u1', cellIndex: 5, storagePath: null };
    await deleteProof('P');
    await deleteProof('P', 'legacy/not-a-proof-path.png');

    expect(generationSpy).not.toHaveBeenCalled();
  });

  it('leaves the row standing and RE-POSTS under a new Proof id, which is what makes the recreate refusal free (#1153)', async () => {
    // The reuse hazard the rules now refuse from the Proof's own side: while a
    // revocation is outstanding, that Proof id cannot be created again. Without
    // it an owner could delete Proof P with its tombstone, re-create P — same
    // id, same object path — and reassemble the live-Proof/standing-row pair
    // `existsAfter` exists to forbid, after which the next takedown's `set` is a
    // denied UPDATE and the delayed sweeper strips media a live Feed entry
    // points at.
    //
    // The clause costs the app nothing, and this is why: a re-post is a fresh
    // `doc(collection)` auto-id, so it never asks for an id a tombstone is
    // holding, and its media lands under a different object name besides.
    deleteStorageSpy.mockRejectedValueOnce(new Error('storage/retry-limit-exceeded'));
    await expect(deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`)).rejects.toThrow();
    expect(tombstoneSet()).toBeGreaterThanOrEqual(0);
    // Still owed: the row was never retired, so the id stays held until the
    // sweeper discharges it.
    expect(deleteDocSpy).not.toHaveBeenCalled();

    txSet.mockClear();
    await attachProof({
      ...baseArgs,
      claimMode: 'proof_required',
      proof: { type: 'photo', blob: new Blob(['x'], { type: 'image/jpeg' }) },
    });

    const rePostId = uploadSpy.mock.calls[0][1] as string;
    expect(rePostId).not.toBe('P');
    const proofWrite = txSet.mock.calls.find((c) =>
      (c[0] as Ref).path.startsWith(`events/${EVENT_ID}/proofs/`),
    );
    expect((proofWrite?.[0] as Ref).path).toBe(`events/${EVENT_ID}/proofs/${rePostId}`);
  });

  it('touches no localStorage at all — the device-local queue is RETIRED (#1153)', async () => {
    // The queue child 1 shipped carried two races: two tabs finishing deletes
    // at once could clobber each other's read-modify-write, and a drain in
    // flight could clear an intent a still-running transaction had just
    // re-asserted (#1159). The tombstone supersedes it, so the shared mutable
    // state both races needed is gone rather than serialized.
    const store = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', store);
    try {
      deleteStorageSpy.mockRejectedValueOnce(new Error('storage/retry-limit-exceeded'));
      await expect(deleteProof('P', `proofs/${EVENT_ID}/u1/P.jpg`)).rejects.toThrow();
      expect(store.getItem).not.toHaveBeenCalled();
      expect(store.setItem).not.toHaveBeenCalled();
      expect(store.removeItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('proofMediaOwnerUid — the uid the rules pin the object path against', () => {
  it('accepts every shape `uploadProofMedia` writes, and a dotted Proof id', () => {
    expect(proofMediaOwnerUid('proofs/e/u1/P.jpg', 'e', 'P')).toBe('u1');
    expect(proofMediaOwnerUid('proofs/e/u1/P.webm', 'e', 'P')).toBe('u1');
    expect(proofMediaOwnerUid('proofs/e/u1/P.m4a', 'e', 'P')).toBe('u1');
    expect(proofMediaOwnerUid('proofs/e/u1/p.q.jpg', 'e', 'p.q')).toBe('u1');
  });

  it('refuses another Event, another Proof, another prefix, an unknown extension and a malformed path', () => {
    expect(proofMediaOwnerUid('proofs/other/u1/P.jpg', 'e', 'P')).toBeNull();
    expect(proofMediaOwnerUid('proofs/e/u1/OTHER.jpg', 'e', 'P')).toBeNull();
    expect(proofMediaOwnerUid('avatars/e/u1/P.jpg', 'e', 'P')).toBeNull();
    expect(proofMediaOwnerUid('proofs/e/u1/P.png', 'e', 'P')).toBeNull();
    expect(proofMediaOwnerUid('proofs/e//P.jpg', 'e', 'P')).toBeNull();
    expect(proofMediaOwnerUid('proofs/e/u1/P', 'e', 'P')).toBeNull();
    expect(proofMediaOwnerUid('proofs/e/u1/sub/P.jpg', 'e', 'P')).toBeNull();
  });
});

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
