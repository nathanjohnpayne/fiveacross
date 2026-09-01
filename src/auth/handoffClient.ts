/**
 * The client half of the centralised-auth handoff (#549, ADR 0010, server
 * contract in `specs/auth-handoff.md`).
 *
 * This module holds the boundary PRIMITIVES and the start leg — everything that
 * needs no Firebase. The two legs that do call callables live next door in
 * `handoffExchange.ts`, and the split is load-bearing rather than tidy: the Sign
 * in button needs `startAuthHandoff` and the failure channel, and dragging the
 * exchange machinery (and with it the whole Firebase SDK) into that module graph
 * is both wasteful and, in tests, an unmockable import that boots the SDK.
 *
 * Three legs across two origins, and every one of them is outside
 * `AuthContext` on purpose. Two of the three are not Firebase auth transactions
 * at all — they are ORIGIN TRANSITIONS, which have to happen before a React tree
 * exists (the return leg must establish the session before `onAuthStateChanged`
 * settles, or the app renders signed-out and then flips) and before Event
 * resolution has run (the central auth origin serves no Event and would
 * otherwise fall to the not-found screen).
 *
 *   START     at the Event origin. Generate a transaction, keep the verifier,
 *             leave for the central origin. No callable — the Event origin never
 *             mints; it has no session to mint against.
 *   MINT      at the central auth origin, once Google sign-in has completed
 *             there. `mintAuthHandoff` returns the exact URL to bounce to.
 *   COMPLETE  back at the Event origin. Read the code out of the fragment, clear
 *             it, exchange code + verifier for a custom token, sign in.
 *
 * ORIGIN VALIDATION IS NOT DUPLICATED HERE. `specs/auth-handoff.md` is explicit:
 * the server checks the target origin against the `hostnames` registry and is
 * authoritative, and a second client-side copy would only drift. What this
 * module validates is its own inputs — the shape of a code, the shape of a
 * stored transaction — never whether an origin is allowed.
 */
import {
  HANDOFF_TOKEN_PATTERN,
  createVerifier,
  forgetHandoffTransaction,
  rememberHandoffTransaction,
  transactionIdFor,
} from './handoffTransaction';
import { clearUrlFragmentAndConfirm } from '../urlFragment';

/**
 * The fragment key the code rides back on: `https://host/path#fa_handoff=<code>`.
 *
 * A deliberate MIRROR of `HANDOFF_FRAGMENT_KEY` in `functions/src/authHandoff.ts`,
 * not an import: the two live in different TypeScript programs and the server
 * module pulls in `node:crypto`, which has no place in a browser bundle. The
 * repo's established answer to that split is a mirrored constant plus a parity
 * test that imports both and asserts they match (`src/data/w4-bug-report-contract-parity.test.ts`
 * does exactly this for the bug-report contract), which is what
 * `src/auth/handoff-parity.test.ts` does here.
 */
export const HANDOFF_FRAGMENT_KEY = 'fa_handoff';

/** The query parameters the Event origin hands the central auth origin. */
export const HANDOFF_PARAM_TARGET = 'target';
export const HANDOFF_PARAM_TRANSACTION = 'txn';
export const HANDOFF_PARAM_RETURN = 'return';

/** The path the central auth origin serves the sign-in bounce page at. */
export const HANDOFF_AUTH_PATH = '/auth/handoff';

/**
 * Why a handoff did not finish.
 *
 * Deliberately COARSER than the set of things that can go wrong, because the
 * server answers every exchange rejection identically on purpose — expired,
 * already used, wrong origin and never-existed are one `permission-denied` so a
 * caller cannot learn whether a guessed code was ever real. Inventing finer
 * client-side reasons would either be a lie or would leak the distinction the
 * server just spent effort hiding.
 */
export type HandoffFailureReason =
  /** We came back with a code but the verifier was gone — storage lost it. */
  | 'transaction-missing'
  /** The returned origin is not the one the transaction was started on. */
  | 'origin-mismatch'
  /** The server refused the exchange, or the network did. */
  | 'exchange-rejected'
  /** The custom token did not produce a session. */
  | 'sign-in-failed'
  /** The transaction could not be created or stored, so we never left. */
  | 'start-failed';

