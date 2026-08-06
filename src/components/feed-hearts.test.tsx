// specs/feed-hearts.md — the client half of Hearts: the pure derivation
// (heartState: counts + the viewer's own state + ban semantics with the
// own-content exception), the slot id, the HeartButton DOM/motion contract,
// and the index.css structural pins. The write gate itself is pinned in
// tests/rules/feed-hearts.test.ts against the emulator.
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// HeartButton lives in ProofFeed.tsx, whose module graph pulls the Firebase
// singletons — stub them (the w2-feed-moments posture); nothing here touches
// Firestore.
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', analytics: null }));
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track }));

import { HeartButton } from './ProofFeed';
import { heartDocId, heartState } from '../data/hearts';
import type { HeartDoc } from '../types';

const indexCss = readFileSync('src/index.css', 'utf8');

const AT = 1000; // the canonical incarnation stamp for fixtures
const h = (
  uid: string,
  targetKind: 'proof' | 'moment',
  targetId: string,
  targetCreatedAt = AT,
): Pick<HeartDoc, 'uid' | 'targetKind' | 'targetId' | 'targetCreatedAt'> => ({
  uid,
  targetKind,
  targetId,
  targetCreatedAt,
});

/** jsdom has no AnimationEvent constructor, so fireEvent's init drops
 * `animationName` — build a plain event and pin the property, the shape
 * React's synthetic layer reads it from. */
function fireAnimationEnd(el: Element, animationName: string) {
  const evt = new Event('animationend', { bubbles: true });
  Object.defineProperty(evt, 'animationName', { value: animationName });
  fireEvent(el, evt);
}

describe('heartDocId — the deterministic once-only slot', () => {
  it('joins (uid, kind, targetId) with underscores, matching the rules binding', () => {
    expect(heartDocId('alice', 'proof', 'p1')).toBe('alice_proof_p1');
    expect(heartDocId('bob', 'moment', 'bob-bingo-d3')).toBe('bob_moment_bob-bingo-d3');
  });
});

describe('heartState — count + viewer state + ban semantics', () => {
  const hearts = [
    h('alice', 'proof', 'p1'),
    h('bob', 'proof', 'p1'),
    h('carol', 'proof', 'p1'),
    h('alice', 'moment', 'm1'),
    h('bob', 'proof', 'p2'),
  ];

  it('counts only the target post and reports whether the viewer hearted it', () => {
    expect(heartState(hearts, 'proof', 'p1', AT, 'alice')).toEqual({ count: 3, hearted: true });
    expect(heartState(hearts, 'proof', 'p1', AT, 'dave')).toEqual({ count: 3, hearted: false });
    expect(heartState(hearts, 'moment', 'm1', AT, 'bob')).toEqual({ count: 1, hearted: false });
    expect(heartState(hearts, 'proof', 'nope', AT, 'alice')).toEqual({ count: 0, hearted: false });
  });

  it('kind is part of the key — a proof and a moment sharing an id never pool', () => {
    const shared = [h('alice', 'proof', 'x'), h('bob', 'moment', 'x')];
    expect(heartState(shared, 'proof', 'x', AT, undefined).count).toBe(1);
    expect(heartState(shared, 'moment', 'x', AT, undefined).count).toBe(1);
  });

  it('a banned Player’s hearts vanish from other viewers’ counts…', () => {
    expect(heartState(hearts, 'proof', 'p1', AT, 'dave', ['bob'])).toEqual({ count: 2, hearted: false });
  });

  it('…but stay visible to THEMSELVES (own-content exception): the button must keep reading hearted', () => {
    // Without the exception a banned viewer would see unhearted and their
    // retap would just re-assert the same slot forever.
    expect(heartState(hearts, 'proof', 'p1', AT, 'bob', ['bob'])).toEqual({ count: 3, hearted: true });
  });

  it('scopes to the post INCARNATION: a recreated post never inherits the old one’s hearts (Codex P2 on #425)', () => {
    // Two hearts bound to the ORIGINAL incarnation (stamp AT), one to the
    // recreated post (stamp AT+5). Each incarnation counts only its own;
    // the viewer whose heart is stale reads unhearted on the new post.
    const mixed = [h('alice', 'moment', 'm1', AT), h('bob', 'moment', 'm1', AT), h('carol', 'moment', 'm1', AT + 5)];
    expect(heartState(mixed, 'moment', 'm1', AT + 5, 'alice')).toEqual({ count: 1, hearted: false });
    expect(heartState(mixed, 'moment', 'm1', AT, 'alice')).toEqual({ count: 2, hearted: true });
  });
});

