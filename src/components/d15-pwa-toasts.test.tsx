import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import {
  __resetToastStackForTests,
  __resetHasMarkedForTests,
  __resetClaimSheetOpenForTests,
  markSquareOccurred,
  setClaimSheetOpen,
  useToastSlot,
  useHasMarkedSquare,
  useClaimSheetOpen,
  type ToastPriority,
} from '../hooks/useToastStack';
// firebase/analytics + ../firebase mocked (not analytics.ts) so the real
// track() runs — proves the trigger rides the existing mark_square call site.
vi.mock('firebase/analytics', () => ({ logEvent: vi.fn() }));
vi.mock('../firebase', () => ({ analytics: null, analyticsReady: Promise.resolve(null) }));
import { track } from '../analytics';

// Covers specs/d15-pwa-toasts.md (#219)'s new shared coordinator/signals in
// isolation: toast-slot ranking/capacity, the first-Mark install trigger, and
// the claim-sheet-open update defer. InstallPrompt/UpdatePrompt's own use of
// these (no toast before the first Mark, new copy, defer while a sheet is
// open) is covered by the extended w1-pwa.test.tsx and
// app-update-reload-prompt.test.tsx, alongside the frozen mechanics.

function SlotProbe({ id, priority }: { id: string; priority: ToastPriority }) {
  const { visible, stackIndex } = useToastSlot(id, priority, true);
  return <span data-testid={id}>{visible ? stackIndex : 'waiting'}</span>;
}

function HasMarkedProbe() {
  return <span data-testid="marked">{String(useHasMarkedSquare())}</span>;
}

function ClaimSheetOpenProbe() {
  return <span data-testid="sheet">{String(useClaimSheetOpen())}</span>;
}

// Minimal in-memory localStorage stand-in — same stub + rationale as w1-pwa.test.tsx.
function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createStorageStub());
  __resetToastStackForTests();
  __resetHasMarkedForTests();
  __resetClaimSheetOpenForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useToastSlot stacking', () => {
  it('update ranks above install even when install requested a slot first (priority, not arrival order)', () => {
    const { rerender } = render(<SlotProbe id="install" priority="invitational" />);
    expect(screen.getByTestId('install')).toHaveTextContent('0');
    rerender(
      <>
        <SlotProbe id="install" priority="invitational" />
        <SlotProbe id="update" priority="urgent" />
      </>,
    );
    expect(screen.getByTestId('update')).toHaveTextContent('0');
    expect(screen.getByTestId('install')).toHaveTextContent('1');
  });

  it('caps visible toasts at MAX_VISIBLE_TOASTS — the lowest-ranked excess request waits for a slot', () => {
    // b and c share a priority, so the within-priority tie-break decides who
    // gets the last slot. That tie-break is the monotonic registration seq
    // (#334) — c registered after b, so c is newest and wins; b waits. No
    // Date.now() is involved, so there is no same-millisecond race for a slow
    // runner to flip (the #249 flake): this asserts the same outcome the old
    // wall-clock rank produced whenever b and c straddled a millisecond, now
    // guaranteed on every run.
    render(
      <>
        <SlotProbe id="a" priority="urgent" />
        <SlotProbe id="b" priority="invitational" />
        <SlotProbe id="c" priority="invitational" />
      </>,
    );
    expect(screen.getByTestId('a')).toHaveTextContent('0');
    expect(screen.getByTestId('c')).toHaveTextContent('1');
    expect(screen.getByTestId('b')).toHaveTextContent('waiting');
  });

  it('ranks a same-priority late-comer identically whether it mounts in the same commit or a later one — registration order, never timer granularity', () => {
    // The staggered twin of the sibling-mount case above: c registers in a
    // separate commit (arbitrarily later in wall-clock terms), and the ranking
    // must come out the same as when b and c mounted together — newest
    // registration wins the contested slot. Before #334 these two paths could
    // disagree: same-ms registrations fell back to insertion order while
    // cross-ms ones ranked newest-first.
    const { rerender } = render(
      <>
        <SlotProbe id="a" priority="urgent" />
        <SlotProbe id="b" priority="invitational" />
      </>,
    );
    expect(screen.getByTestId('a')).toHaveTextContent('0');
    expect(screen.getByTestId('b')).toHaveTextContent('1');
    rerender(
      <>
        <SlotProbe id="a" priority="urgent" />
        <SlotProbe id="b" priority="invitational" />
        <SlotProbe id="c" priority="invitational" />
      </>,
    );
    expect(screen.getByTestId('a')).toHaveTextContent('0');
    expect(screen.getByTestId('c')).toHaveTextContent('1');
    expect(screen.getByTestId('b')).toHaveTextContent('waiting');
  });
});

describe('first-Mark signal (install nudge trigger)', () => {
  it('is false until markSquareOccurred() fires, then true, and stays true across a simulated reload', () => {
    render(<HasMarkedProbe />);
    expect(screen.getByTestId('marked')).toHaveTextContent('false');
    act(() => markSquareOccurred());
    expect(screen.getByTestId('marked')).toHaveTextContent('true');

    __resetHasMarkedForTests(); // simulate a fresh module load after reload — storage persists
    cleanup();
    render(<HasMarkedProbe />);
    expect(screen.getByTestId('marked')).toHaveTextContent('true');
  });

  it('is triggered through the real mark_square track() call (analytics.ts), not a new call site', () => {
    render(<HasMarkedProbe />);
    act(() => track('mark_square', { mode: 'honor', marked: true }));
    expect(screen.getByTestId('marked')).toHaveTextContent('true');
  });

  it('is NOT triggered by an admin_confirm mark_square — that call runs on the ADMIN device, not the Player who marked (Codex round 1 finding 6, #727)', () => {
    render(<HasMarkedProbe />);
    act(() =>
      track('mark_square', {
        source: 'admin_confirm',
        mode: 'admin_confirmed',
        marked: true,
        uid: 'the-claim-owner',
      }),
    );
    // Confirming SOMEONE ELSE'S claim must not flip THIS (the admin's own)
    // device's "has marked a Square" flag and surface the install nudge to
    // an admin who never tapped a Square themselves.
    expect(screen.getByTestId('marked')).toHaveTextContent('false');
    // A real player action still works, proving the guard is source-scoped,
    // not a general regression of the trigger.
    act(() => track('mark_square', { source: 'pledge', mode: 'honor', marked: true }));
    expect(screen.getByTestId('marked')).toHaveTextContent('true');
  });
});

describe('claim-sheet-open signal (update banner defer)', () => {
  it('reflects setClaimSheetOpen(), in-memory only', () => {
    render(<ClaimSheetOpenProbe />);
    expect(screen.getByTestId('sheet')).toHaveTextContent('false');
    act(() => setClaimSheetOpen(true));
    expect(screen.getByTestId('sheet')).toHaveTextContent('true');
    act(() => setClaimSheetOpen(false));
    expect(screen.getByTestId('sheet')).toHaveTextContent('false');
  });
});
