import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Cell, ProofDoc } from '../types';
import { safeMediaUrl } from './safeMediaUrl';

// sec-xss-proofsheet — CodeQL js/xss-through-dom alert #1 (severity high).
//
// The flagged sink is ProofSheet's photo preview <img src={photoUrl}>, fed from
// the file input's `.files` via URL.createObjectURL. React auto-escapes JSX TEXT
// but does NOT sanitize a `src`/`href` attribute, so the fix is a scheme allowlist
// (`safeMediaUrl`) at every media sink in ProofSheet and ProofFeed. These tests
// pin three things: (1) a text-callout HTML payload renders as literal, inert text
// (React escaping, in both the sheet's textarea and the Feed's quote); (2) real
// photo/audio capture still renders (blob:/https: pass the guard); (3) a hostile
// `javascript:` media URL is dropped before it can become a src. `safeMediaUrl` is
// unit-tested directly.

const XSS = '<img src=x onerror=alert(1)>';

const H = vi.hoisted(() => ({
  attachProof: vi.fn(),
  reportProof: vi.fn(),
  deleteProof: vi.fn(),
  track: vi.fn(),
  proofs: [] as ProofDoc[],
}));

// ProofSheet imports attachProof + track; ProofFeed imports reportProof/
// deleteProof + track + useFeed + useAuth. safeMediaUrl and Avatar stay real.
vi.mock('../data/proofs', () => ({
  attachProof: H.attachProof,
  reportProof: H.reportProof,
  deleteProof: H.deleteProof,
}));
vi.mock('../analytics', () => ({ track: H.track }));

// Defensive stand-in for the transitive `../firebase` module-scope import
// (mirrors w2-feed-moments.test.tsx): ProofFeed's graph now pulls
// src/data/hearts.ts → ./paths → ../firebase, whose module-scope getAuth
// throws on the test env's blank config. Nothing here calls Firestore.
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', analytics: null }));
// ProofFeed navigates to the Card tab from Tally Card actions (#261); mock
// the router hook so these router-free renders keep working.
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

// ProofFeed reads the merged Feed via useFeed (#34); this XSS suite only exercises
// Proof media sinks, so wrap H.proofs as proof Feed entries (no Moments).
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useFeed: () => ({
    entries: H.proofs.map((proof) => ({ feedKind: 'proof' as const, createdAt: proof.createdAt, proof })),
    tallyCards: [],
    loading: false,
  }),
  // ProofFeed also reads the event for the #211 Day chip; this XSS suite exercises
  // only the media sinks, so an empty event (no days[]) suffices.
  useEventDoc: () => ({ data: null, loading: false }),
  useMyDayBoards: () => new Map(),
  useAllDoubts: () => ({ doubts: [], loading: false, hasServerData: true }),
  // specs/feed-hearts.md: the Feed's flat hearts stream — empty here; the
  // hearts surface has its own suite (feed-hearts.test.tsx).
  useAllHearts: () => ({ hearts: [], loading: false, hasServerData: true }),
  // #392: the Feed resolves the viewer's own player row for its ask-for-proof
  // affordance; this XSS suite exercises only media sinks, so a loaded-absent row
  // (identity known, no saved name) suffices.
  useMyPlayer: () => ({ data: null, loading: false, hasServerData: true }),
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'viewer' } }) }));
// ProofFeed's doubts-cleared pill (#262) imports isDoubtSatisfied, and the #392
// Feed Doubt affordance imports openDoubts/doubtStatusFor/raiseDoubt — all from a
// module that initializes the REAL firebase app at import — fatal in CI, where no
// API key exists (locally .env.local masks it). This suite exercises only the
// media sinks (the who-list sheet those feed is never opened here); inert stubs
// keep the SDK out of the graph.
vi.mock('../data/doubts', () => ({
  isDoubtSatisfied: () => false,
  openDoubts: () => [],
  doubtStatusFor: () => 'none',
  raiseDoubt: () => Promise.resolve(),
}));
// #392: ProofFeed resolves the viewer's display name via resolveDisplayName from
// ../data/api, whose module ALSO imports the real firebase (same CI-fatal init).
// Stub the pure resolver so the SDK stays out of this suite's graph.
vi.mock('../data/api', () => ({
  resolveDisplayName: (player: { displayName?: string } | null | undefined, authName?: string | null) =>
    player?.displayName ?? authName ?? '',
}));

import ProofSheet from './ProofSheet';
import ProofFeed from './ProofFeed';

function cell(over: Partial<Cell> = {}): Cell {
  return { index: 0, itemId: 'i0', text: 'Saw a sailor in Speedos', free: false, marked: false, markedAt: null, ...over };
}

function sheetProps() {
  return {
    uid: 'u1',
    displayName: 'Deck Daddy',
    photoURL: null,
    cells: [] as Cell[],
    cell: cell(),
    claimMode: 'proof_required' as const,
    currentFirstBingoAt: null,
    onClose: vi.fn(),
  };
}

function proof(over: Partial<ProofDoc> & Pick<ProofDoc, 'id' | 'createdAt'>): ProofDoc {
  return {
    uid: `u-${over.id}`,
    displayName: 'Someone',
    photoURL: null,
    type: 'text',
    cellIndex: 0,
    itemText: 'a prompt',
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: null,
    reportCount: 0,
    status: 'active',
    visionFlag: null,
    ...over,
  } as ProofDoc;
}

