/**
 * The centralised-auth handoff: minting a single-use code and exchanging it for
 * a Firebase custom token (#548, [ADR 0010](../../docs/adr/0010-centralised-auth-origin-with-handoff.md),
 * contract in `specs/auth-handoff.md`).
 *
 * WHY THIS EXISTS. Google validates OAuth redirect URIs exactly, so a wildcard
 * Event host (`<slug>.fiveacross.app`) can never be its own callback. Sign-in
 * therefore happens at one registered origin and the player is returned to the
 * Event origin they started on. Something has to carry "this browser is now
 * authenticated as this UID" across that origin boundary, and **it may not be a
 * token**: ADR 0010 forbids an ID token, a refresh token, or a custom token
 * from ever appearing in a URL. What crosses is an opaque handoff code, which is
 * safe to put in a URL only because of the four properties below — remove any
 * one of them and a URL-borne credential becomes account takeover.
 *
 *   1. SINGLE USE, enforced transactionally. This is why the code is a Firestore
 *      document rather than a signed stateless blob: a signature proves
 *      authenticity but cannot prove first use. `exchangeHandoff` reads and
 *      marks the document inside one transaction, so under concurrent exchange
 *      Firestore aborts the loser, its callback re-runs, and the re-read sees
 *      `consumedAt` already set.
 *   2. SHORT TTL, enforced server-side (`HANDOFF_TTL_MS`). The code exists to
 *      survive one redirect hop, so its life is measured against that hop and
 *      not against a session.
 *   3. ORIGIN BOUND. The code names the exact origin it may be redeemed on, and
 *      that origin was checked against the hostname registry before the code
 *      existed. This is what makes the return leg not an open redirect.
 *   4. TRANSACTION BOUND, PKCE-style. The Event origin keeps a random verifier
 *      privately and publishes only its SHA-256. The code alone is therefore
 *      NOT sufficient to redeem: an attacker who reads the code out of a URL —
 *      browser history, a shoulder-surf, a `Referer` leak — still cannot produce
 *      the verifier, which never leaves the origin that generated it.
 *
 * WHY THE DOCUMENT IS KEYED BY A HASH. ADR 0010 wrote the path as
 * `authHandoffs/{code}`. It is `authHandoffs/{sha256(code)}` here, which
 * preserves the ADR's substance — one opaque document per code, consumed
 * transactionally — while removing the live bearer credential from data at rest.
 * A stored raw code is directly redeemable by anyone who can read it; a stored
 * hash is not. Rules deny every client, so this is defence in depth against a
 * future rules widening, a backup, or an export, and it costs one hash per call.
 *
 * PURE AND INJECTABLE, mirroring `emailOptOut.ts` and `unlockDay.ts`: the
 * Firestore surface is a minimal passed-in interface and randomness, time, token
 * minting and the account check are all injected. Nothing here imports
 * `firebase-admin` or `firebase-functions`, so the whole module is exercisable
 * both against an in-memory fake and against a real emulator through a thin
 * adapter — which is how the concurrent-exchange proof is a real one.
 *
 * FAILURES ARE RETURNED, NOT THROWN, and they are specific. The seam in
 * `index.ts` collapses every rejection into one opaque client-facing error, so
 * the caller cannot tell "no such code" from "already used" from "expired" —
 * distinguishing them would confirm to an attacker that a guessed code was real.
 * The precise reason stays server-side for logs and for tests.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// --- Contract constants ---------------------------------------------------------

/** The server-owned collection. Denied to every client in `firestore.rules`. */
export const HANDOFF_COLLECTION = 'authHandoffs';

/**
 * How long a minted code stays redeemable, in milliseconds.
 *
 * Two minutes, not the ten an OAuth authorization code is allowed: this code
 * has to survive exactly one redirect from the central origin back to the Event
 * origin, which is a network hop and a page load. Anything longer is a window
 * that buys the player nothing and buys an attacker who has seen the URL time to
 * use it. It is generous against a slow phone on a ship's wifi, and it is the
 * upper bound on how stale a `hostnames` deactivation can be at redemption.
 */
export const HANDOFF_TTL_MS = 120_000;

