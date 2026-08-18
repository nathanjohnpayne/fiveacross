import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  installFirestorePoisonRecovery,
  isFirestorePoisonAssertion,
  type PoisonRecoveryOptions,
} from './firestoreRecovery';
import { markResetAttempted } from './shellRecovery';

// Regression pins for the 2026-08-08 Bodega Bay incident (#722, see
// src/firestoreRecovery.ts). `b815` is Firestore's `AsyncQueue.verifyNotFailed`
// tombstone: the queue's `failure` field is set once and NEVER reset, so a
// poisoned Firestore instance re-throws it forever and the tab is dead for data
// purposes until it is reloaded.
//
// Three invariants, in order of how much damage getting them wrong would do:
//   1. the tombstone — and ONLY the tombstone — triggers recovery;
//   2. recovery happens at most once per tab, so it can never become the crash
//      loop it exists to end;
//   3. it never destroys anything, so a failed recovery is no worse than none.

vi.mock('./posthog', () => ({ phCapture: vi.fn() }));

/** The exact message from the 2026-08-08 Bodega crash loop (heaviest player). */
const BODEGA_TOMBSTONE =
  'FIRESTORE (12.17.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: b815) ' +
  'CONTEXT: {"rl":"TypeError: n.Tc.get is not a function or its return value is not iterable"}';

/** The 2026-07-19 Safari/macOS incident: the SAME tombstone, a different cause
 *  embedded in its CONTEXT — assertion 3c6b, itself carrying a Firebase AUTH
 *  error string that `isPermanentError` was never meant to classify. Two
 *  incidents, two causes, one tombstone: which is what proves it IS a tombstone. */
const SAFARI_TOMBSTONE =
  'FIRESTORE (12.17.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: b815) ' +
  'CONTEXT: {"rl":"FIRESTORE (12.17.0) INTERNAL ASSERTION FAILED: Unexpected state ' +
  '(ID: 3c6b) CONTEXT: {\\"code\\":\\"auth/network-request-failed\\"}"}';

function errorEvent(init: { error?: unknown; message?: string }): Event {
  const event = new Event('error');
  Object.defineProperty(event, 'error', { value: init.error });
  Object.defineProperty(event, 'message', { value: init.message ?? '' });
  return event;
}