export interface HandoffFailure {
  reason: HandoffFailureReason;
}

/**
 * The last handoff failure, waiting to be shown once.
 *
 * Module scope rather than context state because the failure happens BEFORE the
 * React tree mounts — there is nowhere to put it yet. `consumeHandoffFailure`
 * is the same read-once shape `consumePostUpdateDealGrace` already uses for a
 * pre-mount signal the UI has to surface exactly once.
 */
let pendingFailure: HandoffFailure | null = null;

export function recordHandoffFailure(reason: HandoffFailureReason): void {
  pendingFailure = { reason };
}

/** Read the pending failure and clear it. Returns `null` when there is none. */
export function consumeHandoffFailure(): HandoffFailure | null {
  const failure = pendingFailure;
  pendingFailure = null;
  return failure;
}

/**
 * The handoff code carried by this page load, or `null`.
 *
 * REQUIRES a leading `#`, which is what makes "fragment only" a property of this
 * function rather than a promise about its callers. `window.location.hash` is
 * always either empty or `#`-prefixed, so nothing legitimate is refused — but
 * `URLSearchParams` silently strips a leading `?`, so without this check a
 * caller who passed `location.search` by mistake would be handed a code out of a
 * query string. That is precisely the placement ADR 0010 rules out, because a
 * query string reaches access logs, proxies, and every subsequent `Referer`.
 */
export function readHandoffCode(hash: string): string | null {
  if (!hash.startsWith('#')) return null;
  const fragment = hash.slice(1);
  if (fragment === '') return null;
  const code = new URLSearchParams(fragment).get(HANDOFF_FRAGMENT_KEY);
  if (code === null || !HANDOFF_TOKEN_PATTERN.test(code)) return null;
  return code;
}

/**
 * Strip the code from the address bar without touching anything else.
 *
 * `history.replaceState`, so there is no navigation and no new history entry —
 * a `location.hash = ''` would leave a `#` behind AND push an entry the player
 * could go Back to. The fragment never reached a server (that is why it is a
 * fragment), so this is about browser history and shoulder-surfing, not logs.
 *
 * Returns whether the code is ACTUALLY gone, which the caller is expected to
 * act on: it decides whether telemetry may safely read the URL at all.
 */
export function clearHandoffFragment(): boolean {
  return clearUrlFragmentAndConfirm((hash) => readHandoffCode(hash) !== null);
}

/** The URL the Event origin sends the player to. Built here, navigated to verbatim. */
export function buildAuthOriginUrl(input: {
  authOrigin: string;
  targetOrigin: string;
  transactionId: string;
  returnPath: string;
}): string {
  const url = new URL(HANDOFF_AUTH_PATH, input.authOrigin);
  url.searchParams.set(HANDOFF_PARAM_TARGET, input.targetOrigin);
  url.searchParams.set(HANDOFF_PARAM_TRANSACTION, input.transactionId);
  url.searchParams.set(HANDOFF_PARAM_RETURN, input.returnPath);
  return url.toString();
}

/** What the central auth origin needs off its own URL to mint. */
export interface HandoffRequest {
  targetOrigin: string;
  transactionId: string;
  returnPath: string;
}

/**
 * Parse a handoff request out of the central origin's query string.
 *
 * Shape-only. Whether `targetOrigin` is a registered Event address is the
 * SERVER's question, answered against the `hostnames` registry when it mints —
 * this refuses only what could never be an origin at all, so a malformed link
 * shows an error here instead of a uniform rejection one round trip later.
 */
export function parseHandoffRequest(search: string): HandoffRequest | null {
  const params = new URLSearchParams(search);
  const targetOrigin = params.get(HANDOFF_PARAM_TARGET);
  const transactionId = params.get(HANDOFF_PARAM_TRANSACTION);
  const returnPath = params.get(HANDOFF_PARAM_RETURN) ?? '/';

  if (targetOrigin === null || transactionId === null) return null;
  if (!HANDOFF_TOKEN_PATTERN.test(transactionId)) return null;
  try {
    if (new URL(targetOrigin).origin !== targetOrigin) return null;
  } catch {
    return null;
  }
  if (!isSameOriginPath(returnPath, targetOrigin)) return null;

  return { targetOrigin, transactionId, returnPath };
}