/**
 * The fragment key the code rides back on: `https://host/path#fa_handoff=<code>`.
 *
 * A FRAGMENT, not a query parameter, and the difference is security rather than
 * taste. A fragment is never sent to any server: it is absent from the Event
 * origin's access logs, absent from any CDN or proxy in front of it, and absent
 * from the `Referer` header of every subsequent request the page makes. A
 * `?code=` would be written into all three. The client still clears it from the
 * address bar after reading it (#549), but the fragment means a leak requires
 * access to the browser rather than to a log.
 */
export const HANDOFF_FRAGMENT_KEY = 'fa_handoff';

/**
 * 32 bytes of `randomBytes` in base64url — 43 characters, 256 bits.
 *
 * The same shape and length as the transaction verifier and its digest, so one
 * format check covers all three. At 2^256 the code is not guessable and the
 * endpoint needs no brute-force counter; what it does need is to reject
 * malformed input BEFORE touching Firestore, which `HANDOFF_TOKEN_PATTERN` does.
 */
const HANDOFF_TOKEN_BYTES = 32;

/** Exactly one base64url-encoded 32-byte value. Anchored, fixed length. */
export const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The longest `returnPath` accepted, in characters. */
const MAX_RETURN_PATH = 512;

/** The longest origin string accepted, in characters. */
const MAX_ORIGIN = 255;

/**
 * A DNS hostname of at least two labels, lowercase.
 *
 * Load-bearing beyond tidiness: the validated hostname is interpolated into the
 * `hostnames/{host}` document path, so anything that could contain a `/` must
 * never reach it. `URL` parsing already guarantees that, and this is the second
 * lock. It also rejects bracketed IPv6 literals and bare single labels, neither
 * of which is a serving address.
 */
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Loopback authorities, allowed only when this process is pointed at emulators. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// --- Minimal admin-SDK Firestore surface ----------------------------------------

/** Anything with the admin/client `Timestamp.toMillis()` shape. */
export interface HandoffTimestamp {
  toMillis(): number;
}

export interface HandoffSnapshot {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface HandoffDocRef {
  get(): Promise<HandoffSnapshot>;
  /** Admin-SDK `DocumentReference.create` — writes only if the document does
   *  not already exist. Minting relies on the rejection rather than on trusting
   *  that 256 random bits never collide. */
  create(data: Record<string, unknown>): Promise<unknown>;
}

/**
 * The minimal transaction surface. Mirrors both the admin SDK's `Transaction`
 * and the web SDK's, which is what lets the same consume path be proven against
 * a real emulator. Reads inside it are serialized against concurrent writers and
 * the whole callback re-runs on contention — the property single-use rests on.
 */
export interface HandoffTransaction {
  get(ref: HandoffDocRef): Promise<HandoffSnapshot>;
  update(ref: HandoffDocRef, data: Record<string, unknown>): void;
}

export interface HandoffFirestore {
  doc(path: string): HandoffDocRef;
  runTransaction<T>(updateFunction: (tx: HandoffTransaction) => Promise<T>): Promise<T>;
}

// --- Results --------------------------------------------------------------------

/**
 * Why a mint was refused. Never returned to the caller verbatim — see the module
 * note on uniform client-facing errors.
 */
export type HandoffMintReason =
  | 'unauthenticated'
  | 'app-check-required'
  | 'invalid-target-origin'
  | 'origin-not-allowed'
  | 'invalid-transaction-id'
  | 'invalid-return-path';

/** Why an exchange was refused. */
export type HandoffExchangeReason =
  | 'invalid-code'
  | 'invalid-verifier'
  | 'invalid-origin'
  | 'origin-mismatch'
  | 'unknown-code'
  | 'replayed'
  | 'expired'
  | 'transaction-mismatch'
  | 'account-unusable'
  /** App Check enforcement is on and the caller presented no valid token. */
  | 'app-check-required'
  /** The stored document is not the shape this module writes — fail closed
   *  rather than guess which half of it to trust. */
  | 'malformed-record';

export type HandoffMintResult =
  | {
      ok: true;
      /** The raw code. Returned for tests and for the URL below; the wire
       *  response deliberately carries only `handoffUrl`. */
      code: string;
      /** The exact URL the central origin must redirect to. Built server-side
       *  from the validated origin so the caller cannot substitute another. */
      handoffUrl: string;
      targetOrigin: string;
      /** ms epoch. */
      expiresAt: number;
    }
  | { ok: false; reason: HandoffMintReason };

export type HandoffExchangeResult =
  | { ok: true; customToken: string; uid: string }
  | { ok: false; reason: HandoffExchangeReason };

// --- Origin and path validation -------------------------------------------------

/**
 * Whether loopback origins are acceptable targets. True only when the process is
 * actually running against emulators, so the arm is unreachable in production —
 * which is what stops `http://localhost` from being a production bypass.
 */
export interface OriginPolicy {
  allowLocalDev: boolean;
}

/**
 * Parse a string that must be EXACTLY an origin and nothing else.
 *
 * The check is one comparison because `URL.origin` is a normalisation:
 * it is `scheme://host[:port]` with the path, query, fragment and any
 * `user:pass@` credentials stripped, and it is the literal string `"null"` for
 * every non-special scheme. Requiring it to equal the input verbatim therefore
 * rejects `https://good.test/redirect?to=evil`, `https://user@evil.test`,
 * `data:...`, a trailing slash, and mixed case in one line, with no list of
 * decorations to keep up to date. `window.location.origin` — the only value a
 * caller should ever send — is always already in this form.
 */
export function parseOrigin(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_ORIGIN) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (url.username !== '' || url.password !== '') return null;
  return url;
}

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

