// Firestore poison-latch recovery (#722): the escape hatch for a tab whose
// FIRESTORE INSTANCE — not its shell, not its React tree — has been permanently
// killed by an internal SDK assertion.
//
// THE FAILURE THIS EXISTS FOR (the 2026-08-08 Bodega Bay incident). The single
// most active player of a four-day event hit a `b815` crash loop on the day they
// were most active, and the tab never came back.
//
// WHY `b815` IS A TOMBSTONE, NOT A BUG. In the shipped `@firebase/firestore`
// 4.17.0 build, `b815` (hex for the assertion id 47125) is `AsyncQueue`'s
// `verifyNotFailed()`:
//
//     Xc() { this.zc && l(47125, { rl: getMessageOrStack(this.zc) }); }
//
// `this.zc` — the queue's `failure` field — is assigned exactly twice in the
// whole bundle: `null` in the constructor, and `= error` in the catch inside
// `enqueueInternal`. It is NEVER reset. So it is a permanent, per-instance
// poison latch: the first thing to throw inside the async queue kills that
// Firestore instance for the life of the document, and every operation
// afterwards re-throws `b815` instead of doing anything. `b815` is therefore not
// the cause of anything — it is the marker left on the corpse. The real cause
// rides inside its CONTEXT payload and DIFFERS PER INCIDENT, which is what
// proves the reading: two production incidents, two unrelated embedded causes,
// one shared tombstone.
//   - 2026-08-08 (Bodega, mobile Chrome): CONTEXT `{"rl":"TypeError: n.Tc.get is
//     not a function or its return value is not iterable"}`, thrown inside the
//     bundled persistence path with zero application frames.
//   - 2026-07-19 (Safari/macOS): CONTEXT embedding assertion `3c6b` with
//     `{"code":"auth/network-request-failed"}`. `3c6b` (15467) is the `default:`
//     arm of `isPermanentError`, which expects a Firestore gRPC `Code` enum and
//     hard-`fail()`s on anything else. A Firebase AUTH error string reached it,
//     so a TRANSIENT loss of auth connectivity is classified by hard assertion
//     rather than as retryable — and that hard assertion is what poisons the
//     queue. (Upstream defect; the reproduction is written up on the PR.)
//
// WHY THE APP CANNOT REPAIR THE INSTANCE IN PLACE. The obvious fix — `terminate()`
// then re-`initializeFirestore` — is not merely awkward here, it is structurally
// impossible: `FirestoreClient.terminate()` runs
// `asyncQueue.enqueueAndForgetEvenWhileRestricted(...)`, whose FIRST statement is
// the very `Xc()` above. Calling `terminate()` on a poisoned instance therefore
// throws `b815` itself. The same is true of the restart path behind
// `clearIndexedDbPersistence`. And even if the SDK allowed it, `db` is a
// module-scope `export const` that every `src/data/**` module and every live
// `onSnapshot` holds by reference; there is no seam to swap it through.
//
// So the honest recovery is the one the ticket's acceptance criterion asks for:
// "worst case the tab self-recovers on reload". A new document gets a new
// `AsyncQueue` with `failure = null`. This module makes that reload happen by
// itself, once, instead of leaving it to a player to guess at.
//
// WHY A GLOBAL LISTENER AND NOT THE ErrorBoundary. Our own `persistentLocalCache
// ({ tabManager: persistentMultipleTabManager() })` (ADR 0006, src/firebase.ts)
// instantiates `WebStorageSharedClientState`, which registers
// `window.addEventListener('storage', ...)` and whose handler calls
// `enqueueRetryable(...)` SYNCHRONOUSLY — and `enqueue()` opens with `Xc()`. So
// once poisoned, every `storage` event from any same-origin document re-throws
// `b815` straight into DOM event dispatch, outside React entirely. No
// ErrorBoundary can ever see it; `window`'s `error`/`unhandledrejection` events
// can. (This is an amplifier, not the cause, and the multi-tab manager is an ADR
// 0006 decision — it is not traded away here.)
//
// Every storage touch is guarded the way `src/shellRecovery.ts` and
// `src/postUpdateDeal.ts` guard theirs: a recovery path that can itself throw is
// not a recovery path. Every failure below degrades to "no recovery", never to a
// new crash.