/**
 * Whether `path` is a same-origin deep link under `targetOrigin`.
 *
 * RESOLVED, not pattern-matched, and the difference is an open redirect
 * (Phase 4b P1). A `startsWith('/') && !startsWith('//')` test is a blacklist,
 * and blacklists lose here: `/%5Cevil.example` decodes to `/\evil.example`,
 * which WHATWG URL resolves as `https://evil.example/`, and encoded tabs and
 * newlines normalise into `//evil.example` the same way. Since this value is
 * handed to the server to build the URL that CARRIES THE HANDOFF CODE, a miss
 * turns the trusted central auth endpoint into an open redirect that leaks a
 * freshly minted code to whoever chose the path.
 *
 * Resolving and comparing origins has no list to keep current: whatever the
 * browser would actually navigate to is what gets checked. The server applies
 * the same invariant (`validateReturnPath`) and remains authoritative; this is
 * the near copy of it, so a malformed link fails here rather than one round
 * trip later.
 */
function isSameOriginPath(path: string, targetOrigin: string): boolean {
  if (!path.startsWith('/')) return false;
  // The server requires a path beginning with exactly one slash. A
  // protocol-relative path can resolve back to the same host and still violate
  // that wire contract, so origin equality alone is not sufficient (#912).
  if (path.startsWith('//') || path.startsWith('/\\')) return false;
  // Control characters are stripped or normalised by URL parsing rather than
  // rejected, so they have to go before the resolve rather than after.
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (path.includes('#')) return false;
  if (path.length > 512) return false;
  try {
    return new URL(path, targetOrigin).origin === targetOrigin;
  } catch {
    return false;
  }
}

/**
 * LEG 1 — start, at the Event origin.
 *
 * Everything that can fail happens BEFORE the navigation: the verifier is
 * generated, hashed and confirmed readable back out of storage, and only then
 * does the browser leave. Ordering it the other way round would discover
 * unavailable storage after a code had been minted and spent, which is both
 * unrecoverable and maximally confusing.
 *
 * Returns `false` if it could not start; the caller surfaces that rather than
 * navigating.
 */
export async function startAuthHandoff(input: {
  authOrigin: string;
  targetOrigin: string;
  returnPath: string;
  acknowledgedAdultContent?: boolean;
  navigate?: (url: string) => void;
}): Promise<boolean> {
  try {
    // Apply the same boundary the central origin will enforce before leaving
    // this page. A long or otherwise invalid current URL must not send the
    // player into a guaranteed rejection-and-retry loop; root is the safe,
    // same-origin fallback and preserves the sign-in itself (#912).
    const returnPathIsValid = isSameOriginPath(input.returnPath, input.targetOrigin);
    if (!returnPathIsValid) {
      // Fixed text only: the rejected value can contain private query data and
      // must not be copied into logs. Diagnostics are best-effort and must not
      // turn the safe root fallback into a sign-in failure.
      try {
        console.debug('[auth-handoff] invalid return path; using root');
      } catch {
        // Telemetry never blocks authentication.
      }
    }
    const returnPath = returnPathIsValid ? input.returnPath : '/';
    const verifier = createVerifier();
    const transactionId = await transactionIdFor(verifier);
    const stored = rememberHandoffTransaction({
      verifier,
      targetOrigin: input.targetOrigin,
      returnPath,
      acknowledgedAdultContent: input.acknowledgedAdultContent === true,
      createdAt: Date.now(),
    });
    if (!stored) {
      recordHandoffFailure('start-failed');
      return false;
    }
    const url = buildAuthOriginUrl({
      authOrigin: input.authOrigin,
      targetOrigin: input.targetOrigin,
      transactionId,
      returnPath,
    });
    const navigate = input.navigate ?? ((to: string) => window.location.assign(to));
    navigate(url);
    return true;
  } catch {
    forgetHandoffTransaction();
    recordHandoffFailure('start-failed');
    return false;
  }
}