export type TargetOriginResult =
  | { ok: true; origin: string; eventId: string | null }
  | { ok: false; reason: 'invalid-target-origin' | 'origin-not-allowed' };

/**
 * Validate a return origin against the allowlist. THE allowlist is the hostname
 * registry, `hostnames/{host}` (ADR 0009, `specs/hostnames-lookup.md`): an
 * active document there is what "a registered Event address" means, it is
 * Admin-SDK-write-only so no client can widen it, and it already has to exist
 * for the address to serve an Event at all.
 *
 * A static list of Event hosts would be self-defeating — the handoff exists
 * precisely because Event hostnames cannot be registered one by one — so there
 * is no second source here to drift from the first. `FIRST_PARTY_AUTH_HOSTS`
 * (`src/auth-domain.ts`) is deliberately NOT consulted: it answers a different
 * question ("is the OAuth helper same-origin here?"), and every host in it that
 * serves an Event carries a hostname document anyway.
 *
 * This is the whole of the open-redirect defence and the whole of "unrecognised
 * slugs rejected": an unregistered slug has no document, and an attacker's
 * domain can never acquire one.
 */
export async function validateTargetOrigin(
  db: HandoffFirestore,
  raw: unknown,
  policy: OriginPolicy,
): Promise<TargetOriginResult> {
  const url = parseOrigin(raw);
  if (!url) return { ok: false, reason: 'invalid-target-origin' };

  if (isLoopback(url)) {
    return policy.allowLocalDev
      ? { ok: true, origin: url.origin, eventId: null }
      : { ok: false, reason: 'origin-not-allowed' };
  }

  // Beyond loopback there is exactly one acceptable shape: plain HTTPS on the
  // default port. A port would not match any registry key, and `http:` would
  // hand the code to a network attacker on the return leg.
  if (url.protocol !== 'https:') return { ok: false, reason: 'invalid-target-origin' };
  if (url.port !== '') return { ok: false, reason: 'invalid-target-origin' };
  if (!HOSTNAME_PATTERN.test(url.hostname)) return { ok: false, reason: 'invalid-target-origin' };

  const snap = await db.doc(`hostnames/${url.hostname}`).get();
  if (!snap.exists) return { ok: false, reason: 'origin-not-allowed' };
  const data = snap.data() ?? {};
  // `status` is never defaulted (specs/hostnames-lookup.md): only `active`
  // serves, so only `active` may receive a player back.
  if (data.status !== 'active') return { ok: false, reason: 'origin-not-allowed' };
  const eventId = typeof data.eventId === 'string' && data.eventId !== '' ? data.eventId : null;
  return { ok: true, origin: url.origin, eventId };
}

