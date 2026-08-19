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
 * THE TWO CLOCKS START ON DIFFERENT LEGS, which is the whole subtlety here
 * (Phase 4b P1). The server's 120s `HANDOFF_TTL_MS` starts when the code is
 * MINTED — after Google authentication has already completed. This clock starts
 * when the transaction is created, BEFORE the player leaves the Event origin.
 * Everything that happens in between — picking an account, MFA, a password
 * reset, recovering a dropped connection, or simply putting the phone down —
 * elapses against this timer and none of it against the server's.
 *
 * So "looser than the server deadline" is not a coherent justification: they do
 * not measure the same interval. An earlier five-minute value would have
 * rejected, as `transaction-missing`, a player who returned with a freshly
 * minted and perfectly server-valid code after spending six minutes at Google —
 * a dead end produced entirely by the client.
 *
 * Thirty minutes is therefore sized against the SLOW HUMAN LEG rather than
 * against the server. What this timer actually exists for is narrow: stopping a
 * transaction abandoned hours or days ago from authorizing an unrelated sign-in
 * later. It does not enforce freshness — the server does that, on the only
 * clock that can, and it is the one that must reject a stale code.
 */
export const HANDOFF_TRANSACTION_TTL_MS = 1_800_000;

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
  /** Whether this exact sign-in tap collected the Event's 18+ acknowledgement. */
  acknowledgedAdultContent: boolean;
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

  // Confirm the complete semantic record came back, not merely its verifier.
  // A storage shim that retains the verifier but drops or rewrites the adult
  // acknowledgement must not be allowed to navigate: the return leg would then
  // lose the evidence collected by this exact tap while appearing durable.
  const stored = readHandoffTransaction(record.createdAt);
  return (
    stored?.verifier === record.verifier &&
    stored.targetOrigin === record.targetOrigin &&
    stored.returnPath === record.returnPath &&
    stored.acknowledgedAdultContent === record.acknowledgedAdultContent &&
    stored.createdAt === record.createdAt
  );
}

/**
 * The stored transaction, or `null` if there isn't a usable one.
 *
 * Anything unparseable, structurally wrong, or older than the TTL reads as
 * absent — the same disposition, because none of them can produce a redemption
 * and distinguishing them would only add branches that all end in "sign in
 * again".
 */
function parseRecord(raw: string | null, now: number): HandoffTransactionRecord | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { verifier, targetOrigin, returnPath, acknowledgedAdultContent, createdAt } = parsed as Record<
    string,
    unknown
  >;
  if (typeof verifier !== 'string' || !HANDOFF_TOKEN_PATTERN.test(verifier)) return null;
  if (typeof targetOrigin !== 'string' || targetOrigin.length === 0) return null;
  if (typeof returnPath !== 'string' || !returnPath.startsWith('/')) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  // A record from the future is as untrustworthy as an expired one (a clock
  // change during the round trip), and both fail the same way.
  if (now < createdAt || now - createdAt > HANDOFF_TRANSACTION_TTL_MS) return null;

  // Records created before #895 have no acknowledgement field. They remain
  // usable for sign-in but can never authorize an attestation; only literal
  // `true` is evidence that the checkbox was actually collected.
  return {
    verifier,
    targetOrigin,
    returnPath,
    acknowledgedAdultContent: acknowledgedAdultContent === true,
    createdAt,
  };
}

export function readHandoffTransaction(now: number): HandoffTransactionRecord | null {
  // Each store is PARSED AND VALIDATED in priority order, not merely read
  // (Codex P3, Phase 4b). Falling back only when the session copy is ABSENT
  // meant a damaged or expired session copy masked a perfectly good local one —
  // which defeats the dual-store recovery this module advertises, in precisely
  // the situation it exists for. Absent, malformed, and expired all have to
  // fall through, because all three mean "this store cannot produce a
  // redemption".
  return (
    parseRecord(readStore('sessionStorage'), now) ?? parseRecord(readStore('localStorage'), now)
  );
}

/** Delete the verifier from both stores. Called on EVERY terminal path, success included. */
export function forgetHandoffTransaction(): void {
  clearStore('sessionStorage');
  clearStore('localStorage');
}