function rejectionEvent(reason: unknown): Event {
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

/** A fresh tab-like harness. `target` stands in for `window`; a NEW harness with
 *  the same sessionStorage is exactly what a reload produces. */
function harness(options: Omit<PoisonRecoveryOptions, 'target' | 'reload'> = {}) {
  const target = new EventTarget();
  const reload = vi.fn();
  const uninstall = installFirestorePoisonRecovery({
    target,
    reload,
    // The normal recovery tests model the installed PWA: a controller proves a
    // precached shell is available, so the reload remains synchronous. The
    // uncontrolled first-visit guard has focused tests below.
    hasControllingServiceWorker: () => true,
    ...options,
  });
  return { target, reload, uninstall, poison: () => target.dispatchEvent(errorEvent({ error: new Error(BODEGA_TOMBSTONE) })) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isFirestorePoisonAssertion (detection is the thing that authorizes a reload)', () => {
  it('recognises the tombstone from BOTH production incidents', () => {
    expect(isFirestorePoisonAssertion(new Error(BODEGA_TOMBSTONE))).toBe(true);
    expect(isFirestorePoisonAssertion(new Error(SAFARI_TOMBSTONE))).toBe(true);
  });

  it('recognises it as a bare string and through the browser "Uncaught Error:" prefix', () => {
    expect(isFirestorePoisonAssertion(BODEGA_TOMBSTONE)).toBe(true);
    expect(isFirestorePoisonAssertion(`Uncaught Error: ${BODEGA_TOMBSTONE}`)).toBe(true);
  });

  it.each([
    // A DIFFERENT Firestore assertion. 3c6b is a one-off hard failure, not the
    // permanent latch, so the instance may well still work — reloading on it
    // would be an unwarranted response to a recoverable error.
    [
      'a different Firestore assertion id',
      'FIRESTORE (12.17.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: 3c6b) CONTEXT: {"code":"x"}',
    ],
    // The underlying cause on its own, before it reached the latch. Matching
    // TypeErrors would mean reloading on ordinary application bugs.
    ['the raw underlying cause', 'TypeError: n.Tc.get is not a function or its return value is not iterable'],
    ['an ordinary Firestore error', 'FirebaseError: [code=permission-denied]: Missing or insufficient permissions.'],
    ['a cross-origin script error', 'Script error.'],
    // The id alone is not enough — a player could type it into a Callout.
    ['the bare id in unrelated prose', 'the wifi password on deck b815 is not working'],
    // Ordering matters: the id has to follow the assertion header, not precede it.
    ['the id BEFORE the assertion header', '(ID: b815) FIRESTORE (12.17.0) INTERNAL ASSERTION FAILED: x (ID: 9999)'],
    ['an assertion with no product tag', 'INTERNAL ASSERTION FAILED: Unexpected state (ID: b815)'],
    // The id has to be the one belonging to the FIRST (outer) header — not any
    // `(ID: b815)` marker that shows up later in the string. A different outer
    // assertion whose nested CONTEXT happens to mention b815 is not the
    // tombstone: the tombstone's own reload budget must not be spent on it.
    [
      'a different outer assertion whose nested context happens to mention b815',
      'FIRESTORE (12.17.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: 3c6b) ' +
        'CONTEXT: {"rl":"FIRESTORE (12.17.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: b815) CONTEXT: {}"}',
    ],
  ])('does NOT recognise %s', (_label, message) => {
    expect(isFirestorePoisonAssertion(message)).toBe(false);
    expect(isFirestorePoisonAssertion(new Error(message))).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object with no message', { code: 'b815' }],
    ['an object with a non-string message', { message: { toString: () => BODEGA_TOMBSTONE } }],
  ])('does NOT recognise %s', (_label, value) => {
    expect(isFirestorePoisonAssertion(value)).toBe(false);
  });

  it('does NOT throw, and does NOT recognise, a value whose `message` getter throws', () => {
    // A thrown Proxy or an object with a throwing `message` getter must
    // degrade to "not the tombstone" — this runs on every global error and
    // unhandled rejection, so it must never itself become a second throw.
    const poisonedGetter: { message?: string } = {};
    Object.defineProperty(poisonedGetter, 'message', {
      get() {
        throw new Error('reading .message itself threw');
      },
    });
    expect(() => isFirestorePoisonAssertion(poisonedGetter)).not.toThrow();
    expect(isFirestorePoisonAssertion(poisonedGetter)).toBe(false);
  });
});

describe('installFirestorePoisonRecovery', () => {
  it('reloads on the tombstone — the recovery the ticket asks for', () => {
    const { reload, poison } = harness();
    poison();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads EXACTLY ONCE no matter how hard the amplifier hammers it', () => {
    // Our own multi-tab manager (ADR 0006) registers a `storage` listener whose
    // handler calls `enqueueRetryable` synchronously, and `enqueue` opens with
    // the latch check — so a poisoned tab re-throws b815 on every storage event
    // from any same-origin document, which is a burst, not a single event.
    const { reload, poison } = harness();
    for (let i = 0; i < 25; i += 1) poison();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('recovers from the unhandled-rejection path too', () => {
    // The tombstone reaches DOM error dispatch when it is thrown straight out
    // of the storage handler, and an unhandled rejection when it is thrown from
    // an operation already on the queue. Both are real; both must be covered.
    const { target, reload } = harness();
    target.dispatchEvent(rejectionEvent(new Error(BODEGA_TOMBSTONE)));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('recovers when only ErrorEvent.message carries the tombstone', () => {
    const { target, reload } = harness();
    target.dispatchEvent(errorEvent({ error: null, message: `Uncaught Error: ${BODEGA_TOMBSTONE}` }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([
    ['an ordinary app crash', new TypeError('cells.every is not a function')],
    ['a different Firestore assertion', new Error('FIRESTORE (12.17.0) INTERNAL ASSERTION FAILED: x (ID: 3c6b)')],
    ['a cross-origin script error', 'Script error.'],
    ['a resource-load Event with no detail', undefined],
  ])('does NOT reload on %s', (_label, error) => {
    const { target, reload } = harness();
    target.dispatchEvent(errorEvent({ error }));
    target.dispatchEvent(rejectionEvent(error));
    expect(reload).not.toHaveBeenCalled();
  });

  it('degrades to no recovery, and does not itself throw, on a `message` getter that throws', () => {
    // The fail-safe contract this watchdog exists under: a hostile or merely
    // buggy thrown value must never turn global error dispatch into a SECOND
    // unhandled exception.
    const poisonedGetter: { message?: string } = {};
    Object.defineProperty(poisonedGetter, 'message', {
      get() {
        throw new Error('reading .message itself threw');
      },
    });
    const { target, reload } = harness();
    expect(() => target.dispatchEvent(errorEvent({ error: poisonedGetter }))).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it('observes without swallowing — PostHog autocapture still sees the throw', () => {
    // The 2026-08-08 incident was only diagnosable because the raw exception
    // reached error tracking. A recovery that calls preventDefault() to look
    // tidy would blind us to the next one.
    const { target, reload } = harness();
    const event = errorEvent({ error: new Error(BODEGA_TOMBSTONE) });
    const notCancelled = target.dispatchEvent(event);
    expect(reload).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
    expect(notCancelled).toBe(true);
  });

  it('stops listening once uninstalled', () => {
    const { reload, uninstall, poison } = harness();
    uninstall();
    poison();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not run the origin probe when its service-worker shell controls the page', () => {
    const canReachOrigin = vi.fn().mockResolvedValue(true);
    const { reload, poison } = harness({ originReachable: canReachOrigin });
    poison();
    expect(reload).toHaveBeenCalledOnce();
    expect(canReachOrigin).not.toHaveBeenCalled();
  });
});

describe('the bound that makes this safe (recovery cannot loop)', () => {
  it('gives the RELOADED document no second automatic reload', () => {
    // THE load-bearing test. A new closure with new listeners over the same
    // sessionStorage is exactly what the reload produces. If the underlying
    // cause is persistent local state — the Bodega `TypeError` shape, which
    // recurs on a fresh instance — this is the only thing standing between the
    // fix and an infinite reload loop that would be far worse than the bug.
    const first = harness();
    first.poison();
    expect(first.reload).toHaveBeenCalledOnce();

    const afterReload = harness();
    afterReload.poison();
    expect(afterReload.reload).not.toHaveBeenCalled();
  });

  it('holds across a SECOND reloaded document', () => {
    const first = harness();
    first.poison();
    for (let i = 0; i < 3; i += 1) {
      const next = harness();
      next.poison();
      expect(next.reload).not.toHaveBeenCalled();
    }
    expect(first.reload).toHaveBeenCalledOnce();
  });

  it('declines to reload at all when the attempt cannot be recorded durably', () => {
    // The readable-but-unwritable store (quota, storage policy, some private
    // modes): setItem resolves and nothing persists, so the latch would answer
    // "unspent" on every load and one reload per tab would become an unbounded
    // loop. Fail closed — an uncountable attempt is not taken (Codex P1 on #513).
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
    const { reload, poison } = harness();
    poison();
    expect(reload).not.toHaveBeenCalled();
  });

  it('declines to reload when the store cannot even be read', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
    });
    const { reload, poison } = harness();
    poison();
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps a SEPARATE budget from the shell reset, so neither starves the other', () => {
    // A tab that already spent its shell reset on a stale-bundle crash must
    // still be able to recover from a Firestore poisoning an hour later.
    expect(markResetAttempted()).toBe(true);
    const { reload, poison } = harness();
    poison();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('survives a reload() that itself throws', () => {
    const target = new EventTarget();
    installFirestorePoisonRecovery({
      target,
      reload: () => {
        throw new Error('navigation blocked');
      },
    });
    expect(() => target.dispatchEvent(errorEvent({ error: new Error(BODEGA_TOMBSTONE) }))).not.toThrow();
  });
});

describe('offline', () => {
  function offline() {
    vi.stubGlobal('navigator', { onLine: false });
  }

  it('DEFERS rather than reloading while definitely offline', () => {
    // An offline reload with no precached shell yet lands on the browser's
    // error page. Note the asymmetry with shellRecovery.resetShell, which
    // demands positive proof of reachability: that path DELETES the only shell
    // the device has, and this one deletes nothing.
    offline();
    const { reload, poison } = harness();
    poison();
    expect(reload).not.toHaveBeenCalled();
  });

  it('takes the deferred reload when connectivity returns', () => {
    // This is the 2026-07-19 incident's own shape: transient loss of auth
    // connectivity is what poisons the queue, so cancelling the recovery while
    // offline would leave the tab permanently dead even after the network came
    // back. Deferring lands it exactly when it can succeed.
    offline();
    const { target, reload, poison } = harness();
    poison();
    expect(reload).not.toHaveBeenCalled();

    vi.stubGlobal('navigator', { onLine: true });
    target.dispatchEvent(new Event('online'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('uninstalls the deferred online retry with the rest of the watchdog', () => {
    offline();
    const { target, reload, uninstall, poison } = harness();
    poison();
    uninstall();

    vi.stubGlobal('navigator', { onLine: true });
    target.dispatchEvent(new Event('online'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not spend the attempt while merely deferred', () => {
    // Arming is not taking: a deferral that never fires must not burn the one
    // recovery this tab has.
    offline();
    const first = harness();
    first.poison();

    vi.stubGlobal('navigator', { onLine: true });
    const afterReload = harness();
    afterReload.poison();
    expect(afterReload.reload).toHaveBeenCalledOnce();
  });

  it('arms exactly ONE online retry no matter how many tombstones arrive', () => {
    offline();
    const { target, reload, poison } = harness();
    for (let i = 0; i < 10; i += 1) poison();

    vi.stubGlobal('navigator', { onLine: true });
    target.dispatchEvent(new Event('online'));
    target.dispatchEvent(new Event('online'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('defers an uncontrolled page until it can prove the origin is reachable', async () => {
    const canReachOrigin = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { target, reload, poison } = harness({
      hasControllingServiceWorker: () => false,
      originReachable: canReachOrigin,
    });
    poison();
    await vi.waitFor(() => expect(canReachOrigin).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();

    // A new online transition, not a lying `navigator.onLine === true`, is the
    // recovery trigger. The second strict probe succeeds, so NOW it can reload.
    target.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(canReachOrigin).toHaveBeenCalledTimes(2);
  });

  it('retries an uncontrolled nominally-online page once even without an online event', async () => {
    vi.useFakeTimers();
    const canReachOrigin = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { reload, poison } = harness({
      hasControllingServiceWorker: () => false,
      originReachable: canReachOrigin,
      reachabilityRetryMs: 1,
    });
    poison();
    await vi.runAllTicks();
    expect(canReachOrigin).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(canReachOrigin).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('installation', () => {
  it('defaults to window, where DOM-dispatch throws actually surface', () => {
    // The throw arrives outside React (see the module header), so the listener
    // has to be on the global — an ErrorBoundary can never see it.
    const add = vi.spyOn(window, 'addEventListener');
    const uninstall = installFirestorePoisonRecovery({ reload: vi.fn() });
    expect(add).toHaveBeenCalledWith('error', expect.any(Function));
    expect(add).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
    uninstall();
  });

  it('recovers from a tombstone dispatched on the real window', () => {
    const reload = vi.fn();
    const uninstall = installFirestorePoisonRecovery({ reload, hasControllingServiceWorker: () => true });
    window.dispatchEvent(errorEvent({ error: new Error(BODEGA_TOMBSTONE) }));
    uninstall();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('is inert with no target — importing src/firebase.ts under SSR or in Node must not throw', () => {
    const reload = vi.fn();
    expect(() => installFirestorePoisonRecovery({ target: null, reload })()).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });
});