/**
 * Validate the caller's deep-link path and return it normalised, or `null`.
 *
 * The path exists so a player who hit sign-in on `/board` lands back on
 * `/board`, and it is the one caller-controlled component of the redirect URL —
 * so it is the one that has to be airtight. `//evil.test` and `/\evil.test` are
 * protocol-relative: a browser reads both as a different ORIGIN, which is the
 * textbook open-redirect payload that a naive "must start with /" check waves
 * straight through. They are rejected explicitly AND caught again by resolving
 * the path against the target origin and requiring the result to stay there.
 */
export function validateReturnPath(raw: unknown, targetOrigin: string): string | null {
  if (raw === undefined || raw === null) return '/';
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_RETURN_PATH) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  // Control characters, including the CR/LF that would split a header if this
  // value were ever echoed into one.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  // The fragment is reserved for the code. A caller-supplied one would either be
  // silently overwritten or smuggle a second `#` into the URL.
  if (raw.includes('#')) return null;
  let resolved: URL;
  try {
    resolved = new URL(raw, targetOrigin);
  } catch {
    return null;
  }
  if (resolved.origin !== targetOrigin) return null;
  return `${resolved.pathname}${resolved.search}`;
}

// --- Code and transaction binding -----------------------------------------------

function defaultMintCode(): string {
  return randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url');
}

/** `authHandoffs/{sha256(code)}` — see the module note on hashing at rest. */
export function handoffPath(code: string): string {
  return `${HANDOFF_COLLECTION}/${createHash('sha256').update(code, 'utf8').digest('hex')}`;
}

/**
 * The public half of the transaction binding: `base64url(SHA-256(verifier))`,
 * exactly PKCE's S256 over the ASCII verifier. The Event origin computes this
 * with WebCrypto before it leaves for the central origin, publishes only this,
 * and keeps the verifier.
 */
export function transactionIdFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/** Length-guarded constant-time compare — `timingSafeEqual` throws on unequal
 *  lengths, so the guard has to come first (the `emailOptOut.ts` convention). */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Read a stored deadline as ms, or `null` if it is not readable as one.
 *
 * `'toMillis' in value` proves the KEY exists, not that it is callable — a
 * stored map `{ toMillis: 1 }` satisfies it and then throws `TypeError` on the
 * call. That exception would escape `exchangeHandoff` entirely, so the callable
 * would answer `INTERNAL` instead of the uniform rejection every other
 * malformed record gets, turning a data-shape defect into both a crash and a
 * break in the "every rejection looks identical" promise. Hence the explicit
 * callable check and the catch: EVERY unreadable expiry has to fail closed as
 * expired, not just the ones that fail politely.
 */
function readMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && value !== null && 'toMillis' in value) {
    const toMillis = (value as { toMillis: unknown }).toMillis;
    if (typeof toMillis !== 'function') return null;
    try {
      const ms = (toMillis as () => unknown).call(value);
      if (typeof ms === 'number' && Number.isFinite(ms)) return ms;
    } catch {
      return null;
    }
  }
  return null;
}

export interface HandoffRecordInput {
  uid: string;
  targetOrigin: string;
  transactionId: string;
  eventId: string | null;
  issuedAt: number;
  expiresAt: number;
  timestamp: (ms: number) => unknown;
}

/**
 * The stored document. Exported so a test can seed a real Firestore with exactly
 * what `mintHandoff` writes rather than a hand-copied approximation that drifts.
 *
 * `consumedAt: null` is written explicitly rather than left absent: the consume
 * check reads it, and "the field is missing" and "the field is null" being
 * different shapes is how a redemption check quietly stops checking.
 */
export function buildHandoffRecord(input: HandoffRecordInput): Record<string, unknown> {
  return {
    uid: input.uid,
    targetOrigin: input.targetOrigin,
    transactionId: input.transactionId,
    eventId: input.eventId,
    issuedAt: input.timestamp(input.issuedAt),
    // Also the field a Firestore TTL policy should be configured against, so an
    // abandoned sign-in does not leave a document behind for ever.
    expiresAt: input.timestamp(input.expiresAt),
    consumedAt: null,
  };
}

// --- Mint -----------------------------------------------------------------------

export interface MintInput {
  /** The VERIFIED uid from the callable's auth context. Never a payload field:
   *  a client-supplied uid would let any signed-in caller mint a code for
   *  somebody else, which is the takeover this whole design exists to prevent. */
  uid: string | undefined;
  targetOrigin: unknown;
  transactionId: unknown;
  returnPath?: unknown;
  /** Whether the transport verified an App Check token on this request. */
  appCheckPresent?: boolean;
}