import { phCapture } from './posthog';
import { attemptSpent, definitelyOffline, markAttempt, originReachable } from './shellRecovery';

/**
 * Marks that this tab already spent its ONE automatic poison reload.
 * Session-scoped, so closing the tab restores the free attempt — the same
 * posture, and the same reasoning, as `gcb:shell-reset-attempted`.
 *
 * A SEPARATE key from the shell reset on purpose. The two recoveries answer
 * different failures and must not be able to starve each other: a tab that
 * already spent its shell reset on a stale-bundle crash would otherwise have no
 * budget left when Firestore is poisoned an hour later. Two independent
 * one-shots bound this tab at two automatic reloads per session, total.
 */
const ATTEMPT_KEY = 'gcb:firestore-poison-reload';

/** The assertion id of the poison latch itself (`AsyncQueue.verifyNotFailed`). */
export const POISON_ASSERTION_ID = 'b815';

// Detection is deliberately the narrowest thing that can possibly identify the
// tombstone, because the action it authorizes is a page reload. Three ORDERED
// substrings must all appear: the Firestore product tag, the internal-assertion
// header, and then this exact id. Written as index scans rather than one regex
// so there is no backtracking to reason about on attacker-influenced text.
const PRODUCT_TAG = 'FIRESTORE (';
const ASSERTION_HEADER = 'INTERNAL ASSERTION FAILED';
const ID_MARKER = `(ID: ${POISON_ASSERTION_ID})`;

/**
 * Why matching ONLY `b815` is right, rather than "any Firestore assertion".
 *
 * Every other `fail()` id in the SDK marks a one-off throw: bad, but the
 * instance may well still work, and a reload is an unwarranted response. `b815`
 * is the one id that means *this instance is already dead and will stay dead* —
 * it is emitted by the latch check, so by definition nothing that instance is
 * asked to do afterwards can succeed. Reloading is the only remaining move, and
 * it is only ever the right move for this id.
 *
 * Anything unparseable reads as "not the tombstone". Cross-origin script errors
 * arrive as a bare `"Script error."` with no detail, resource-load failures
 * arrive as a plain `Event` with no `error` at all, and both correctly fall
 * through to no recovery.
 */
export function isFirestorePoisonAssertion(value: unknown): boolean {
  const text = assertionText(value);
  if (text === null) return false;
  const product = text.indexOf(PRODUCT_TAG);
  if (product < 0) return false;
  const header = text.indexOf(ASSERTION_HEADER, product);
  if (header < 0) return false;
  return text.indexOf(ID_MARKER, header) >= 0;
}

/** The message carried by a thrown value, if it carries one at all. */
function assertionText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const { message } = value as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  return null;
}

/** What this tab did about the poisoning, as reported to PostHog. */
type Disposition =
  /** Reloading now — the recovery actually happened. */
  | 'reload'
  /** Definitely offline; the reload is armed and waiting for `online`. */
  | 'deferred-offline'
  /** An uncontrolled shell could not prove the origin is reachable yet. */
  | 'deferred-unreachable'
  /** The one automatic reload was already spent in this tab. */
  | 'exhausted'
  /** The attempt could not be recorded durably, so it was not taken. */
  | 'uncountable';

/** The slice of `EventTarget` this needs, so tests can drive it without `window`. */
type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface PoisonRecoveryOptions {
  /** Defaults to `window`. Injected in tests so specs never touch the real one. */
  target?: ListenerTarget | null;
  /** Defaults to `location.reload()`. Injected so tests can assert the sequence. */
  reload?: () => void;
  /** Positive origin probe for an uncontrolled page. Injected to keep the recovery testable. */
  originReachable?: () => Promise<boolean>;
  /** Whether this document has a service-worker-controlled shell to reload into. */
  hasControllingServiceWorker?: () => boolean;
}

