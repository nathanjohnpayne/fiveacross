/**
 * The private half of the centralised-auth handoff: the transaction verifier,
 * its published digest, and where the verifier waits while the player is away
 * (#549, [ADR 0010](../../docs/adr/0010-centralised-auth-origin-with-handoff.md),
 * server contract in `specs/auth-handoff.md`).
 *
 * WHY A VERIFIER EXISTS AT ALL. The handoff code crosses origins in a URL
 * fragment, and a bearer credential in a URL is only safe while possession of it
 * is not possession of a session. This is PKCE's verifier/challenge pair doing
 * exactly that job: the Event origin generates a random verifier, publishes only
 * `base64url(SHA-256(verifier))` as the transaction id, and keeps the verifier
 * itself. An attacker who reads the code out of browser history, over a
 * shoulder, or from a `Referer` leak still cannot redeem it, because redemption
 * requires the half that never left this origin.
 *
 * The digest must be byte-identical to the server's `transactionIdFor`
 * (`functions/src/authHandoff.ts`), which is Node's
 * `createHash('sha256').update(verifier, 'utf8').digest('base64url')` — i.e.
 * UNPADDED base64url over the ASCII verifier. `src/auth/handoff-parity.test.ts`
 * pins the two implementations against each other rather than trusting this
 * comment, because a padding or alphabet drift here would not fail loudly: it
 * would fail as "that sign-in link is no longer valid" on every handoff, which
 * is indistinguishable from a dozen benign causes.
 */

/**
 * Where the verifier waits, and why it is written to BOTH stores.
 *
 * `sessionStorage` is the narrower, correct-by-default home: it is scoped to the
 * one tab that started the sign-in and it survives navigating away and back,
 * which is exactly the shape of this round trip. But "the return lands in the
 * tab that left" is not guaranteed — an installed PWA can hand a top-level
 * navigation to the browser rather than the app window, and iOS Safari is
 * already documented in this repo (`SIGNIN_ADULT_ACK_KEY`, `src/auth/AuthContext.tsx`)
 * as dropping sessionStorage across a provider round trip while localStorage
 * survives. A lost verifier is not a security failure, it is an unrecoverable
 * dead end for the player: the code they came back with can never be redeemed
 * and no retry helps, because the code is single-use and already spent by then.
 *
 * So both, read session-first. The cost is one extra same-origin copy of a value
 * that is useless without a live code, bounded by a TTL, and deleted on the way
 * out of every terminal path.
 */
export const HANDOFF_TRANSACTION_KEY = 'fa:auth:handoff-transaction';

/**
 * How long a stored verifier stays usable, in milliseconds.
 *
 * Deliberately LONGER than the server's 120s `HANDOFF_TTL_MS`, not shorter, and
 * the asymmetry is the point: the server owns expiry and is the only clock that
 * may reject a code for age. If this TTL were the tighter one, a slow-but-valid
 * return would discard the verifier locally and turn a code the server would
 * still have honoured into a dead end. Five minutes is long enough that the
 * server's deadline is always the one that fires first, and short enough that an
 * abandoned sign-in cannot authorize an unrelated one later in the day.
 */
export const HANDOFF_TRANSACTION_TTL_MS = 300_000;

/** 32 bytes — 256 bits, 43 characters of base64url. Matches the server's code and digest shape. */
const VERIFIER_BYTES = 32;

/** Exactly one unpadded base64url-encoded 32-byte value. Anchored, fixed length. */
export const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface HandoffTransactionRecord {
  /** The secret half. Never leaves this origin except in the exchange call body. */
  verifier: string;
  /** The origin sign-in began on — the only origin this transaction may return to. */
  targetOrigin: string;
  /** Where in the app to land on return. */
  returnPath: string;
  /** ms epoch, for the TTL above. */
  createdAt: number;
}

/** Unpadded base64url, matching Node's `digest('base64url')`. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh 256-bit verifier.
 *
 * `crypto.getRandomValues` and nothing else — a `Math.random` fallback would be
 * strictly worse than failing, because it would produce a verifier that looks
 * correct, redeems correctly, and is predictable. Throwing here surfaces as an
 * explicit "sign-in could not start" rather than a silently weak transaction.
 */