export interface MintDeps {
  db: HandoffFirestore;
  now: () => number;
  timestamp: (ms: number) => unknown;
  policy: OriginPolicy;
  /** Injectable entropy so a test can pin a code. Defaults to 32 random bytes. */
  mintCode?: () => string;
  requireAppCheck?: boolean;
}

/**
 * Mint a handoff code for the authenticated caller.
 *
 * Minting is deliberately self-service and unconstrained beyond being signed in:
 * there is no check that the caller is at the central origin, because there is
 * nothing to protect against. A code binds to the CALLER'S OWN uid, so the only
 * thing an attacker can mint is a way to sign in as themselves.
 */
export async function mintHandoff(input: MintInput, deps: MintDeps): Promise<HandoffMintResult> {
  const uid = input.uid;
  if (typeof uid !== 'string' || uid.length === 0) return { ok: false, reason: 'unauthenticated' };
  if (deps.requireAppCheck && input.appCheckPresent !== true) {
    return { ok: false, reason: 'app-check-required' };
  }

  const target = await validateTargetOrigin(deps.db, input.targetOrigin, deps.policy);
  if (!target.ok) return { ok: false, reason: target.reason };

  if (typeof input.transactionId !== 'string' || !HANDOFF_TOKEN_PATTERN.test(input.transactionId)) {
    return { ok: false, reason: 'invalid-transaction-id' };
  }

  const returnPath = validateReturnPath(input.returnPath, target.origin);
  if (returnPath === null) return { ok: false, reason: 'invalid-return-path' };

  const code = (deps.mintCode ?? defaultMintCode)();
  const issuedAt = deps.now();
  const expiresAt = issuedAt + HANDOFF_TTL_MS;

  await deps.db.doc(handoffPath(code)).create(
    buildHandoffRecord({
      uid,
      targetOrigin: target.origin,
      transactionId: input.transactionId,
      eventId: target.eventId,
      issuedAt,
      expiresAt,
      timestamp: deps.timestamp,
    }),
  );

  return {
    ok: true,
    code,
    handoffUrl: `${target.origin}${returnPath}#${HANDOFF_FRAGMENT_KEY}=${code}`,
    targetOrigin: target.origin,
    expiresAt,
  };
}

// --- Exchange -------------------------------------------------------------------

export interface ExchangeInput {
  code: unknown;
  /** The private half of the transaction binding, held by the Event origin. */
  transactionVerifier: unknown;
  /** The caller's own `window.location.origin`. */
  origin: unknown;
  /** The transport's `Origin` header when it exposed one; `null` otherwise. */
  headerOrigin?: string | null;
  /** Whether the transport verified an App Check token on this request. */
  appCheckPresent?: boolean;
}

export interface ExchangeDeps {
  db: HandoffFirestore;
  now: () => number;
  timestamp: (ms: number) => unknown;
  createCustomToken: (uid: string) => Promise<string>;
  /** Whether the account may still sign in — false for deleted or disabled.
   *  Must fail closed on error. */
  isAccountUsable?: (uid: string) => Promise<boolean>;
  /**
   * Reject callers without a verified App Check token.
   *
   * THE abuse control for this endpoint, and the reason it needs one is
   * resource exhaustion rather than compromise: the code space is 2^256, so
   * guessing is infeasible, but every well-FORMED guess still costs a Firestore
   * transaction. An unauthenticated flood of syntactically valid codes can
   * therefore consume instances and database capacity and delay real sign-ins,
   * without ever being close to redeeming anything. App Check is what
   * distinguishes "our app" from "anyone with the URL"; a Firestore-backed
   * throttle would answer a database-load problem by adding a database write
   * per request.
   *
   * Off by default, like `BUG_REPORT_APP_CHECK`, because enforcing it before
   * the client attests would lock out the very flow it protects. Turning it on
   * is a launch prerequisite (specs/auth-handoff.md § Deployment).
   */
  requireAppCheck?: boolean;
}

