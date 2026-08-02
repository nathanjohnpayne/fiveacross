import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ProofDoc } from '../types';

// w2-proof-capture, Feed layer (RTL-jsdom). Drives the REAL ProofFeed + the REAL
// useFeed hook (composing useProofFeed + useMoments; Firestore's onSnapshot
// stubbed so we can hand-deliver snapshots), proving the ADR 0002 promise end to
// end: a posted Proof IS a Feed entry — it shows newest-first with the Player's
// name + the Prompt text, and it renders per capture type (photo <img>, audio
// <audio>, text quote). It also proves the PR #75 cross-writer guarantee: the
// Feed resolves each entry from the proofs DOC (displayName / itemText / media /
// cellIndex all live there), never from boards/{uid}.cells — so a queued
// bare-Mark drain that drops cells[i].proofId can never orphan a live Proof out
// of the Feed. Moments are delivered EMPTY here (this is the proof half); the
// merged Proofs+Moments ordering lives in src/components/w2-feed-moments.test.tsx.

const H = vi.hoisted(() => ({ onSnapshot: vi.fn(), reportProof: vi.fn(), deleteProof: vi.fn() }));

vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));

vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref; // paths.ts chains .withConverter on refs
    return ref;
  };
  return {
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    collectionGroup: (...args: unknown[]) => makeRef('collectionGroup', args),
    query: (...args: unknown[]) => ({ query: args }),
    where: (...args: unknown[]) => ({ where: args }),
    onSnapshot: H.onSnapshot,
  };
});

vi.mock('../data/proofs', () => ({ reportProof: H.reportProof, deleteProof: H.deleteProof }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
// ProofFeed navigates to the Card tab from Tally Card actions (#261); mock
// the router hook so these router-free renders keep working.
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'viewer' } }) }));

import ProofFeed from './ProofFeed';