export function createVerifier(): string {
  const bytes = new Uint8Array(VERIFIER_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * The public half: `base64url(SHA-256(verifier))`.
 *
 * Async because WebCrypto's digest is, which is why the whole start leg is async
 * — the alternative (a synchronous JS SHA-256) would mean shipping and trusting
 * a second hash implementation for no gain.
 */
export async function transactionIdFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * A store, or `undefined` if even NAMING it throws.
 *
 * Reading `globalThis.sessionStorage` is not a safe property access: in
 * privacy-restricted browsers and some embedded/third-party contexts the getter
 * itself throws `SecurityError`. Passing `globalThis.sessionStorage` straight
 * into a helper evaluates that getter at the CALL SITE, outside the helper's
 * own `try` — so the throw escapes before any fallback can run, and the
 * localStorage half of the durability story never gets a turn (Codex P2, round
 * 1). Every access therefore goes through here.
 */
function storeNamed(name: 'sessionStorage' | 'localStorage'): Storage | undefined {
  try {
    return globalThis[name];
  } catch {
    return undefined;
  }
}

function writeStore(name: 'sessionStorage' | 'localStorage', value: string): void {
  try {
    storeNamed(name)?.setItem(HANDOFF_TRANSACTION_KEY, value);
  } catch {
    /* Private mode, disabled storage, or quota. The other store may still take it. */
  }
}

function readStore(name: 'sessionStorage' | 'localStorage'): string | null {
  try {
    return storeNamed(name)?.getItem(HANDOFF_TRANSACTION_KEY) ?? null;
  } catch {
    return null;
  }
}

function clearStore(name: 'sessionStorage' | 'localStorage'): void {
  try {
    storeNamed(name)?.removeItem(HANDOFF_TRANSACTION_KEY);
  } catch {
    /* Nothing to do — an unreadable store cannot be holding a live verifier either. */
  }
}

/**
 * Persist the transaction before leaving for the central origin.
 *
 * Returns whether at least one store accepted it. A `false` return must ABORT
 * the sign-in rather than navigate anyway: leaving without a retrievable
 * verifier guarantees the return leg fails, and it fails only after the code has
 * been minted and spent, which is the most confusing possible moment to
 * discover that storage was unavailable.
 */
export function rememberHandoffTransaction(record: HandoffTransactionRecord): boolean {
  // Clear FIRST. An abandoned transaction from a previous attempt is readable
  // and still in-TTL, so leaving it in place lets the confirmation below be
  // satisfied by the WRONG record: if this write then fails in the
  // session-first store but succeeds in the other, the navigation publishes the
  // new digest while the return leg reads the old verifier, and every exchange
  // is rejected as a transaction mismatch (Codex P2, round 1).
  forgetHandoffTransaction();

  const serialized = JSON.stringify(record);
  writeStore('sessionStorage', serialized);
  writeStore('localStorage', serialized);

  // Confirm THIS record came back, not merely that some record did.
  return readHandoffTransaction(record.createdAt)?.verifier === record.verifier;
}

/**
 * The stored transaction, or `null` if there isn't a usable one.
 *
 * Anything unparseable, structurally wrong, or older than the TTL reads as
 * absent — the same disposition, because none of them can produce a redemption
 * and distinguishing them would only add branches that all end in "sign in
 * again".
 */
export function readHandoffTransaction(now: number): HandoffTransactionRecord | null {
  const raw = readStore('sessionStorage') ?? readStore('localStorage');
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { verifier, targetOrigin, returnPath, createdAt } = parsed as Record<string, unknown>;
  if (typeof verifier !== 'string' || !HANDOFF_TOKEN_PATTERN.test(verifier)) return null;
  if (typeof targetOrigin !== 'string' || targetOrigin.length === 0) return null;
  if (typeof returnPath !== 'string' || !returnPath.startsWith('/')) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  // A record from the future is as untrustworthy as an expired one (a clock
  // change during the round trip), and both fail the same way.
  if (now < createdAt || now - createdAt > HANDOFF_TRANSACTION_TTL_MS) return null;

  return { verifier, targetOrigin, returnPath, createdAt };
}

/** Delete the verifier from both stores. Called on EVERY terminal path, success included. */
export function forgetHandoffTransaction(): void {
  clearStore('sessionStorage');
  clearStore('localStorage');
}