/**
 * Redeem a code for a custom token, consuming it in the same transaction.
 *
 * ORDER MATTERS, and the order is: consume, then check the account, then mint
 * the token. Consumption commits BEFORE the token exists, so a failure after it
 * burns the code and costs the player one re-sign-in. That is the deliberate
 * trade: minting first and consuming after would open a window in which the same
 * code is redeemable twice, and a redundant sign-in is cheaper than a replay.
 */
export async function exchangeHandoff(
  input: ExchangeInput,
  deps: ExchangeDeps,
): Promise<HandoffExchangeResult> {
  // Attestation first, then shape — both before any Firestore read, so neither
  // an unattested caller nor a malformed code can be turned into read volume.
  if (deps.requireAppCheck && input.appCheckPresent !== true) {
    return { ok: false, reason: 'app-check-required' };
  }

  // A malformed code is rejected for free, so noise at this endpoint cannot be
  // turned into read volume.
  const code = typeof input.code === 'string' ? input.code : '';
  if (!HANDOFF_TOKEN_PATTERN.test(code)) return { ok: false, reason: 'invalid-code' };

  const verifier = typeof input.transactionVerifier === 'string' ? input.transactionVerifier : '';
  if (!HANDOFF_TOKEN_PATTERN.test(verifier)) return { ok: false, reason: 'invalid-verifier' };

  const caller = parseOrigin(input.origin);
  if (!caller) return { ok: false, reason: 'invalid-origin' };

  // The browser-enforced `Origin` header, when the transport gave us one. It is
  // corroboration, not the control: a non-browser client sets any value it
  // likes, which is exactly why the code and the verifier — not this header —
  // are what actually gate redemption. Checked anyway because for a real browser
  // it is unforgeable, and because a genuine misroute shows up here first.
  if (typeof input.headerOrigin === 'string' && input.headerOrigin !== caller.origin) {
    return { ok: false, reason: 'origin-mismatch' };
  }

  const expectedTransactionId = transactionIdFor(verifier);
  const ref = deps.db.doc(handoffPath(code));

  const consumed = await deps.db.runTransaction(
    async (
      tx,
    ): Promise<{ ok: true; uid: string } | { ok: false; reason: HandoffExchangeReason }> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, reason: 'unknown-code' };
      const data = snap.data() ?? {};

      // `consumedAt` must be PRESENT and exactly `null` to redeem. Absent is
      // NOT "unconsumed": a record that lost the field — an admin repair, a
      // migration, some future writer — would otherwise become redeemable
      // again by anyone still holding its code and verifier, which is a replay
      // through a data-shape accident rather than through this code path. The
      // module note and the spec both say missing and null are different
      // shapes; this pair of checks is what makes that true rather than merely
      // stated, and a loose `!= null` collapsed them back together.
      if (!('consumedAt' in data)) return { ok: false, reason: 'malformed-record' };
      if (data.consumedAt !== null) return { ok: false, reason: 'replayed' };

      const expiresAt = readMillis(data.expiresAt);
      // A record with no readable expiry is not treated as never-expiring — an
      // unreadable deadline is the one case where guessing favours the attacker.
      if (expiresAt === null || deps.now() >= expiresAt) return { ok: false, reason: 'expired' };

      if (typeof data.targetOrigin !== 'string' || data.targetOrigin !== caller.origin) {
        return { ok: false, reason: 'origin-mismatch' };
      }

      if (
        typeof data.transactionId !== 'string' ||
        !constantTimeEquals(data.transactionId, expectedTransactionId)
      ) {
        return { ok: false, reason: 'transaction-mismatch' };
      }

      const uid = typeof data.uid === 'string' ? data.uid : '';
      if (uid === '') return { ok: false, reason: 'unknown-code' };

      // The read above and this write are the single-use enforcement. Under
      // concurrent exchange Firestore aborts one transaction, re-runs this
      // callback, and the re-read returns `replayed` at the guard above.
      tx.update(ref, { consumedAt: deps.timestamp(deps.now()) });
      return { ok: true, uid };
    },
  );

  if (!consumed.ok) return consumed;

  if (deps.isAccountUsable && !(await deps.isAccountUsable(consumed.uid))) {
    return { ok: false, reason: 'account-unusable' };
  }

  return { ok: true, customToken: await deps.createCustomToken(consumed.uid), uid: consumed.uid };
}