describe('HeartButton — the Instagram-style like control', () => {
  it('renders unhearted: aria-pressed false, outline icon, count hidden at zero', () => {
    render(<HeartButton count={0} hearted={false} onToggle={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Heart this post' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn.className).not.toContain('hearted');
    expect(document.querySelector('.heart-count')).toBeNull();
  });

  it('renders hearted with the live count, labeled once for screen readers', () => {
    render(<HeartButton count={125} hearted={true} onToggle={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Unheart this post' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn.className).toContain('hearted');
    const count = document.querySelector('.heart-count');
    expect(count).not.toBeNull();
    expect(count!.getAttribute('aria-label')).toBe('125 hearts');
    expect(count!.textContent).toBe('125');
  });

  it('a like tap fires the toggle with the INTENDED state AND arms the burst; the burst releases on its own animationend', () => {
    const onToggle = vi.fn();
    render(<HeartButton count={0} hearted={false} onToggle={onToggle} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(btn.className).toContain('heart-burst');
    // A different animation ending (the ring) must NOT release the burst…
    fireAnimationEnd(btn, 'heart-ring');
    expect(btn.className).toContain('heart-burst');
    // …the pop's own end does.
    fireAnimationEnd(btn, 'heart-pop');
    expect(btn.className).not.toContain('heart-burst');
  });

  it('an unheart tap toggles QUIETLY — no burst (the like-only asymmetry)', () => {
    const onToggle = vi.fn();
    render(<HeartButton count={4} hearted={true} onToggle={onToggle} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(btn.className).not.toContain('heart-burst');
  });

  it('a quick double tap toggles BACK before any echo (Codex P2 on #425): intents alternate off the shown state', () => {
    const onToggle = vi.fn();
    // `hearted` stays false the whole time — no echo arrives between taps.
    render(<HeartButton count={0} hearted={false} onToggle={onToggle} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.click(btn);
    // First tap asks for ON, second (reading the optimistic shown state,
    // not the stale prop) asks for OFF — create-then-delete, matching the
    // user's final intent instead of double-creating.
    expect(onToggle.mock.calls).toEqual([[true], [false]]);
    // The button honestly shows the last intent while the writes settle.
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('the optimistic override yields to the prop once it next moves (echo or rollback)', () => {
    const { rerender } = render(<HeartButton count={0} hearted={false} onToggle={vi.fn()} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn); // optimistic ON
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    rerender(<HeartButton count={1} hearted={true} onToggle={vi.fn()} />); // the echo confirms
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    rerender(<HeartButton count={0} hearted={false} onToggle={vi.fn()} />); // a rollback reverts
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('the count span is keyed by value, so a change remounts it (the tick replays)', () => {
    const { rerender } = render(<HeartButton count={7} hearted={false} onToggle={vi.fn()} />);
    const before = document.querySelector('.heart-count-num');
    rerender(<HeartButton count={8} hearted={false} onToggle={vi.fn()} />);
    const after = document.querySelector('.heart-count-num');
    expect(after!.textContent).toBe('8');
    expect(after).not.toBe(before); // a NEW node — React remounted on the key
  });
});

describe('index.css — Most-Loved Photo structure (#534/#561, specs/most-loved-photo.md)', () => {
  it('styles the Feed cue with the muted-hint treatment (token color, both themes come free)', () => {
    const rule = indexCss.match(/\.feed-heart-cue\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).not.toBe('');
    expect(rule).toMatch(/color:\s*var\(--dim\)/);
  });

  it('defines the share-card photo-hero block: 500x276 hero box, letterboxed img, badge, frozen-count chip, credit, rows', () => {
    // The wireframe frame (fx-share-final-photo-*): hero pinned at the
    // wireframe's exact 2x (250x138 -> 500x276) so the photo box cannot
    // silently drift out of the 600x750 card budget — an oversized hero is
    // what sliced the credit's second line (P1, #561 verification).
    const hero = indexCss.match(/\.share-card-ml-hero\s*\{[^}]*\}/)?.[0] ?? '';
    expect(hero).toMatch(/width:\s*500px/);
    expect(hero).toMatch(/height:\s*276px/);
    const img = indexCss.match(/\.share-card-ml-img\s*\{[^}]*\}/)?.[0] ?? '';
    expect(img).toMatch(/object-fit:\s*contain/); // letterboxed, never cropped
    // The credit clamps to two lines AND is flex: none — the clamp alone
    // cannot protect it: a shrinkable flex item in the fixed column gets
    // height-compressed and its second line slices mid-glyph, no ellipsis.
    const by = indexCss.match(/\.share-card-ml-by\s*\{[^}]*\}/)?.[0] ?? '';
    expect(by).toMatch(/-webkit-line-clamp:\s*2/);
    expect(by).toMatch(/flex:\s*none/);
    expect(by).toMatch(/line-height:\s*1\.5/); // deterministic 51px two-line budget
    for (const cls of [
      '.share-card-ml-badge',
      '.share-card-ml-hearts',
      '.share-card-ml-by',
      '.share-card-ml-rows',
      '.share-card-ml-row',
      '.share-card-ml-rank',
      '.share-card-ml-name',
      '.share-card-ml-role',
      '.share-card-ml-stat',
    ]) {
      expect(indexCss).toContain(`${cls} {`);
    }
  });
});

describe('index.css — hearts motion structure (specs/feed-hearts.md)', () => {
  it('defines the heart keyframes in the motion vocabulary', () => {
    for (const name of ['heart-pop', 'heart-ring', 'heart-tick']) {
      expect(indexCss).toMatch(new RegExp(`@keyframes ${name}\\b`));
    }
  });

  it('fills the hearted icon with a theme token, never a literal', () => {
    const rule = indexCss.match(/\.heartbtn\.hearted \.heart-icon\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/fill:\s*var\(--primary\)/);
  });

  it('sits before the universal reduced-motion kill switch, which therefore covers it', () => {
    const killSwitchAt = indexCss.indexOf('reduced motion: the kill switch');
    expect(killSwitchAt).toBeGreaterThan(-1);
    for (const name of ['heart-pop', 'heart-ring', 'heart-tick']) {
      const at = indexCss.indexOf(`@keyframes ${name}`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(killSwitchAt);
    }
  });
});