beforeAll(() => {
  // jsdom has no URL.createObjectURL; the guard must pass the blob: it returns.
  (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:sec-xss-mock';
});

beforeEach(() => {
  vi.clearAllMocks();
  H.proofs = [];
  H.attachProof.mockResolvedValue(undefined);
  H.reportProof.mockResolvedValue(undefined);
  H.deleteProof.mockResolvedValue(undefined);
});

describe('safeMediaUrl — scheme allowlist', () => {
  it('allows blob:, http(s):, and image/audio data URLs through unchanged', () => {
    expect(safeMediaUrl('blob:https://app/uuid')).toBe('blob:https://app/uuid');
    expect(safeMediaUrl('blob:sec-xss-mock')).toBe('blob:sec-xss-mock');
    expect(safeMediaUrl('https://firebasestorage.example/p.jpg')).toBe('https://firebasestorage.example/p.jpg');
    expect(safeMediaUrl('http://localhost:9199/a.webm')).toBe('http://localhost:9199/a.webm');
    expect(safeMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeMediaUrl('data:audio/webm;base64,AAAA')).toBe('data:audio/webm;base64,AAAA');
  });

  it('rejects javascript:, vbscript:, data:text/html, and malformed URLs', () => {
    expect(safeMediaUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeMediaUrl('JavaScript:alert(1)')).toBeUndefined();
    expect(safeMediaUrl('vbscript:msgbox(1)')).toBeUndefined();
    expect(safeMediaUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeMediaUrl('file:///etc/passwd')).toBeUndefined();
    expect(safeMediaUrl('not a url')).toBeUndefined();
  });

  it('rejects null, empty, and whitespace-only values', () => {
    expect(safeMediaUrl(null)).toBeUndefined();
    expect(safeMediaUrl(undefined)).toBeUndefined();
    expect(safeMediaUrl('')).toBeUndefined();
    expect(safeMediaUrl('   ')).toBeUndefined();
  });

  // Second barrier (js/xss-through-dom #3): an accepted value is stripped of HTML
  // metacharacters before it can reach the DOM as a src. This is a no-op on every
  // real Proof media URL (they never contain < " '), and it is the barrier CodeQL
  // recognises so the class stops re-flagging.
  it('never returns a value containing an HTML metacharacter (< " \')', () => {
    // No-op on real Proof media URLs — returned byte-identical (also pinned above).
    expect(safeMediaUrl('blob:https://app/uuid')).toBe('blob:https://app/uuid');
    expect(safeMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    // A contrived accepted-scheme value carrying HTML metacharacters has them removed.
    const out = safeMediaUrl('https://x/a"b\'c<d');
    expect(out).toBeDefined();
    expect(out).not.toMatch(/["'<]/);
  });
});

describe('ProofSheet — text callout is inert; photo preview still renders', () => {
  it('ProofSheet: a text callout of an HTML payload renders as literal, inert text', async () => {
    const user = userEvent.setup();
    render(<ProofSheet {...sheetProps()} />);

    await user.click(screen.getByRole('button', { name: /callout/i }));
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(box, XSS);

    // The payload is the textarea's literal value — shown as text, never parsed.
    expect(box).toHaveValue(XSS);
    // No element was injected from the payload.
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('ProofSheet: a captured photo preview renders its blob: object URL as the img src', async () => {
    const user = userEvent.setup();
    const { container } = render(<ProofSheet {...sheetProps()} />);

    // No type is pre-selected (issue #181): choose Photo, then uploading a
    // file sets a blob: preview URL.
    await user.click(screen.getByRole('button', { name: /photo/i }));
    const file = new File(['img'], 'proof.jpg', { type: 'image/jpeg' });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    const img = container.querySelector('img.preview') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toBe('blob:sec-xss-mock');
  });
});

describe('ProofFeed — text Proof is inert; media schemes are guarded', () => {
  it('ProofFeed: a text Proof of an HTML payload renders as a literal, inert quote', () => {
    H.proofs = [proof({ id: 't', createdAt: 1, type: 'text', text: XSS })];
    render(<ProofFeed />);

    const quote = document.querySelector('blockquote.proof-quote') as HTMLElement;
    expect(quote).toBeInTheDocument();
    // Visible as literal text (had it been parsed, the payload would carry no text).
    expect(quote.textContent).toContain(XSS);
    // No element was injected from the payload (no <img src=x>, no img at all).
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('ProofFeed: a photo Proof renders an https media URL and drops a javascript: media URL', () => {
    H.proofs = [
      proof({ id: 'safe', createdAt: 2, type: 'photo', mediaURL: 'https://x/p.jpg' }),
      proof({ id: 'evil', createdAt: 1, type: 'photo', mediaURL: 'javascript:alert(1)' }),
    ];
    render(<ProofFeed />);

    const imgs = document.querySelectorAll('img.proof-media');
    expect(imgs).toHaveLength(1); // only the https photo rendered
    expect((imgs[0] as HTMLImageElement).getAttribute('src')).toBe('https://x/p.jpg');
    // The javascript: URL never became a src.
    expect(document.querySelector('img[src="javascript:alert(1)"]')).toBeNull();
  });

  it('ProofFeed: an audio Proof renders an https media URL', () => {
    H.proofs = [proof({ id: 'a', createdAt: 1, type: 'audio', mediaURL: 'https://x/a.webm' })];
    render(<ProofFeed />);

    const audio = document.querySelector('.proof-audio audio') as HTMLAudioElement;
    expect(audio).toBeInTheDocument();
    expect(audio.getAttribute('src')).toBe('https://x/a.webm');
  });
});