/** A controller is the cheap, reliable proof this page has the PWA shell to
 * reload into. An uncontrolled first visit gets no such promise and must probe
 * the origin before recovery navigates it away from the rendered page. */
function hasControllingServiceWorker(): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
  } catch {
    return false;
  }
}

/**
 * Watch for the tombstone and, at most once per tab, reload out of it.
 *
 * Returns an uninstall function. Inert (and harmless) with no `window`, which is
 * what keeps `src/firebase.ts` importable under SSR, in Node scripts, and in the
 * unit suite.
 *
 * All state lives in this closure rather than at module scope so a second
 * install cannot silently disarm the first; the two would still share the
 * sessionStorage latch, so the bound holds across both.
 */
export function installFirestorePoisonRecovery(options: PoisonRecoveryOptions = {}): () => void {
  // `=== undefined`, not `??`: an explicit `target: null` means "there is no
  // target", and must not fall back to `window`.
  const target =
    options.target === undefined ? (typeof window !== 'undefined' ? window : null) : options.target;
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  // Keep the post-guard non-null type inside the asynchronous callbacks below.
  const listenerTarget: ListenerTarget = target;
  const reload = options.reload ?? (() => window.location.reload());
  const canReachOrigin = options.originReachable ?? originReachable;
  const hasCachedShell = options.hasControllingServiceWorker ?? hasControllingServiceWorker;

  /** Set the instant a reload is committed, so the burst that follows is inert. */
  let reloading = false;
  /** Set while an uncontrolled page is proving that a replacement shell exists. */
  let recoveryPending = false;
  /** One armed `online` retry per document, never a stack of them. */
  let awaitingOnline = false;
  /** Retained so uninstall can cancel the deferred retry too. */
  let onlineRetry: (() => void) | null = null;
  /** Report a refusal once per document; the amplifier below fires it in bursts. */
  let reportedRefusal = false;
  /** Makes every listener and an in-flight reachability probe inert after teardown. */
  let disposed = false;

  function report(disposition: Disposition, source: string): void {
    phCapture(
      'firestore_poison_recovery',
      {
        disposition,
        source,
        assertion_id: POISON_ASSERTION_ID,
        build_stamp: __BUILD_STAMP__,
      },
      // Beacon, for the same reason `app_crash` uses one: the `reload`
      // disposition is followed immediately by a navigation, and the default
      // batched transport would lose the one event that makes the next wave of
      // this legible. (`phCapture` also persists to sessionStorage while PostHog
      // is still starting up, so a poisoning during boot survives the reload.)
      { transport: 'sendBeacon', send_instantly: true },
    );
  }

  function refuse(disposition: Disposition, source: string): void {
    if (reportedRefusal) return;
    reportedRefusal = true;
    report(disposition, source);
  }

  function deferUntilOnline(source: string): void {
    if (awaitingOnline || disposed) return;
    awaitingOnline = true;
    onlineRetry = () => {
      onlineRetry = null;
      awaitingOnline = false;
      void recover(`${source}:online`);
    };
    listenerTarget.addEventListener('online', onlineRetry, { once: true });
  }

  async function recover(source: string): Promise<void> {
    // The `storage`-event amplifier means the tombstone can be re-thrown dozens
    // of times a second. Everything below is idempotent, but short-circuiting
    // here keeps the burst from generating a burst of telemetry too.
    if (disposed || reloading || recoveryPending) return;

    // BOUND 1 — one automatic reload per tab, checked BEFORE anything else. A
    // poisoning whose underlying cause is persistent local state (the Bodega
    // `TypeError` shape) will simply recur on the fresh instance; without this
    // the recovery becomes the crash loop it was written to end. Reaching here
    // a second time means the reload did not fix it, which is a real finding —
    // hence the `exhausted` report rather than a silent return.
    if (attemptSpent(ATTEMPT_KEY)) return refuse('exhausted', source);

    // Offline: DEFER, do not cancel. This is not politeness — it is the
    // 2026-07-19 incident's own shape. Transient loss of auth connectivity is
    // what poisons the queue there, so refusing to recover while offline would
    // leave the tab permanently dead even after the network came back. Arming
    // `online` instead means the recovery lands exactly when it can succeed.
    //
    if (definitelyOffline()) {
      deferUntilOnline(source);
      refuse('deferred-offline', source);
      return;
    }

    // A controller means this document can reload through the PWA's precached
    // shell. An uncontrolled document (a first visit or a post-reset page) has
    // no cache guarantee: `navigator.onLine` can remain true behind a captive
    // portal, and reloading it into a browser error page is worse than leaving
    // the current, readable shell visible. Reuse shellRecovery's strict
    // redirect/same-origin/payload probe before that navigation. The pending
    // latch folds the b815 burst into one probe, and a failed probe retries only
    // on the next real `online` transition.
    if (!hasCachedShell()) {
      recoveryPending = true;
      let reachable = false;
      try {
        reachable = await canReachOrigin();
      } catch {
        // A probe is a guard, not a new failure path. Its failure is simply a
        // reason to wait for the next connectivity transition.
      } finally {
        recoveryPending = false;
      }
      if (disposed || reloading) return;
      if (!reachable) {
        deferUntilOnline(source);
        refuse('deferred-unreachable', source);
        return;
      }
      // The probe awaited. A different recovery could have spent this tab's
      // shared reload budget while it was in flight, so re-check before taking
      // the attempt below.
      if (attemptSpent(ATTEMPT_KEY)) return refuse('exhausted', source);
    }

    // BOUND 2 — the attempt must be recorded DURABLY before it is taken. A
    // readable-but-unwritable store (quota, storage policy, some private modes)
    // would let bound 1 answer "unspent" on every single load, turning one
    // reload per tab into an unbounded reload loop. Fail closed: no countable
    // attempt, no automatic reload (Codex P1 on #513, same trap).
    if (!markAttempt(ATTEMPT_KEY)) return refuse('uncountable', source);

    reloading = true;
    report('reload', source);
    try {
      reload();
    } catch {
      // `location.reload()` throws where navigation is blocked, and there is no
      // `window` under SSR. The latch is already spent, so this degrades to "no
      // recovery" — never to a second, unhandled failure on the recovery path.
    }
  }

  // Deliberately observe-only: no `preventDefault()`, no `stopPropagation()`.
  // PostHog's own exception autocapture and the console still need to see the
  // raw throw — that telemetry is the only reason the 2026-08-08 incident was
  // diagnosable at all.
  const onError = (event: Event): void => {
    const { error, message } = event as ErrorEvent;
    // `error` first: it is the thrown value. `message` is the fallback because
    // browsers surface it as `"Uncaught Error: <message>"`, which still carries
    // every marker, and some paths deliver one without the other.
    if (isFirestorePoisonAssertion(error) || isFirestorePoisonAssertion(message)) void recover('error');
  };
  const onRejection = (event: Event): void => {
    // The tombstone reaches here whenever it is thrown from an already-enqueued
    // operation rather than straight out of a DOM handler.
    if (isFirestorePoisonAssertion((event as PromiseRejectionEvent).reason)) void recover('unhandledrejection');
  };

  listenerTarget.addEventListener('error', onError);
  listenerTarget.addEventListener('unhandledrejection', onRejection);
  return () => {
    disposed = true;
    listenerTarget.removeEventListener('error', onError);
    listenerTarget.removeEventListener('unhandledrejection', onRejection);
    if (onlineRetry) listenerTarget.removeEventListener('online', onlineRetry);
    onlineRetry = null;
    awaitingOnline = false;
  };
}