type SnapCb = (snap: unknown) => void;
// ProofFeed subscribes to THREE targets via useFeed + its own useEventDoc: the
// proofs sub is a query() ({ query: [...] }); the moments sub is a bare
// collection ref (kind 'collection'); and the event doc — read by useMoments's
// moderation AND by ProofFeed's #211 Day-chip resolution — is a doc ref (kind
// 'doc'). Route each by shape so the event doc's onNext never lands in the
// moments slot (it expects a doc snapshot with .exists(), not a collection
// snapshot). `fire` delivers proofs + an empty moments snapshot + an empty event
// doc, so existing call sites — `sub.fire(colSnap([...]))` — keep working.
const emptyDocSnap = { exists: () => false, data: () => undefined, metadata: { fromCache: false } };
function captureOnNext(): { fire: (proofs: unknown, moments?: unknown, event?: unknown) => void } {
  const captured: { proofs: SnapCb | null; moments: SnapCb | null; events: SnapCb[]; tally: SnapCb | null; doubtsAll: SnapCb | null; heartsAll: SnapCb | null; notices: SnapCb | null } = {
    proofs: null,
    moments: null,
    events: [],
    tally: null,
    doubtsAll: null,
    heartsAll: null,
    notices: null,
  };
  H.onSnapshot.mockImplementation(((target: unknown, optionsOrNext: unknown, maybeNext?: SnapCb) => {
    // #262: useAllDoubts subscribes WITHOUT an options arg; normalize.
    const onNext = (typeof optionsOrNext === 'function' ? optionsOrNext : maybeNext) as SnapCb;
    const kind = target && typeof target === 'object' ? (target as { kind?: string }).kind : undefined;
    const args = target && typeof target === 'object' ? ((target as { args?: unknown[] }).args ?? []) : [];
    if (target && typeof target === 'object' && 'query' in (target as object)) captured.proofs = onNext;
    // #262: useAllDoubts' moderation read opens a SECOND event-doc sub — feed
    // them all so none starves the feed's loading gates.
    else if (kind === 'doc') captured.events.push(onNext);
    // #216: useFeed's third stream (useTallyCards) is a `collectionGroup` sub over
    // every Tally marker — route it separately so it never clobbers the moments slot.
    else if (kind === 'collectionGroup') captured.tally = onNext;
    // #262: the Feed's flat doubts subscription, routed by its path segment.
    else if (args[3] === 'doubts') captured.doubtsAll = onNext;
    // specs/feed-hearts.md: the flat hearts stream, routed by segment so it
    // never clobbers the moments slot; fed empty below.
    else if (args[3] === 'hearts') captured.heartsAll = onNext;
    // specs/admin-messages.md: useFeed's fourth stream (useNotices) is a flat
    // `notices` collection — route it by segment so it never clobbers the moments
    // slot, and fire it empty below so useFeed's notices half stops loading.
    else if (args[3] === 'notices') captured.notices = onNext;
    else captured.moments = onNext;
    return () => {};
  }) as never);
  return {
    fire: (proofs: unknown, moments: unknown = colSnap([]), event: unknown = emptyDocSnap) => {
      if (!captured.proofs || !captured.moments) throw new Error('feed not fully subscribed');
      act(() => {
        captured.proofs!(proofs);
        captured.moments!(moments);
        captured.events.forEach((fn) => fn(event));
        // Deliver an empty Tally-Card stream so useFeed's tally half stops loading;
        // this suite exercises the proof side (Tally Cards have their own suite).
        captured.tally?.(colSnap([]));
        captured.doubtsAll?.(colSnap([]));
        captured.heartsAll?.(colSnap([]));
        captured.notices?.(colSnap([]));
      });
    },
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

const colSnap = (docs: ProofDoc[]) => ({
  docs: docs.map((d) => ({ data: () => d })),
  metadata: { fromCache: false },
});

beforeEach(() => {
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {});
  H.reportProof.mockReset();
  H.reportProof.mockResolvedValue(undefined);
  H.deleteProof.mockReset();
});

describe('ProofFeed — the Proof IS the Feed entry (ADR 0002)', () => {
  it('renders proofs newest-first with the Player name and the Prompt text', () => {
    const sub = captureOnNext();
    render(<ProofFeed />);

    // Delivered OUT of creation order; useProofFeed sorts by createdAt desc.
    sub.fire(
      colSnap([
        proof({ id: 'old', createdAt: 1000, displayName: 'Barnacle Betty', itemText: 'Wore Crocs to dinner' }),
        proof({ id: 'new', createdAt: 3000, displayName: 'Deck Daddy', itemText: 'Saw a sailor in Speedos' }),
        proof({ id: 'mid', createdAt: 2000, displayName: 'Midge', itemText: 'Ordered a seventh cocktail' }),
      ]),
    );

    const cards = document.querySelectorAll('.proof');
    expect(cards).toHaveLength(3);
    // Newest first.
    expect(cards[0]).toHaveTextContent('Deck Daddy');
    expect(cards[0]).toHaveTextContent('Saw a sailor in Speedos');
    expect(cards[1]).toHaveTextContent('Midge');
    expect(cards[2]).toHaveTextContent('Barnacle Betty');
  });

  it('renders each capture type: a photo <img>, an audio <audio>, and a text callout', () => {
    const sub = captureOnNext();
    render(<ProofFeed />);

    sub.fire(
      colSnap([
        proof({ id: 'p', createdAt: 3000, type: 'photo', mediaURL: 'https://x/p.jpg', itemText: 'photo prompt' }),
        proof({ id: 'a', createdAt: 2000, type: 'audio', mediaURL: 'https://x/a.webm', itemText: 'audio prompt' }),
        proof({ id: 't', createdAt: 1000, type: 'text', text: 'he DID say that', itemText: 'text prompt' }),
      ]),
    );

    expect(document.querySelector('img.proof-media')).toBeInTheDocument();
    // #262: audio renders through the custom player — the <audio> element
    // lives (hidden) inside .proof-audio, with a Lucide play button.
    expect(document.querySelector('.proof-audio audio')).toBeInTheDocument();
    expect(document.querySelector('.proof-audio-play')).toBeInTheDocument();
    expect(screen.getByText(/he DID say that/)).toBeInTheDocument();
  });

  it('resolves each entry from the proof DOC, not the board — a clobbered cells[i].proofId never removes a Proof from the Feed (PR #75)', () => {
    // ProofFeed reads ONLY the proofs collection; displayName, itemText, media,
    // and cellIndex all live in the proof doc. It never touches
    // boards/{uid}.cells, so a queued bare-Mark drain that wholesale-replaces
    // cells and drops cells[i].proofId cannot orphan a live Proof out of the Feed.
    const sub = captureOnNext();
    render(<ProofFeed />);

    sub.fire(
      colSnap([
        proof({ id: 'orphan', createdAt: 5000, displayName: 'Still Here', itemText: 'Backing cell was clobbered' }),
      ]),
    );

    expect(screen.getByText('Still Here')).toBeInTheDocument();
    expect(screen.getByText(/Backing cell was clobbered/)).toBeInTheDocument();
  });

  it('#211: badges a source:"library" Proof 🖼️ and renders a "Day N · Theme" chip from dayIndex', () => {
    const sub = captureOnNext();
    render(<ProofFeed />);

    // Deliver an event whose days[1] is the get-sporty theme so the chip resolves
    // "Day 2 · Get Sporty" (dayChipLabel is 1-based).
    const eventSnap = {
      exists: () => true,
      data: () => ({ days: [{ index: 0, theme: 'neon-playground' }, { index: 1, theme: 'get-sporty' }] }),
      metadata: { fromCache: false },
    };
    sub.fire(
      colSnap([
        proof({ id: 'lib', createdAt: 3000, type: 'photo', mediaURL: 'https://x/l.jpg', source: 'library', dayIndex: 1, displayName: 'Library Larry' }),
        proof({ id: 'cam', createdAt: 2000, type: 'photo', mediaURL: 'https://x/c.jpg', source: 'camera', displayName: 'Camera Cathy' }),
      ]),
      colSnap([]),
      eventSnap,
    );

    const cards = document.querySelectorAll('.proof');
    // The library pick carries the 🖼️ badge and the resolved Day chip…
    // #262: the badge is the wireframes' media OVERLAY ('🖼️ library'), and
    // the chip carries the theme emoji.
    expect(cards[0].querySelector('.proof-src-badge')?.textContent).toBe('🖼️ library');
    expect(cards[0]).toHaveTextContent('Day 2 · 🏋️ Get Sporty');
    // …the camera pick overlays '📷 live' and (no dayIndex) has no chip.
    expect(cards[1].querySelector('.proof-src-badge')?.textContent).toBe('📷 live');
    expect(cards[1].querySelector('.proof-day-chip')).toBeNull();
  });

  it('shows the empty state once server snapshots arrive with no proofs and no moments', () => {
    const sub = captureOnNext();
    render(<ProofFeed />);
    sub.fire(colSnap([]));
    expect(screen.getByText(/nothing in the feed yet/i)).toBeInTheDocument();
  });
});

// --- #363: photos letterbox/pillarbox over a blurred fill — never cropped ----

describe('ProofFeed — photo fit and the blurred fill layer (#363)', () => {
  it('renders the blurred fill BEHIND the contained photo, both from the SAME safeMediaUrl-guarded value', () => {
    const sub = captureOnNext();
    render(<ProofFeed />);
    sub.fire(colSnap([proof({ id: 'p', createdAt: 1000, type: 'photo', mediaURL: 'https://x/p.jpg' })]));

    const wrap = document.querySelector('.proof-media-wrap')!;
    const blur = wrap.querySelector('img.proof-media-blur')!;
    const fg = wrap.querySelector('img.proof-media')!;
    // One guarded URL feeds both layers — the blur fill is not a second,
    // separately-resolved src path around the safeMediaUrl barrier.
    expect(fg.getAttribute('src')).toBe('https://x/p.jpg');
    expect(blur.getAttribute('src')).toBe('https://x/p.jpg');
    // The fill is decorative: empty alt, hidden from the a11y tree, and FIRST
    // in the wrap so the sharp photo paints above it.
    expect(blur.getAttribute('alt')).toBe('');
    expect(blur.getAttribute('aria-hidden')).toBe('true');
    expect(wrap.firstElementChild).toBe(blur);
  });

  it('a forged non-media scheme renders NEITHER layer (the safeMediaUrl barrier covers the fill too)', () => {
    const sub = captureOnNext();
    render(<ProofFeed />);
    sub.fire(colSnap([proof({ id: 'x', createdAt: 1000, type: 'photo', mediaURL: 'javascript:alert(1)' })]));
    expect(document.querySelector('.proof-media')).toBeNull();
    expect(document.querySelector('.proof-media-blur')).toBeNull();
  });

  // jsdom never applies index.css, so the non-cropping geometry is pinned the
  // way src/theme/a11y-badge-contrast.test.tsx pins badge colors: parse the
  // real stylesheet and assert the rule bodies.
  it('index.css: .proof-media CONTAINS (never crops) and .proof-media-blur is the cover-fit blurred fill', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf-8');
    // Full RegExp-metacharacter escape (backslash included) — escaping only
    // `.` is the incomplete-sanitization CodeQL flags (js/incomplete-sanitization).
    const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ruleBody = (selector: string): string => {
      const m = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`));
      if (!m) throw new Error(`rule not found: ${selector}`);
      return m[1];
    };
    expect(ruleBody('.proof-media')).toMatch(/object-fit:\s*contain/);
    expect(ruleBody('.proof-media')).not.toMatch(/object-fit:\s*cover/);
    expect(ruleBody('.proof-media-blur')).toMatch(/object-fit:\s*cover/);
    expect(ruleBody('.proof-media-blur')).toMatch(/filter:\s*blur/);
    // The wrap clips the over-scaled blur to the media's rounded box.
    expect(ruleBody('.proof-media-wrap')).toMatch(/overflow:\s*hidden/);
  });
});
