import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import {
  attestAdult,
  ensureUserProfile,
  hasCachedBoard,
  hasCachedCard,
  joinAndDeal,
  readAdultAttestationFromCache,
  readAdultAttestationFromServer,
} from '../data/api';
import { track } from '../analytics';
import { adultContentRequired } from '../adultContent';
import { useAdultContent } from '../hooks/useAdultContent';
import { firebaseAuthOriginRedirectUrl } from '../canonical-redirect';
import { consumePostUpdateDealGrace } from '../postUpdateDeal';
import SignIn from '../components/SignIn';
import ConfirmWinMoments from '../components/ConfirmWinMoments';
import RetractWinMoments from '../components/RetractWinMoments';
import PoolRecoveryWatcher from '../components/PoolRecoveryWatcher';
import AdultContentWatcher from '../components/AdultContentWatcher';

// Connectivity probe for the boot path (#115). The auth bootstrap and the deal
// are both network-bound: a create-once transaction (ensureUserProfile) and a
// create path (joinAndDeal) never resolve/complete offline, so they must not sit
// on the render-critical path. `navigator.onLine` is the cheap synchronous
// signal (a definite `false` means "no network"); a missing navigator (SSR /
// exotic runtime) is treated as online so the normal online path still runs.
function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

// Safari (and captive/ship Wi-Fi generally) can report navigator.onLine=true
// while a Firestore transaction or server-only read never settles. The online
// bootstrap is render-gating for the 18+ check, so an unbounded wait strands the
// whole app on its loading screen. Bound that gate and hand failures to the
// existing retry surface; never fall back to cached authority or render the Board.
export const AUTH_BOOTSTRAP_TIMEOUT_MS = 10_000;
// The deal (joinAndDeal) is a network-bound read+write that, unlike the bootstrap
// above, was previously UNBOUNDED (#403): on captive/ship Wi-Fi a hung getDoc or
// commit could keep `dealing` true with no fallback. Bound it so a stalled deal
// REJECTS (classified as a connection failure, never pool-shortfall) and the
// recovery in `runDeal` runs instead of spinning. Generous relative to the 10s
// bootstrap because the legacy join also runs the active-pool query + a batch
// commit; the goal is to distinguish a HUNG deal from a merely slow one, not to
// fail slow-but-working wifi (a false timeout for a returning Player is swallowed
// by the cache fallback anyway, and for a first-timer just re-arms the retry).
export const DEAL_TIMEOUT_MS = 20_000;
// Local auth persistence normally settles immediately; live mobile smoke showed
// the blocked custom-domain bootstrap never settled. Three seconds leaves ample
// room for a slow device without preserving an unbounded signed-out stall.
export const WEB_APP_AUTH_SETTLE_TIMEOUT_MS = 3_000;
export const PENDING_REDIRECT_ATTESTATION_KEY = 'gcb:pending-redirect-attestation';

// Mobile browser tabs sign in via one top-level redirect; everything else keeps
// the popup (see signIn()). The UA regex catches devices that say so outright.
// The second clause is the iPadOS desktop-UA masquerade (#347): iPadOS Safari
// reports `platform === 'MacIntel'` and a Mac UA string, and `maxTouchPoints > 1`
// is the accepted discriminator — real Macs report 0. KNOWN TRADEOFF: a future
// touch-enabled Mac would match and get redirect sign-in in a browser tab. That
// failure mode is benign — redirect sign-in is fully supported on desktop; the
// popup is only a preference where the window is stable — and installed PWAs are
// unaffected (the call site checks isStandaloneApp() separately). Revisit when a
// capability signal distinguishes iPadOS from a touch Mac (e.g. a UA-Client-Hints
// platform value Safari actually ships); no such signal exists today, and the
// alternatives (UA sniffing deeper, or dropping the clause and sending iPad
// Safari down the popup path it demonstrably loses state on) are strictly worse.
function prefersRedirectSignIn(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  );
}

function isStandaloneApp(): boolean {
  const iosStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

// Route sign-in through a single top-level redirect instead of a popup in the two
// environments where the popup is unreliable but the same-origin handler keeps
// redirect stable (the caller still gates this on `sameOriginHandler`):
//   1. Mobile browser tabs — Firebase's recommendation; the popup opens as a new
//      tab there, and iOS Safari loses the helper's sessionStorage across it.
//   2. Installed DESKTOP PWAs (Chrome/Edge "Install app") — the standalone window
//      has no address bar and silently blocks/never surfaces the OAuth popup, so
//      the Sign in tap appears to do nothing (#395).
// Installed iOS/Android PWAs deliberately stay on the popup: they report a mobile
// UA (prefersRedirectSignIn === true) AND run standalone, so NEITHER clause
// matches. On iOS the popup opens as a stable in-app view, while redirect drops
// the helper's sessionStorage across the provider round-trip — the iOS-standalone
// case the popup exception was built for. A desktop browser tab (non-mobile UA,
// not standalone) also matches neither clause and keeps the popup, which is
// reliable inside a normal tab.
function shouldRedirectSignIn(
  nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>,
  standalone: boolean,
): boolean {
  const isMobileBrowserTab = prefersRedirectSignIn(nav) && !standalone;
  const isDesktopInstalledApp = standalone && !prefersRedirectSignIn(nav);
  return isMobileBrowserTab || isDesktopInstalledApp;
}

function markPendingRedirectAttestation(): void {
  try {
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, String(Date.now()));
  } catch {
    // Firebase's redirect helper will report inaccessible sessionStorage itself.
  }
}

function consumePendingRedirectAttestation(): boolean {
  try {
    const pending = sessionStorage.getItem(PENDING_REDIRECT_ATTESTATION_KEY) !== null;
    sessionStorage.removeItem(PENDING_REDIRECT_ATTESTATION_KEY);
    return pending;
  } catch {
    return false;
  }
}

/**
 * Whether the 18+ acknowledgement was actually COLLECTED when a redirect
 * sign-in began (Phase 4b round 4).
 *
 * Separate from the marker above, in a different store, because the two answer
 * different questions and have different durability needs. The marker scopes
 * FAILURE reporting and may be lost — #346 exists precisely because Safari drops
 * sessionStorage across the provider round-trip, and that path still has to
 * complete. This record decides whether a durable, cross-Event
 * `attestedAdultAt` may be written, so losing it must not silently fabricate
 * one, and it must survive the round trip that loses the marker.
 *
 * `localStorage`, therefore: it survives the same partitioning that drops
 * sessionStorage — which is how Firebase restores the session at all — so #346's
 * guarantee (login AND attestation both land on a marker-less return) is kept
 * intact rather than traded away.
 *
 * TTL-bounded so an abandoned redirect cannot authorize an unrelated sign-in
 * days later. Anything unparseable, expired, or absent reads as NOT collected,
 * which costs one re-prompt — the direction this whole feature fails in.
 */
export const SIGNIN_ADULT_ACK_KEY = 'gcb.signin.adultAck';
const SIGNIN_ADULT_ACK_TTL_MS = 10 * 60 * 1000;

function markCollectedAcknowledgement(): void {
  try {
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, String(Date.now()));
  } catch {
    // Private mode / disabled storage: the re-prompt collects it instead.
  }
}

function clearCollectedAcknowledgement(): void {
  try {
    localStorage.removeItem(SIGNIN_ADULT_ACK_KEY);
  } catch {
    // Private mode / disabled storage already fails toward re-prompting.
  }
}

// Read WITHOUT consuming, TTL-checked (Codex P2 round 2 on #836 — the same
// class of bug as `peekRedirectPending`'s history below, for the same
// record). A mount that reads this before either redirect-completion signal
// has fired must not clear it: if this mount's getRedirectResult resolves
// null and reloads/crashes before onAuthStateChanged publishes the restored
// user, a NEXT mount's signal (b) still needs this to know the 18+ box was
// actually ticked — clearing it eagerly on read would silently drop a
// legitimately collected acknowledgement instead of persisting it once the
// redirect completes late. Cleared only in `completeRedirectReturn`
// (terminal success) or the redirect-result effect's `.catch()` (terminal
// failure) below.
function peekCollectedAcknowledgement(now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(SIGNIN_ADULT_ACK_KEY);
    const at = Number(raw);
    const age = now - at;
    // Both bounds matter (Codex P2 on #836): the upper bound is the TTL
    // itself, but without a LOWER bound too, a future-dated `at` (a backward
    // wall-clock adjustment, or a corrupted/tampered value) makes `age`
    // negative — trivially `<= TTL_MS` — so the record would read as live
    // indefinitely until the clock caught back up to it, rather than
    // expiring on schedule.
    return Number.isFinite(at) && at > 0 && age >= 0 && age <= SIGNIN_ADULT_ACK_TTL_MS;
  } catch {
    return false;
  }
}

// Read the marker WITHOUT consuming it. Evaluated during the first render —
// before any effect can subscribe to auth or arm the settle timer — so the
// pending-redirect-return guard (#357) is in place before either could fire;
// the redirect-result effect still consumes the marker exactly once.
function peekPendingRedirectAttestation(): boolean {
  try {
    return sessionStorage.getItem(PENDING_REDIRECT_ATTESTATION_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * A durable "redirect in flight" record, in the SAME store and under the SAME
 * TTL discipline as `SIGNIN_ADULT_ACK_KEY` above, and for the same reason
 * (#346): `localStorage` survives the storage-partitioning that can drop
 * `PENDING_REDIRECT_ATTESTATION_KEY`'s `sessionStorage` marker across the
 * Google round trip. `getRedirectResult` resolving non-null is normally proof
 * enough that a redirect returned — but Safari can restore the session (via
 * `onAuthStateChanged`) while the SAME round trip loses whatever helper state
 * `getRedirectResult` itself depends on, and a null result then would wrongly
 * read as "no redirect happened" rather than "a redirect happened and Safari
 * lost the receipt." This record is the second, independent signal the
 * redirect-return effect races against `getRedirectResult`: written at
 * redirect START (`signIn`, alongside `markCollectedAcknowledgement`) and
 * cleared only on a TERMINAL outcome for the transaction it tracks — either
 * completion signal succeeding, or a genuine getRedirectResult rejection
 * (see `completeRedirectReturn` and the redirect-result effect below) —
 * never merely because a mount READ it. A mount that reads it live but never
 * reaches a terminal outcome (e.g. it reloads before onAuthStateChanged
 * publishes the restored user) must leave it standing for the NEXT mount to
 * pick up; that durability across a reload is the entire reason this record
 * exists, so consuming it eagerly on read would defeat it (Codex P2 on #836).
 */
export const REDIRECT_PENDING_KEY = 'gcb.signin.redirectPending';
const REDIRECT_PENDING_TTL_MS = SIGNIN_ADULT_ACK_TTL_MS;

function markRedirectPending(): void {
  try {
    localStorage.setItem(REDIRECT_PENDING_KEY, String(Date.now()));
  } catch {
    // Private mode / disabled storage: only the getRedirectResult signal remains.
  }
}

function clearRedirectPending(): void {
  try {
    localStorage.removeItem(REDIRECT_PENDING_KEY);
  } catch {
    // no-op — nothing was durably recorded in the first place.
  }
}

// Read WITHOUT consuming, TTL-checked. Used both by the `redirectReturnPending`
// guard's mount-time initializer (#357) alongside the sessionStorage peek, so
// that guard also survives on the surface that loses the marker; and by
// `consumeRedirectContextOnce` below, which deliberately never clears this
// specific record on read (Codex P2 on #836) — see its own comment for why.
function peekRedirectPending(now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(REDIRECT_PENDING_KEY);
    const at = Number(raw);
    const age = now - at;
    // Both bounds matter (Codex P2 on #836): see `peekCollectedAcknowledgement`
    // above for why an upper bound alone (age <= TTL) is not enough — a
    // future-dated `at` makes `age` negative, trivially satisfying it, and
    // would leave this "10-minute" signal live indefinitely instead of
    // expiring on schedule.
    return Number.isFinite(at) && at > 0 && age >= 0 && age <= REDIRECT_PENDING_TTL_MS;
  } catch {
    return false;
  }
}

function trackSignInFailure(err: unknown): void {
  const rawCode = (err as { code?: unknown })?.code;
  const code = typeof rawCode === 'string' && /^auth\/[a-z0-9-]+$/.test(rawCode) ? rawCode : 'auth/unknown';
  track('login_failed', {
    method: 'google',
    code,
  });
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label = 'Auth bootstrap timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// Start the AUTHORITATIVE 18+ read for `u` and return the BOUNDED race, routing a
// result that lands AFTER the bound to `onLate`.
//
// The read itself is the pair every authority path runs: `ensureUserProfile`, then
// a SERVER-ONLY `readAdultAttestationFromServer` (getDocFromServer, NOT the
// cache-capable getDoc — a stamp served from cache must never authorize a deal). It
// REJECTS when the server is actually unreachable (a flaky reconnect where
// navigator.onLine is true but there is no route), so the caller's catch means
// authority NOT established: no deal, deferred to reconnect.
//
// LATE AUTHORITY (Codex P2 on #521): `withTimeout` rejects the RACE but cannot
// cancel the read, so a result landing after the bound used to be thrown away — the
// same limitation `runDeal`'s late-success net exists for. That was survivable while
// a timeout left `attested` UNKNOWN, but a failed read now leaves a PROVISIONAL
// cache lift of the render gate standing (#521), and nothing re-reads authority while
// `navigator.onLine` stays true (no connectivity event fires) — so a discarded late
// server-NULL would hold that lift up indefinitely instead of downgrading to the
// required re-prompt. `onLate` fires ONLY when the race did not deliver the result:
// on the in-time path this handler is registered before `withTimeout` races the same
// promise, so it runs first and sees `undelivered` still false.
//
// BOTH authority entry points go through here — `bootstrapUser`'s online branch and
// `retryBootstrap` — so a late read can never be honored on one and dropped on the
// other (Codex P2 on #728). Callers own the ATTEMPT guard inside `onLate`; the
// terminal-settle latch is not theirs to remember — each caller's settle function is
// itself idempotent, so first-settle-wins holds however the two reads interleave
// (Phase 4b P1 on #728).
//
// LATE REJECTION (Codex P2 on #762): a late SUCCESS is routed to `onLate`, but a
// late REJECTION used to be dropped on the floor. That is fine for a late
// 'connection'-class rejection — the in-time timeout already published that exact
// classification — but bootstrapUser's failure arm provisionally lifts the render
// gate from a cached stamp FOR THAT CLASS ONLY (#521), on the bet that the failure
// is transient. If the underlying read then rejects with a PERMANENT cause instead
// (permission-denied, schema, unknown-coded), the bet was wrong and nothing ever
// revoked the lift or corrected `dealErrorReason` — contradicting the invariant
// (enforced at every OTHER call site) that a permanent failure never stands behind
// a lifted render gate. `onLateError` gives BOTH callers a chokepoint to correct
// that: bootstrapUser wires one for its own in-time lift, and retryBootstrap wires
// one too (Codex P2 round 2 on #762) — retryBootstrap never lifts on its OWN
// failure, but it also never resets `attested` at its start, so a lift standing
// from an earlier bootstrapUser attempt can still be up when a retry's read later
// rejects late. Defaults to a no-op only for callers with no lift to ever correct.
function startAuthorityRead(
  u: User,
  onLate: (serverAttested: boolean) => void,
  onLateError: (err: unknown) => void = () => {},
): Promise<boolean> {
  const authority = (async () => {
    await ensureUserProfile(u);
    return (await readAdultAttestationFromServer(u.uid)) !== null;
  })();
  let undelivered = false;
  void authority.then(
    (late) => {
      if (undelivered) onLate(late);
    },
    (err: unknown) => {
      if (undelivered) onLateError(err);
    },
  );
  return withTimeout(authority, AUTH_BOOTSTRAP_TIMEOUT_MS).catch((err: unknown) => {
    undelivered = true;
    throw err;
  });
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  // False from the moment a signed-in User is published until THAT User's
  // ensureUserProfile bootstrap settles (#77). Unlike `loading` — which covers
  // only the first auth callback — it re-arms on every auth change (popup
  // sign-in, account switch), so a profile-writing consumer can gate on it and
  // never act on `user` before the users/{uid} bootstrap has settled.
  profileReady: boolean;
  // True when a signed-in User's SETTLED profile lacks the honor-system 18+
  // attestation (ADR 0001), so the re-prompt gate stands before the Board (#23).
  // Never true mid-bootstrap: it is gated on profileReady, so an attestation that
  // is still UNKNOWN during load can't flash the prompt.
  needsAttestation: boolean;
  // True only after this session has proof that Event content may render:
  // a cached offline stamp, a server-confirmed stamp, or a same-session attest.
  // Consumers that bypass Board's normal render path (the durable card fallback)
  // must check this instead of inferring permission from a saved snapshot.
  canRenderEventContent: boolean;
  // Player-worded, retryable failure on the path to a dealt Board — a failed
  // join/deal, or a failed attestation bootstrap (#112 round 2) — null once dealt.
  dealError: string | null;
  // Why `dealError` is set — the typed marker the pool-recovery auto-retry (#70)
  // arms on. Set in lockstep with `dealError`; null whenever `dealError` is null, so
  // a stale reason can never arm the watcher after the error clears.
  dealErrorReason: DealErrorReason | null;
  // True while a join/deal (initial or retry) or the bootstrap retry that
  // precedes a deferred deal is in flight.
  dealing: boolean;
  // Reserved for auth startup readiness; current host selection is synchronous.
  signInReady: boolean;
  signIn: (acknowledgedAdultContent: boolean) => Promise<void>;
  signOutUser: () => Promise<void>;
  // Persist the current User's 18+ self-attestation (ADR 0001) and lift the gate.
  attest: () => Promise<void>;
  // Retry the current User's path to a dealt Board in place (no reload): re-runs
  // joinAndDeal when the attestation is settled true, else re-attempts the FAILED
  // ensureUserProfile + readAdultAttestation bootstrap (#112 round 2) — never the
  // deal itself while the attestation is unsettled (Finding 1).
  retryDeal: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  profileReady: false,
  needsAttestation: false,
  canRenderEventContent: false,
  dealError: null,
  dealErrorReason: null,
  dealing: false,
  signInReady: true,
  signIn: async () => {},
  signOutUser: async () => {},
  attest: async () => {},
  retryDeal: () => {},
});

// A pool-shortfall deal failure (the ADR 0003/0004 below-floor guard) vs any other
// deal/bootstrap failure. `joinAndDeal` → `dealBoard` throws "…24 prompts…" when the
// FILTERED active pool is under MIN_POOL; every other deal or bootstrap rejection is a
// connectivity/permission failure. This is the TYPED discriminator the pool-recovery
// auto-retry (#70) arms on: only a pool-shortfall is fixable by adding Prompts, so only
// it should watch the pool for recovery — a connection error must never arm the watcher.
// Kept as the SINGLE classifier `dealErrorMessage` and the reason marker both read, so
// the Player-worded copy and the typed reason can never disagree about the cause.
function isPoolShortfall(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /\b24 prompts\b/.test(raw);
}

// Only known transient deal failures are swallow-eligible behind an actual
// cached card. Unknown coded Firestore/Firebase errors and generic programming
// exceptions surface, so the cached-card fallback cannot hide permanent or
// unclassified failures indefinitely (CodeRabbit #408). Uncoded ship-wifi
// failures and our own `withTimeout` rejection are still allowed explicitly:
// those are the connection blips #403 exists to preserve a cached card through.
const TRANSIENT_DEAL_ERROR_CODES = new Set([
  'aborted',
  'auth/network-request-failed',
  'cancelled',
  'deadline-exceeded',
  'resource-exhausted',
  'unavailable',
]);
const TRANSIENT_UNCODED_DEAL_ERROR = /\b(deal timed out|timed? out|timeout|network|offline|failed to fetch)\b/i;
function isTransientDealError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') return TRANSIENT_DEAL_ERROR_CODES.has(code);
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_UNCODED_DEAL_ERROR.test(message);
}

// Player-facing copy for a deal failure. The main case (ADR 0003/0004) is
// `dealBoard` throwing when the active non-free pool is below the 24 a Board needs.
function dealErrorMessage(err: unknown): string {
  if (isPoolShortfall(err)) {
    return "We couldn't deal your card yet—the prompt pool is below the 24 a card needs. Ask an admin to add a few prompts, then retry.";
  }
  return "We couldn't deal your bingo card. Check your connection and retry.";
}

// Why the current `dealError` happened — the TYPED marker the pool-recovery auto-retry
// (#70) arms on, so the watcher never keys off the Player-worded string. 'pool-shortfall'
// is the ADR 0003/0004 below-floor guard (fixable by adding Prompts → worth watching the
// pool); 'connection' is a TRANSIENT connectivity/timeout blip (the class the #434
// cached-card fallback renders a saved card for, and the class #403's swallow retries
// behind a Firestore-cached board); 'permanent' is a rules/schema/permission or
// unknown-coded failure that reconnecting cannot fix — it always surfaces the error,
// never a cached card. Non-null exactly when `dealError` is non-null (set/cleared in
// lockstep — see `failDeal`/`clearDealError`).
export type DealErrorReason = 'pool-shortfall' | 'connection' | 'permanent';

// The SINGLE classification of a deal/bootstrap failure. Every consumer that has
// to decide "may cached state stand in for this failure?" reads THIS, so the
// answer cannot differ between them: `failDeal` publishes it as `dealErrorReason`
// (which App gates the #434 durable-card fallback on), `bootstrapUser`'s failure
// arm gates its provisional cache lift of the RENDER gate on it (#521), and
// `claimPostUpdateGrace` below gates the #519 silent repeat on it. A permanent
// rules/schema/permission or unknown-coded failure is deliberately NOT
// 'connection': reconnecting cannot fix it, so it must surface the error rather
// than let cached state paper over it — the same refusal #403's swallow and the
// #434 fallback already make.
function dealErrorReasonFor(err: unknown): DealErrorReason {
  return isPoolShortfall(err) ? 'pool-shortfall' : isTransientDealError(err) ? 'connection' : 'permanent';
}

// The single gate on the #519 post-update grace, consulted by BOTH halves of the
// startup race an update reload can lose: the profile/attestation bootstrap
// (`bootstrapUser`) and the deal itself (`runDeal`). Whichever fails first claims
// it, and claiming SPENDS it — one silent repeat per document, never a loop, and
// never two. The other two terms are what keep it from masking a real failure: a
// definitely-offline Player is excluded, so genuine no-connectivity reaches the
// retry surface on the first failure rather than after a second doomed attempt;
// and only a 'connection'-class failure is repeated, so a pool-shortfall keeps
// its own copy and its own #70 recovery while a PERMANENT Firestore failure
// (permission-denied / failed-precondition / unknown-coded) surfaces at once.
// That class test reads the SHARED `dealErrorReasonFor` — the same classifier
// `failDeal` publishes and the #521 cache lift gates on — so "worth repeating"
// and "worth showing cached state for" can never drift apart. The consume is LAST
// in the chain on purpose — the grace must never be spent by a failure it would
// not have covered.
function claimPostUpdateGrace(err: unknown): boolean {
  return isOnline() && dealErrorReasonFor(err) === 'connection' && consumePostUpdateDealGrace();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [dealError, setDealError] = useState<string | null>(null);
  // The typed cause of `dealError` (#70), mirrored into context so the pool-recovery
  // watcher arms on the reason, never the Player-worded copy. Maintained ONLY through
  // `failDeal`/`clearDealError` below so it can never drift out of lockstep with the
  // message: every deal/bootstrap failure sets both, every clear clears both.
  const [dealErrorReason, setDealErrorReason] = useState<DealErrorReason | null>(null);
  const [dealing, setDealing] = useState(false);
  // False from the moment a signed-in User is published until THAT User's
  // ensureUserProfile bootstrap settles (#77) — see the interface note.
  const [profileReady, setProfileReady] = useState(false);
  // Tri-state 18+ attestation for the current User (#23): `undefined` = UNKNOWN
  // (bootstrap unsettled, or an indeterminate read); `true` = attested; `false` =
  // a SETTLED profile with no stamp → re-prompt. A missing stamp during load is
  // UNKNOWN, not absent — the knownFirstBingoAt tri-state discipline — so it never
  // flashes the gate.
  const [attested, setAttested] = useState<boolean | undefined>(undefined);
  // Reactive connectivity, mirrored from the browser online/offline events (#115).
  // A REACT STATE (not just the imperative `isOnline()` probe) so the deal effect's
  // deps actually CHANGE on reconnect: a globally-attested User who cold-boots
  // offline onto a FRESH Event (no cached board) settles `attested === true` from
  // cache but must not deal until online — and the deferred deal has to FIRE on
  // reconnect, which only happens if `online` flipping true re-runs that effect.
  const [online, setOnline] = useState(isOnline());
  const signInAttemptRef = useRef<Promise<void> | null>(null);
  const redirectResultHandledRef = useRef(false);
  // Whether onAuthStateChanged has ever fired for this mount — see its own
  // check-and-clear site (Phase 4b P1 on #836) for why signal (b) is scoped
  // to it: an unrelated same-origin tab's sign-in also publishes through
  // every other open tab's listener, since Firebase Auth persistence is
  // origin-wide, not tab-scoped.
  const firstAuthSettleRef = useRef(true);
  const webAppHandoffStartedRef = useRef(false);
  // Whether THIS document lives on a fallback origin — a hostname property,
  // immutable for the document's lifetime — snapshotted once for the cheap
  // gating decisions (the settle-timer arm and the sign-in tap branch, #358).
  // The DECISION is the only thing snapshotted: the navigated-to URL is not
  // (#376) — a signed-in web.app session can change route/query/hash before a
  // mid-session sign-out hands off, so the chokepoint recomputes the full
  // target from the live location at navigation time, preserving the active
  // route instead of replaying the mount-time one.
  const [onFallbackAuthOrigin] = useState(() => firebaseAuthOriginRedirectUrl(window.location) !== null);
  // An app-owned redirect sign-in return is completing on THIS origin (#357):
  // the same-origin marker was present at mount and getRedirectResult has not
  // settled yet. While true, no signed-out handoff may navigate — a cross-origin
  // replace() mid-completion would abandon the returning sign-in. Unreachable
  // under current invariants (sign-in never initiates from a fallback origin,
  // and the marker is same-origin state), so this is a guard against a future
  // regression, pinned by tests. STATE so the settle-timer effect re-arms when
  // the return settles; REF so the stable handoff callback can read it without
  // re-identifying (which would churn the onAuthStateChanged subscription).
  //
  // Peeks BOTH the sessionStorage marker AND the durable localStorage record
  // (#346 hardening): the marker can be lost across the exact round trip this
  // guard exists to protect, so checking only it would let the guard itself
  // drop on the surface it matters most for.
  const [redirectReturnPending, setRedirectReturnPending] = useState(
    () => peekPendingRedirectAttestation() || peekRedirectPending(),
  );
  const redirectReturnPendingRef = useRef(redirectReturnPending);
  // Whether `attested === true` is AUTHORITATIVE (server-settled or a same-session
  // optimistic attest) vs merely PROVISIONAL (the offline cache lift). Distinct
  // from `attested` so the offline cache lift can settle the gate for RENDER —
  // the cached Board paints offline (#115) — while the network-write DEAL waits
  // for authority (Codex #117 finding, round 2). A cache-attested User who
  // cold-boots offline onto a fresh Event holds `attested === true` provisionally;
  // on reconnect `online` flips true BEFORE the authoritative read finishes, so
  // gating the deal on `online` alone would let joinAndDeal create board/player
  // rows for a User whose server read may then return NO stamp and downgrade to a
  // re-prompt — creating durable rows for an un-attested User. This flag holds the
  // deal until the authoritative read confirms the stamp. Re-armed false per auth
  // change; never set true offline (the cache lift is provisional).
  const [attestedAuthoritative, setAttestedAuthoritative] = useState(false);
  // Whether the online bootstrap SUCCEEDED, as distinct from having SETTLED
  // (Codex P2 on #615). `profileReady` is true after a bootstrap FAILURE too —
  // that is its contract, and every consumer that renders on it is right to.
  // But on an Event with no age gate it is also the only remaining deal
  // authority, and a failed `ensureUserProfile` must not license creating
  // board/player rows any more than a missing attestation stamp does. So the
  // deal reads THIS, which is the direct analogue of `attestedAuthoritative`:
  // set only where the authoritative read actually landed, re-armed false on
  // every auth change and every connectivity flip.
  const [profileBootstrapOk, setProfileBootstrapOk] = useState(false);
  // The 18+ posture as REACTIVE state (Phase 4b P1). The callbacks below keep
  // reading `adultContentRequired()` directly — they run outside render and
  // want the value at call time — but every DERIVED gate in this provider
  // (`needsAttestation`, `mayDeal`, `canRenderEventContent`) has to recompute
  // when the Event turns adult under an open tab, and only a subscription
  // makes that happen.
  const attestationRequired = useAdultContent();
  // A ref mirror of `attestedAuthoritative` so async code (attest()'s catch) can
  // read the LATEST value without a stale closure (Codex #117 round 9, finding B):
  // the attest-failure rollback must NOT downgrade a User the bootstrap already
  // SERVER-CONFIRMED as attested. Synced from state below.
  const attestedAuthoritativeRef = useRef(false);
  useEffect(() => {
    attestedAuthoritativeRef.current = attestedAuthoritative;
  }, [attestedAuthoritative]);
  // Monotonic id of the latest deal attempt; runDeal captures it and re-checks
  // before each setState so a superseded attempt's late result is dropped (P2).
  const dealAttemptRef = useRef(0);
  // The CURRENT signed-in uid, mirrored from the auth listener for non-render
  // closures (#409): runDeal's join_event net must attribute a late-winning
  // join to the session that actually performed it — never to whoever happens
  // to be signed in when a superseded attempt finally resolves.
  const authUidRef = useRef<string | null>(null);
  // Monotonic id of the latest auth change, captured before the awaited
  // ensureUserProfile so a retired account's slower bootstrap can't flip
  // profileReady true for the account that already replaced it. A SEPARATE ref
  // from dealAttemptRef on purpose: runDeal bumps dealAttemptRef mid-sign-in,
  // which must not read as the profile bootstrap being superseded.
  const profileAttemptRef = useRef(0);
  // TWO-TIER same-session attestation (Codex #117 round 7): keep the OPTIMISTIC-UI
  // tier and the DURABLE-AUTHORITY tier strictly separate — optimistic-for-UI is
  // NOT authoritative-for-writes.
  //
  // (1) OPTIMISTIC-UI (`attestedUidsRef`, #23 Finding 3): a uid `attest()` was
  // CALLED for THIS session. `attest()` flips `attested` true optimistically before
  // the write resolves, and the auth callback re-arms `attested` to UNKNOWN then
  // re-settles it from a fresh server read — so a uid recorded here is never settled
  // back to `false` (no re-prompt flicker on a not-yet-visible write). UI ONLY: it
  // suppresses the re-prompt and lifts the offline render; it does NOT grant deal
  // authority.
  const attestedUidsRef = useRef<Set<string>>(new Set());
  // (2) DURABLE-AUTHORITY (`attestCommittedUidsRef`): a uid whose `attestAdult`
  // transaction actually COMMITTED this session. Only THIS grants deal authority
  // (`attestedAuthoritative`) for a same-session attest — a durable
  // `users/{uid}.attestedAdultAt` now exists, so a deal may create board/player
  // rows. If the attest write rejects or never resolves (offline/permission), the
  // uid stays out of this set: the UI is optimistically attested but NO deal fires,
  // so no rows are created for a User whose durable stamp does not exist.
  const attestCommittedUidsRef = useRef<Set<string>>(new Set());

  // THE signed-out handoff chokepoint: every cross-origin move to the canonical
  // auth origin — the auth-settled-signed-out branch, the bounded settle timer,
  // and the sign-in tap fallback — routes through here, so the started-once
  // dedupe and the pending-redirect-return guard apply to every navigation path
  // (#354: a raw replace() beside this ref could fire a duplicate/late
  // navigation). The target URL is computed HERE, from the live location at
  // navigation time (#376): a mid-session sign-out fires from wherever the
  // signed-in session navigated, so a mount-time snapshot would replay a stale
  // route/query/hash. Returns true when the signed-out visit is handled by
  // navigation (started now or earlier); false when this origin is already
  // canonical, or while an app-owned redirect return is completing (#357) — the
  // caller then renders normally and the settle timer re-arms on settlement.
  const handoffSignedOutWebApp = useCallback((): boolean => {
    if (redirectReturnPendingRef.current) return false;
    if (webAppHandoffStartedRef.current) return true;
    const target = firebaseAuthOriginRedirectUrl(window.location);
    if (!target) return false;
    webAppHandoffStartedRef.current = true;
    window.location.replace(target);
    return true;
  }, []);

  // Firebase should restore a cached User without the network. If a web.app
  // build instead stalls against the blocked custom auth domain, bound that
  // signed-out online boot and move to the stable same-project app origin.
  // Not armed while an app-owned redirect return is completing (#357); the
  // pending flag flipping false re-runs this effect, so the bound re-arms
  // rather than silently dying with the suppressed one-shot timer. There is
  // deliberately no settled-vs-loading guard (Codex P2 on the #357 round):
  // a signed-out settle DURING the pending window suppresses the immediate
  // handoff and renders SignIn, so the re-armed bound must also cover the
  // already-settled signed-out session — otherwise it would sit on web.app
  // indefinitely. On every path that already navigated, the chokepoint's
  // started-once ref makes the re-armed timer's fire a no-op.
  useEffect(() => {
    if (user || !online || !onFallbackAuthOrigin || redirectReturnPending) return;
    const timer = setTimeout(() => {
      if (online && isOnline() && !auth.currentUser) handoffSignedOutWebApp();
    }, WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [handoffSignedOutWebApp, onFallbackAuthOrigin, online, redirectReturnPending, user]);

  // Set / clear `dealError` and its typed reason in LOCKSTEP (#70). Every deal or
  // bootstrap failure routes through `failDeal` (which classifies pool-shortfall vs
  // connection vs permanent via the single `isPoolShortfall`/`isTransientDealError`
  // pair) and every clear through `clearDealError`, so the reason can never drift
  // from the message — the pool-recovery watcher arms on the reason, so a
  // stale/desynced reason would arm (or silently fail to arm) it wrongly. Stable
  // identities (`[]` deps: they touch only stable state setters + module-scope
  // classifiers), so wiring them into the deal/bootstrap callbacks' deps below does
  // not change those callbacks' identity — no #117 effect re-runs.
  const failDeal = useCallback((err: unknown) => {
    setDealError(dealErrorMessage(err));
    // Three-way (#434, Codex #438), via the shared `dealErrorReasonFor` so this
    // publication and every other consumer of the classification agree by
    // construction: a PERMANENT rules/schema/permission or unknown-coded failure
    // is NOT 'connection' — reconnecting cannot fix it, so it must always surface
    // the error rather than let App swap in a cached card. Mirrors the #403
    // swallow, which likewise refuses to hide a permanent failure behind a
    // Firestore-cached board.
    setDealErrorReason(dealErrorReasonFor(err));
  }, []);
  const clearDealError = useCallback(() => {
    setDealError(null);
    setDealErrorReason(null);
  }, []);

  // The connectivity-aware profile/attestation bootstrap, run OFF the render path
  // (#115). The cache lifts the gate PROVISIONALLY offline; the server read is
  // AUTHORITATIVE when it arrives. Two mutually-exclusive branches:
  //
  //   OFFLINE — settle the 18+ gate CACHE-FIRST, no network, then DEFER the rest.
  //     A cached stamp (or a same-session optimistic attest, #112 Finding 3) is
  //     PROOF of 18+: it lifts the gate AND releases the "Loading…" hold so a
  //     returning User renders their cached Board offline (the #115 cold-boot). A
  //     cache miss or a definite-unstamped row is UNKNOWN: it never lifts `true`
  //     (cache-first can't fail the age gate open) and it does NOT render — it
  //     HOLDS on "Loading…" (finding B) until reconnect settles the authoritative
  //     read, because offline can't re-prompt (the attest transaction needs the
  //     network). ensureUserProfile (a transaction that never resolves offline —
  //     transactions don't queue) and the authoritative read are deferred to the
  //     reconnect handler. OFFLINE is a non-error DEFERRED state, distinct from the
  //     DealError terminal (#112).
  //
  //   ONLINE — run the AUTHORITATIVE bootstrap; the session stays GATED on
  //     "Loading…" (the auth callback kept `loading` true for this branch) until
  //     it settles, so an un-attested returning User with a cached board can NOT
  //     view the Event during the read (Codex #117 finding B). The server read is
  //     definitive: it settles a present stamp true and a MISSING stamp false —
  //     DOWNGRADING even a provisional cache lift (finding D) — so a deleted /
  //     recreated users/{uid} row re-prompts. The only sticky override is
  //     attestedUidsRef (this session's own optimistic attest, #112 Finding 3),
  //     NOT a stale cache value. A genuine network FAILURE (thrown despite
  //     navigator.onLine) is not authoritative: it surfaces the retryable
  //     dealError (#61 / #112 round 2) and leaves attestation as-is.
  //
  // Every settle is guarded by `attempt` vs `profileAttemptRef` so a superseded
  // auth change / reconnect leaves the signal to whoever owns it now — the deal's
  // stale-attempt discipline, and what makes reconnect recovery deterministic.
  const bootstrapUser = useCallback(async (u: User, attempt: number) => {
    if (!isOnline()) {
      // NO AGE GATE ON THIS EVENT (#608) — there is nothing to prove offline, so
      // there is nothing to hold for. The whole cache-first dance below exists to
      // avoid rendering the Board without proof-of-18+; an Event whose pool holds
      // no adult content never asked for that proof, so holding "Loading…" until
      // reconnect would strand an offline Player on a spinner over a question
      // nobody posed. Released BEFORE the IndexedDB read, which would only ever
      // answer about a stamp this Event does not want.
      if (!adultContentRequired()) {
        if (profileAttemptRef.current !== attempt) return;
        setLoading(false);
        clearDealError();
        return;
      }
      // OFFLINE: settle the gate CACHE-FIRST and RELEASE the render only with
      // PROOF of 18+ (finding B). A cached stamp — or a same-session optimistic
      // attest (#112 Finding 3) — provisionally lifts the gate and paints the
      // cached Board (that is the #115 offline cold-boot). But a cache MISS or an
      // unstamped row is UNKNOWN: it must NOT render the Board (that would let a
      // returning User with a cached board but no proof-of-18+ view the Event
      // offline — the fail-open the age gate exists to prevent), so it HOLDS on
      // the App "Loading…" gate until reconnect settles the authoritative read
      // (then Board or re-prompt). Offline can never re-prompt (the attest
      // transaction needs the network), so held-Loading is the offline-unknown
      // state. It only ever LIFTS to true, never downgrades (that is the online
      // read's job), and never re-arms loading true here (a prior online settle's
      // Board/re-prompt stands until the authoritative read supersedes it).
      let hasCacheStamp = false;
      try {
        hasCacheStamp = (await readAdultAttestationFromCache(u.uid)) !== null;
      } catch {
        /* cache miss / indeterminate — UNKNOWN unless a same-session attest proves it */
      }
      if (profileAttemptRef.current !== attempt) return;
      if (hasCacheStamp || attestedUidsRef.current.has(u.uid)) {
        setAttested(true);
        setLoading(false); // proof of 18+ → render the cached Board offline
        // A successful cache-first settle SUPERSEDES a stale online dealError
        // (Codex #117 round 4, finding B): App renders DealError instead of the
        // Board whenever dealError is non-null, so a prior online failure would
        // otherwise strand this proven-18+ User on the error panel instead of the
        // cached Board this branch is meant to render.
        clearDealError();
      }
      // else UNKNOWN → hold on "Loading…" (do NOT release), never render un-proven.
      // A stale dealError left set here keeps the retry surface RETRYABLE offline
      // (there is nothing to render without proof-of-18+) — reconnect resolves it.
      return;
    }

    // ONLINE: the authoritative bootstrap. No provisional cache lift here — the
    // definitive server read is moments away and the app stays gated until it
    // lands, so lifting from cache first would only risk a premature deal.
    // THE authoritative settle — the one place a server-established stamp (or its
    // definite absence) is applied, so "the authoritative read always wins when it
    // lands" holds whether it beats AUTH_BOOTSTRAP_TIMEOUT_MS or arrives after it.
    // `authorityApplied` latches it for THIS attempt: the provisional cache lift in
    // the failure arm below is fired-and-forgotten, so without the latch a cache
    // read that resolves a few ms AFTER a late server-NULL would re-lift the gate
    // the downgrade just closed — the same stale-provisional-over-authority bug one
    // level down. Authority is terminal for the attempt; only a NEW attempt (auth
    // change, connectivity flip, retry) may settle it again.
    //
    // THE INVARIANT, ENFORCED HERE RATHER THAN AT EACH CALL SITE (Phase 4b P1 on
    // #728): the FIRST settle wins. `settleAuthoritative` is IDEMPOTENT — a second
    // call for the same attempt is a no-op — because the callers cannot be trusted
    // to remember the latch, and the cost of forgetting it is the 18+ gate failing
    // OPEN. That is not hypothetical: the #519 grace repeat and the #521 late-
    // authority handler are individually correct but jointly create a window where
    // ONE attempt settles twice. The orphaned first read lands through `onLate`
    // mid-repeat and settles terminally; then the repeat RESOLVES, and an
    // unguarded in-time settle below would apply its result over the top —
    // replacing a terminal server-NULL with a stamp that authorizes and deals, or
    // a terminal stamp with a NULL. The failure arm already carried a
    // `bootstrapFailure && authorityApplied` guard for the repeat-FAILS direction;
    // its sibling (repeat-SUCCEEDS) had none. Latching at the source closes both
    // and every future one.
    let authorityApplied = false;
    // Snapshot of the deal generation as of THIS bootstrap attempt (Codex P2 on
    // #761): a late authority result can land after a COMMITTED same-session
    // attest has already granted authority and fired `runDeal` (the `mayDeal`
    // effect does not wait for this read). If that deal then fails before this
    // read's late answer arrives, an unconditional clear below would erase the
    // NEWER, more relevant pool/connection/permanent error and nothing would
    // necessarily retry the failed deal. `dealAttemptRef` is the same monotonic
    // generation `runDeal` bumps on every attempt (see its own guards below), so
    // comparing against this snapshot tells the clear whether it still owns the
    // current `dealError` or whether a later deal attempt has taken over.
    const dealAttemptAtBootstrap = dealAttemptRef.current;
    // A SEPARATE latch from `authorityApplied` (Codex P2 round 3 on #762): the
    // permanent-rejection correction below must retire the failure arm's
    // fire-and-forget cache lift, but it must NOT consume the authoritative-
    // settle latch — the read that just rejected can be the ORPHANED original
    // from a #519 grace repeat, with the repeat's own read still pending. If
    // the correction set `authorityApplied` itself, a repeat that then lands a
    // genuine, more current server answer would find authority already
    // "settled" and drop it on the floor — silently stranding the permanent
    // error and failed bootstrap state even though a definitive, later answer
    // arrived. This flag only ever gates the cache lift.
    let provisionalLiftRetired = false;
    // A THIRD, independent latch (Codex P2 round 4 on #762): confirming a
    // PERMANENT failure must outrank any WEAKER failure that resolves after
    // it, without outranking a genuine SUCCESS. `authorityApplied` can't do
    // this alone — it stays false on purpose so a #519 grace repeat's real
    // answer can still settle (round 3) — but that same openness lets the
    // repeat's OWN mere TIMEOUT (not an answer, a non-conclusive failure)
    // reach the in-time failure arm below and downgrade `dealErrorReason`
    // from the confirmed 'permanent' back to 'connection', masking the real
    // failure behind transient-error handling. This flag is checked ONLY in
    // that failure arm — never in `settleAuthoritative`, so a later
    // authoritative success is still free to clear everything, exactly as
    // round 3 established.
    let permanentFailureConfirmed = false;
    const settleAuthoritative = (serverAttested: boolean) => {
      if (authorityApplied) return;
      authorityApplied = true;
      // UI: the server stamp, or an optimistic attest (don't re-prompt on a
      // not-yet-visible write). AUTHORITY: the server stamp, or a COMMITTED
      // same-session attest — NEVER an optimistic pre-commit lift (round 7). A
      // definite server-null with no attest downgrades to a re-prompt (finding D),
      // including one that downgrades the #521 provisional cache lift below.
      setAttested(serverAttested || attestedUidsRef.current.has(u.uid));
      if (serverAttested || attestCommittedUidsRef.current.has(u.uid)) setAttestedAuthoritative(true);
      // An authoritative settle SUPERSEDES any stale dealError (round 4 audit): on
      // reconnect this clears an error left by a prior offline/failed attempt so the
      // Board (or re-prompt) renders, not the stale panel. A confirmed-attested User
      // then deals, and a genuine re-deal failure re-sets dealError from runDeal.
      // Guarded on the deal generation (Codex P2 on #761): only clear while this
      // bootstrap still owns the error — a deal attempt that started AFTER this
      // read began owns whatever error it sets, and this late settle must not
      // erase it.
      if (dealAttemptRef.current === dealAttemptAtBootstrap) clearDealError();
      // The authoritative read landed — the deal may proceed on an Event that
      // asks for no attestation. Set ONLY here, never in the failure arm below.
      setProfileBootstrapOk(true);
    };
    // Named, so the #519 grace below can repeat it VERBATIM — which is what makes
    // the repeat the same work the Player's Retry would run (`retryBootstrap`
    // re-runs this identical pair). Each call starts its OWN read, and each read
    // wires its own late result back through `settleAuthoritative` (see
    // `startAuthorityRead`) — so the grace repeat cannot orphan the first read's
    // answer, and the settle's own first-wins latch keeps whichever lands first
    // terminal rather than letting the two overwrite each other. Only the ATTEMPT
    // guard is the caller's job here (a settle belonging to a superseded attempt
    // must not touch current state at all); terminality is the settle's.
    const readAuthority = () =>
      startAuthorityRead(
        u,
        (late) => {
          if (profileAttemptRef.current === attempt) settleAuthoritative(late);
        },
        (err) => {
          // A late REJECTION of a read that already timed out in-time (Codex P2
          // on #762). The in-time failure arm below classifies THAT synthetic
          // timeout as 'connection' and, for that class only, provisionally
          // lifts `attested` from a cached stamp (#521) on the bet that the
          // failure is transient. If the underlying read then rejects with a
          // PERMANENT cause instead, the bet was wrong: correct the reason and
          // revoke the lift, same as the invariant enforced at the in-time
          // failure site. Skip if authority already settled for this attempt
          // (terminal, same latch `settleAuthoritative` enforces) or if a NEWER
          // deal attempt has taken over the error (Codex P2 on #761 — the same
          // generation guard `settleAuthoritative` uses above).
          if (profileAttemptRef.current !== attempt) return;
          if (authorityApplied) return;
          if (dealAttemptRef.current !== dealAttemptAtBootstrap) return;
          if (dealErrorReasonFor(err) !== 'permanent') return;
          // RETIRE THE LIFT, NOT AUTHORITY (Codex P2 round 3 on #762): this
          // rejection belongs to a read that ALREADY lost the in-time race — it
          // can be the ORPHANED original from a #519 grace repeat, with the
          // repeat's own fresh read still in flight. Setting `authorityApplied`
          // here (round-2's fix) would consume the SAME latch `settleAuthoritative`
          // checks, silently dropping the repeat's later, more current server
          // answer on the floor. `provisionalLiftRetired` only closes the
          // fire-and-forget cache lift below, which — unguarded — would
          // otherwise re-lift `attested` (and `canRenderEventContent`) right
          // back to true behind a confirmed-permanent failure once its own read
          // resolves.
          provisionalLiftRetired = true;
          // Also latch the PERMANENT confirmation itself (Codex P2 round 4 on
          // #762): if a #519 grace repeat is what's in flight, its own read
          // can still time out (a non-conclusive failure, not an answer) and
          // reach the in-time failure arm below — which must not be allowed
          // to downgrade this confirmed 'permanent' classification back to
          // 'connection'. See `permanentFailureConfirmed`'s declaration.
          permanentFailureConfirmed = true;
          failDeal(err);
          // TRI-STATE, NOT A DEFINITE `false` (Codex P2 round 3 on #762,
          // specs/w1-attestation.md § Failure state): a REJECTED read is not
          // evidence the server profile lacks a stamp — it is UNKNOWN, exactly
          // like every other thrown bootstrap read. Settling it to `false`
          // would (since `profileReady` is already true) flip `needsAttestation`
          // true and swap the just-published permanent DealError — and its
          // Retry control — for the SignIn re-prompt, stranding the User in a
          // loop with no way back to the retry surface. Grant `true` only for a
          // committed-adjacent optimistic sticky; otherwise leave it UNKNOWN.
          setAttested(attestedUidsRef.current.has(u.uid) ? true : undefined);
        },
      );
    let attestedRead: boolean | undefined;
    let bootstrapFailure: { err: unknown } | null = null;
    try {
      attestedRead = await readAuthority();
    } catch (err) {
      bootstrapFailure = { err };
    }
    // #519, the BOOTSTRAP half of the same startup race (Codex P2 on #719). An
    // update reload can drop `ensureUserProfile` or the server-only attestation
    // read exactly as easily as it drops the deal, and that failure reaches
    // `failDeal` below WITHOUT `runDeal` ever being entered — so a grace consulted
    // only there would leave the Player looking at the identical connection-worded
    // `DealError`, cleared by an identical instantly-succeeding Retry. The two
    // paths are indistinguishable to the Player, so they share one grace on
    // identical terms (`claimPostUpdateGrace`): online, transient, not a
    // pool-shortfall, at most once per document, claimed by whichever half fails
    // first. The repeat is silent because NOTHING has settled yet — `loading` is
    // still held and `profileReady` still false, so the Player stays on the same
    // "Loading…" they were already on rather than seeing an error frame. Only this
    // branch needs it: the optimistic-sticky arm below keys off `attestedUidsRef`,
    // a per-document ref that a reload always resets to empty.
    //
    // ORDER: the grace repeat runs BEFORE the failure arm, so it runs before the
    // #521 provisional cache lift. The two are not interchangeable here. The lift
    // lives downstream of `failDeal`, so lifting first would mean setting a
    // connection-worded `dealError` and painting the cached card — the very error
    // frame the grace exists to skip — and then clearing it a moment later when the
    // repeat lands: a visible flicker on the happy path. Repeating first also makes
    // the lift strictly rarer and strictly better-informed: it is reached only once
    // TWO reads have failed, and a repeat that succeeds settles REAL authority
    // (`attestedAuthoritative`), which the cache lift by construction never can.
    if (bootstrapFailure && profileAttemptRef.current === attempt && claimPostUpdateGrace(bootstrapFailure.err)) {
      try {
        attestedRead = await readAuthority();
        bootstrapFailure = null;
      } catch (err) {
        bootstrapFailure = { err };
      }
    }
    if (profileAttemptRef.current !== attempt) return;
    // OPTIMISTIC-UI vs DURABLE-AUTHORITY (round 7): the optimistic sticky only keeps
    // the UI attested (no re-prompt); ONLY a COMMITTED same-session attest grants
    // deal authority when the server read cannot.
    const optimisticSticky = attestedUidsRef.current.has(u.uid);
    const committedSticky = attestCommittedUidsRef.current.has(u.uid);
    if (bootstrapFailure && authorityApplied) {
      // The FIRST read's answer landed late while the #519 grace repeat was in
      // flight, and the repeat then failed. Authority is terminal for the attempt:
      // `settleAuthoritative` has already applied a definite server answer (stamp →
      // deal; null → re-prompt) and cleared the error, so the repeat's connection
      // failure must not paint a `DealError` over it, and the failure arm's
      // provisional cache lift must not re-open a gate that answer just closed.
      // Only reachable via the grace repeat — it is the only `await` between the
      // catch that sets `bootstrapFailure` and this branch.
      //
      // This arm is the FAILURE half of that window. Its sibling — the repeat
      // SUCCEEDS after the late answer already settled — is not handled here at
      // all: it lands in the `else` below and is retired by the settle's own
      // first-wins latch (Phase 4b P1 on #728). Guarding one half here and leaving
      // the other to a call-site check is exactly how the hole opened, so the
      // terminality now lives in `settleAuthoritative` and this arm covers only
      // what it must: suppressing `failDeal` and the cache lift, neither of which
      // routes through the settle.
    } else if (bootstrapFailure) {
      // Server read failed (not authoritative). A COMMITTED same-session attest is
      // durable authority and may deal; an OPTIMISTIC-only attest keeps the UI
      // attested (no re-prompt) but grants NO authority; otherwise surface the
      // retryable error and leave attestation UNKNOWN (no downgrade on a blip).
      if (committedSticky) {
        setAttested(true);
        setAttestedAuthoritative(true);
      } else if (optimisticSticky) {
        // Optimistic-only attest + server-read FAILURE (Codex #117 round 9, finding
        // A): keep the UI attested (no re-prompt), but the deal is gated off (no
        // authority). A returning User WITH a cached board renders it (no deal
        // needed); a BOARDLESS User would otherwise sit on "Dealing…" with no
        // control — so give THEM a retryable error whose Retry re-runs the
        // bootstrap. Fire-and-forget the cache check so it never delays the loading
        // release; guard on the attempt.
        //
        // AND on `authorityApplied` (Codex P2 on #728): the attempt guard alone is
        // not enough, because a LATE authority read settles this SAME attempt. If
        // the orphaned read lands with a stamp while this probe is still running,
        // `settleAuthoritative` clears the timeout error and grants authority, the
        // deferred deal fires, and a slower `hasCachedBoard(false)` would then
        // re-post the obsolete timeout error over a freshly dealt Board with
        // nothing left to clear it. A settled authority retires this work.
        setAttested(true);
        const failure = bootstrapFailure.err;
        void hasCachedBoard(u.uid).then((boarded) => {
          // Also guarded on `permanentFailureConfirmed` (Codex P2 round 4 on
          // #762): `failure` is whatever `bootstrapFailure` holds NOW, which
          // — after a #519 grace repeat — can be the repeat's OWN mere
          // timeout, weaker evidence than an already-confirmed permanent
          // rejection. A weaker failure must never downgrade a confirmed one.
          if (!authorityApplied && !permanentFailureConfirmed && profileAttemptRef.current === attempt && !boarded) {
            failDeal(failure);
          }
        });
      } else if (!permanentFailureConfirmed) {
        // Skipped entirely when a PERMANENT failure was already confirmed for
        // this attempt (Codex P2 round 4 on #762): `bootstrapFailure` here can
        // be a #519 grace repeat's own mere TIMEOUT — a non-conclusive
        // failure, not an answer — and publishing it would downgrade the
        // confirmed 'permanent' classification back to 'connection', masking
        // the real failure behind transient-error handling. The correction
        // already published the right error and retired the cache lift
        // (`provisionalLiftRetired`); nothing else in this branch is safe to
        // run over it. A genuine authoritative SUCCESS is unaffected — it
        // lands in the `else` below, not here.
        failDeal(bootstrapFailure.err);
        // …and, for a CONNECTION-class failure ONLY, fall back to the SAME
        // cache-first proof the OFFLINE branch uses (#521). `navigator.onLine`
        // said true, but the authority read never landed — which IS the
        // captive/ship-Wi-Fi case this file already bounds a timeout for:
        // effectively offline, with a lying probe. A failed read is not
        // evidence about the stamp, so leaving `attested` UNKNOWN keeps
        // `canRenderEventContent` false, and App then withholds the whole Event
        // — including the #434 durable card this device already holds. That is
        // the ADR 0006 promise inverted: the one moment the saved card exists
        // for is the one moment it cannot paint. A cached `attestedAdultAt` is
        // the same proof of 18+ the offline branch accepts, so it lifts RENDER
        // here too — PROVISIONALLY: never `attestedAuthoritative`, so no deal
        // fires and no durable rows are created for a User the server has not
        // confirmed, and the late authoritative settle above still downgrades a
        // definite server-null to the re-prompt. A cache MISS changes nothing:
        // the gate stays up (it never fails open).
        //
        // Gated on the SHARED `dealErrorReasonFor` (Codex P2 on #521), the same
        // classification `failDeal` just published as `dealErrorReason` — so a
        // PERMANENT rules/schema/permission or unknown-coded failure keeps the
        // whole Event withheld behind the retry surface, exactly as the #403
        // swallow and the #434 cached-card fallback already refuse it. Reading
        // one classifier is what keeps the two decisions from disagreeing: the
        // render gate can never lift for a failure whose class then forbids App
        // from painting the cached card it lifted for.
        //
        // Fire-and-forget so the loading release below is not delayed;
        // guarded on the attempt like every other settle here. Also guarded on
        // `provisionalLiftRetired` (Codex P2 round 3 on #762): a late PERMANENT
        // rejection of the underlying read can retire this exact lift before
        // this cache read resolves, and an unguarded re-lift here would
        // silently undo that correction.
        if (dealErrorReasonFor(bootstrapFailure.err) === 'connection') {
          void readAdultAttestationFromCache(u.uid)
            .then((stamp) => {
              if (authorityApplied || provisionalLiftRetired || profileAttemptRef.current !== attempt) return;
              if (stamp !== null) setAttested(true);
            })
            .catch(() => {});
        }
      }
    } else {
      // Authoritative read SETTLED in time — the same settle a late one takes, and
      // deliberately unguarded: if the #519 grace repeat is what succeeded here but
      // the orphaned FIRST read already landed through `onLate`, this call is the
      // second settle of one attempt and `settleAuthoritative` drops it on the
      // floor. The first answer stands (Phase 4b P1 on #728).
      settleAuthoritative(attestedRead === true);
    }
    setProfileReady(true);
    // Online gate resolved — release the "Loading…" hold and render (finding B).
    setLoading(false);
  }, [failDeal, clearDealError]);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      // Whether THIS is the very first auth-state callback this mount has
      // ever seen — checked and cleared unconditionally, before any other
      // branch, so it reflects mount lifecycle regardless of outcome.
      // Narrows signal (b)'s cross-tab exposure below (Phase 4b P1 on #836):
      // Firebase Auth persistence is ORIGIN-WIDE, not tab-scoped, so an
      // unrelated same-origin tab's own sign-in also publishes through
      // every other open tab's onAuthStateChanged. Restricting signal (b)
      // to the mount's OWN first-ever settle means a stale pending record
      // can only be (mis)consumed by an unrelated event arriving in the
      // narrow window right at THIS tab's boot — not at any later point
      // across an already-running session, which is the far more likely
      // shape of an unrelated cross-tab collision.
      const isFirstAuthSettle = firstAuthSettleRef.current;
      firstAuthSettleRef.current = false;
      // Auth changed: retire the previous account's in-flight deal/bootstrap and
      // clear its stale state so a late result can't clobber the incoming User (P2).
      authUidRef.current = u?.uid ?? null;
      const profileAttempt = (profileAttemptRef.current += 1);
      dealAttemptRef.current += 1;
      clearDealError();
      setDealing(false);
      // The incoming User's profile bootstrap has not settled yet (#77), so the
      // 18+ attestation is UNKNOWN — never `false` — until it does (#23), and its
      // authority is un-established until an authoritative read/attest settles it.
      setProfileReady(false);
      setAttested(undefined);
      setAttestedAuthoritative(false);
      setProfileBootstrapOk(false);
      setUser(u);
      if (!u) {
        if (handoffSignedOutWebApp()) {
          // Move a signed-out web.app visit before rendering SignIn, so the Player
          // sees one acknowledgement and one Google transaction on firebaseapp.com.
          // Deliberately EVERY signed-out settle, not just first load (#353): a
          // mid-session sign-out on web.app also lands on the canonical origin,
          // because any sign-in tap from web.app would hand off anyway — leaving
          // the Player on web.app's SignIn would only add a second
          // acknowledgement screen before the same navigation.
          return undefined;
        }
        // Signed out → App renders SignIn, never "Loading…".
        setLoading(false);
        return undefined;
      }
      // Signal (b), #346: the durable pending record proves a redirect was
      // actually started, so a User publishing HERE — even with no
      // getRedirectResult answer yet, or ever — is that redirect completing,
      // not an ordinary cached-session restore. This is a no-op on every
      // mount where no redirect was pending — which is every normal reload,
      // including a normal signed-in restore.
      //
      // Revalidated LIVE via `peekRedirectPending()`, not the mount-time
      // cache `consumeRedirectContextOnce()` holds (Codex P2 on #836): that
      // cache is a snapshot taken once at mount and never expires on its
      // own, so a mount that stays alive past the record's TTL before
      // onAuthStateChanged ever fires — an unusually long-lived tab, or an
      // auth change unrelated to the original redirect — would otherwise
      // complete a redirect the TTL was supposed to have abandoned by then.
      // A fresh peek re-checks the TTL against the CURRENT time whenever
      // this callback actually runs, so the record's own liveness — not a
      // stale boolean — decides whether signal (b) fires.
      //
      // ALSO gated on `isFirstAuthSettle` (Phase 4b P1 on #836): the durable
      // record is an ORIGIN-WIDE localStorage entry, so on its own it proves
      // only that SOME tab started a redirect — not that THIS auth-state
      // publication is that same attempt returning. Firebase Auth
      // persistence is shared across every same-origin tab, so an unrelated
      // tab independently signing in also fires THIS tab's listener. Scoping
      // to the mount's own first-ever settle closes the far more likely
      // shape of that collision — a stale record surviving into an
      // already-running, already-settled tab's LATER, unrelated auth event —
      // without abandoning the marker-loss rescue itself (#346), which still
      // needs to fire on an ordinary FRESH mount where no other signal
      // exists yet. The narrower same-TAB confirmation for the higher-stakes
      // attestation write is threaded through as `sameTabConfirmed` below.
      if (isFirstAuthSettle && peekRedirectPending()) {
        completeRedirectReturn(u, consumeRedirectContextOnce().appOwnedRedirect);
      }
      // Gate on "Loading…" until the bootstrap PROVES 18+ (finding B): the
      // authoritative server read online, or a cached stamp / same-session attest
      // offline. Never render the Board before proof. Not an await (that was the
      // offline hang); bootstrapUser releases the hold with setLoading(false) —
      // immediately from the fast local cache read when offline-attested (the #115
      // cold-boot render), after the server read when online. Offline-UNKNOWN
      // stays held here until reconnect. Both branches gate the same way, so a
      // returning User never sees the Event without proof-of-18+.
      setLoading(true);
      // Bootstrap runs OFF the render path — fire-and-forget. Returning the
      // promise keeps the auth-change unit tests deterministic (Firebase ignores
      // an onAuthStateChanged callback's return value).
      return bootstrapUser(u, profileAttempt);
    });
    // `completeRedirectReturn` (referenced above; `peekRedirectPending` is a
    // module-level function, not a hook value, so it needs no entry here) is
    // deliberately NOT in this array, and is safe to omit: it is declared
    // further down this same function body (after `persistAttestation`), so
    // putting it here would evaluate a `const` before its own declaration
    // line runs. That is safe ONLY because the reference above lives inside
    // this callback, which React does not invoke until after the whole
    // component function — including that later declaration — has finished
    // executing for this render; by then it is assigned. Listing it here
    // would additionally re-subscribe onAuthStateChanged on every identity
    // change of it, which is exactly the subscription churn
    // `redirectReturnPendingRef` (above) exists to avoid for the same
    // callback — and unnecessary besides, since neither closes over anything
    // but refs, other stable callbacks, and React's own always-stable setState
    // functions.
  }, [bootstrapUser, clearDealError, handoffSignedOutWebApp]);

  // Mirror connectivity into React state AND complete the DEFERRED offline
  // bootstrap when the network returns (#115). `online` flipping true re-runs the
  // deal effect (so a cache-attested User who booted offline onto a fresh Event
  // finally deals — finding C), and the guarded bootstrap re-run finishes the
  // deferred authoritative work exactly once. This is also the post-reconnect
  // determinism fix: the old code left an awaited transaction PENDING on the auth
  // callback across the whole dead zone, so on reconnect its retry backoff raced
  // the profileAttempt supersede logic and the bootstrap did not reliably re-run.
  // Now offline leaves NOTHING pending, and reconnect is a single guarded pass.
  useEffect(() => {
    // BOTH transitions supersede any in-flight bootstrap (bump profileAttemptRef)
    // and re-run bootstrapUser for the current connectivity, so loading is never
    // stranded on a bootstrap owned by the wrong connectivity (finding C). A
    // superseder OWNS resetting the flags the superseded attempt would otherwise
    // have settled: it clears `dealing` so a retry invalidated by the bump can
    // never strand the "Dealing…" spinner (Codex #117 round 5, finding B) — the
    // in-flight retry's late resolution returns early on the attempt mismatch and
    // never clears `dealing` itself.
    const goOnline = () => {
      setOnline(true);
      const u = auth.currentUser;
      if (!u) return;
      setDealing(false); // supersede: don't strand an invalidated retry's spinner
      // Finish the deferred authoritative work; `online` flipping true also re-runs
      // the deal effect so a confirmed-attested User who booted offline deals once
      // — but only AFTER this fresh read re-confirms authority (see goOffline).
      void bootstrapUser(u, (profileAttemptRef.current += 1));
    };
    const goOffline = () => {
      setOnline(false);
      const u = auth.currentUser;
      if (!u) return;
      setDealing(false); // supersede: clear an invalidated retry's spinner (r5 finding B)
      // RETIRE any in-flight joinAndDeal (Codex #117 round 6, finding B): the deal
      // path has its OWN supersede ref (dealAttemptRef), which the offline handler
      // did not bump, so a runDeal already in flight stayed "current" — its late
      // REJECTION after the cache-first path rendered the board would set dealError
      // and replace the cached board with the error panel during the dead zone.
      // Bumping dealAttemptRef makes that stale deal's catch return early on the
      // attempt mismatch (the deal-attempt analog of the r5 profileAttemptRef fix).
      dealAttemptRef.current += 1;
      // A pre-offline authoritative read must NOT survive the dead zone as a
      // license to deal on reconnect (Codex #117 round 5, finding A): the stamp
      // could be deleted server-side while offline, and the reconnect handler flips
      // `online` before the fresh read finishes, so a stale `attestedAuthoritative`
      // would let the deal effect create rows during the reconnect window. Re-arm
      // it false so the reconnect deal waits for the FRESH server read — UNLESS a
      // COMMITTED same-session attest proves it (round 7: its transaction actually
      // succeeded THIS session, durable authority, not a stale cross-offline read
      // and not a merely optimistic pre-commit lift).
      if (!attestCommittedUidsRef.current.has(u.uid)) setAttestedAuthoritative(false);
      // Same reasoning for the non-adult path's authority (Codex P2 on #615): a
      // pre-offline success must not survive the dead zone as a licence to
      // create rows during the reconnect window, before the fresh read lands.
      setProfileBootstrapOk(false);
      // A mid-bootstrap connectivity LOSS SUPERSEDES the in-flight ONLINE bootstrap
      // (whose ensureUserProfile transaction may never settle offline and would
      // otherwise strand "Loading…") and switches to the cache-first path: release
      // to the cached Board if proof-of-18+ is cached, else hold (finding B/C).
      void bootstrapUser(u, (profileAttemptRef.current += 1));
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [bootstrapUser]);

  // Deal a Board once the User is known; failures surface via `dealError` so
  // App renders a retry surface, not a blank Board. `dealError` is replaced only
  // when THIS attempt settles — clearing it up front would unmount the retry
  // surface mid-retry and flash the blank Board (P3) — and a superseded attempt
  // (sign-out / account switch mid-deal) is dropped entirely (P2).
  const runDeal = useCallback(async (u: User) => {
    const attempt = (dealAttemptRef.current += 1);
    setDealing(true);
    // Bound the deal (#403): joinAndDeal is a network read+write that never
    // completes offline and can HANG on flaky wifi. A timeout rejects into the
    // catch below (classified as a connection failure, not pool-shortfall — the
    // message carries no "24 prompts"), so a stalled deal recovers instead of
    // stranding `dealing` true forever.
    //
    // withTimeout rejects the RACE but cannot cancel joinAndDeal (Codex #408 P2):
    // a first-timer's deal that exceeds DEAL_TIMEOUT_MS, surfaces the retryable
    // error, then LATER succeeds would leave its now-written card hidden behind the
    // stale dealError (the deal effect won't re-run on the late write). So attach a
    // late-success net to the ORIGINAL promise: if it eventually resolves and this
    // attempt is still current, clear the error so the card shows without a manual
    // retry. Guarded by the attempt so a superseded deal never clobbers; the
    // rejection arm is a no-op (the catch below already owns a real failure).
    //
    // The uncancelled deal is also WRITE-safe to overlap with a Retry (#409):
    // joinAndDeal runs its row/board read-and-write inside a runTransaction, so
    // the timed-out attempt still in flight and the Retry's fresh attempt
    // serialize server-side — the loser re-reads the committed join and
    // degrades to a no-op instead of double-writing. This ref-based supersede
    // guard stays load-bearing for CLIENT state (join_event, dealing/dealError)
    // — the transaction bounds the writes, not which attempt reports them.
    const dealPromise = joinAndDeal(u);
    void dealPromise.then(
      (dealt) => {
        if (dealAttemptRef.current === attempt) clearDealError();
        // Record `join_event` ONLY on an actual join — a NEW board/row (Codex
        // #117 round 8, finding B): joinAndDeal no-ops (returns false) for an
        // already-boarded Player, so a ship-wifi reconnect records nothing.
        // Tracked HERE, on the ORIGINAL promise, not on the awaited race below
        // (#409, Codex P2 on #472): the transactional join resolves `true` from
        // EXACTLY ONE call per actual join, and that call is not necessarily
        // the current attempt — a timed-out (superseded) attempt's transaction
        // can win while the Retry re-reads the committed row and resolves
        // false. Attributing off the original promise records that ordering's
        // join exactly once; the uid guard keeps a join that lands after a
        // sign-out/account switch from attributing to the wrong session (the
        // rare silent drop is the conservative direction).
        if (dealt === true && authUidRef.current === u.uid) track('join_event');
      },
      () => {},
    );
    try {
      // join_event tracking lives on the dealPromise net above — the awaited
      // race resolves the SAME promise, so the net covers this branch too
      // without double-firing.
      await withTimeout(dealPromise, DEAL_TIMEOUT_MS, 'Deal timed out');
      if (dealAttemptRef.current !== attempt) return;
      clearDealError();
    } catch (err) {
      if (dealAttemptRef.current !== attempt) return;
      // A TRANSIENT connection failure must not tear down a card the Player already
      // has (#403). The Board renders from the persistent Firestore cache
      // independently of this deal, and App swaps that cached Board for the
      // full-screen DealError the instant `dealError` is set — so a transient
      // re-deal blip (the deal effect re-fires on every reconnect, and daily-mode
      // joinAndDeal re-reads the event + re-writes the player row even for an
      // ALREADY-joined Player) would otherwise kick a Player off their working card.
      // So when the Player has an ACTUAL cached card to fall back on
      // (`hasCachedCard`) — SWALLOW the error: clear any stale one and leave the
      // cached Board up. Only a genuine no-card case (a first-timer whose very first
      // deal failed) still surfaces the retryable DealError. The probe is a cached
      // CARD, never a joined player row (Codex #408 P2): the row can be cached from
      // the Leaderboard / another tab while no board was ever loaded here, and it
      // reflects a card dealt THIS session too (the write lands in cache before its
      // server ack), so no separate session latch is needed — a per-session ref
      // could not tell a daily identity-row merge from a real card, nor survive an
      // account switch. Two failures are EXCLUDED so they always surface: a
      // pool-shortfall (not a connection issue — PoolRecoveryWatcher auto-recovers
      // it on the reason), and a PERMANENT Firestore failure (permission-denied /
      // failed-precondition /…, Codex #408 P2 — a rules/schema misconfiguration must
      // not be hidden behind the cached Board forever; it wants the retry surface).
      if (!isPoolShortfall(err) && isTransientDealError(err)) {
        const hasCard = await hasCachedCard(u.uid);
        // Re-check the supersede guard after the awaited cache probe (P2): a
        // sign-out / account switch mid-probe must still drop this result.
        if (dealAttemptRef.current !== attempt) return;
        if (hasCard) {
          clearDealError();
          return;
        }
        // #519: the FIRST deal after a service-worker update reload gets ONE
        // silent re-deal instead of the error surface. `updateServiceWorker(true)`
        // reloads the moment the new worker takes control, so this deal can fire
        // against an auth token / Firestore connection that is still coming up —
        // the failure reported twice on 2026-08-01, where Retry then succeeded on
        // the spot. The re-deal IS that Retry, minus making the player tap it:
        // `dealError` is never set (so `DealError` never renders, not even for a
        // frame) and `dealing` stays up, because the re-entrant attempt bumps
        // `dealAttemptRef` before the `finally` below reads it — the player sees
        // uninterrupted progress. Everything the manual Retry relies on holds
        // unchanged: the two joins serialize inside `joinAndDeal`'s transaction
        // (#409) and the attempt guard keeps the superseded one from reporting.
        //
        // `claimPostUpdateGrace` holds the bounds (see its comment): armed only by
        // a `controllerchange`, transient failures only, never offline, never a
        // pool-shortfall, and spent by its first taker — which may have been the
        // bootstrap half of this same race, in which case this failure surfaces.
        if (claimPostUpdateGrace(err)) {
          void runDealRef.current(u);
          return;
        }
      }
      failDeal(err);
    } finally {
      if (dealAttemptRef.current === attempt) setDealing(false);
    }
  }, [failDeal, clearDealError]);
  // Self-reference for the one silent re-deal the #519 grace fires: `runDeal` is a
  // `useCallback` and cannot name itself. Re-pointed every render at the current
  // closure, the same way `PoolRecoveryWatcher` holds `retryDeal`. Which closure
  // wins does not matter — the attempt counter, not the closure identity, is what
  // supersedes — so this needs no effect to be correct.
  const runDealRef = useRef(runDeal);
  runDealRef.current = runDeal;

  // Deal a Board only once the 18+ attestation is settled TRUE (#23, Finding 1):
  // the gate must gate the SIDE EFFECT, not just the UI. A signed-in returning
  // User whose settled profile lacks the stamp is re-prompted BEFORE joinAndDeal
  // creates their event board/player row — so the deal is DEFERRED, not merely
  // hidden. When such a User then attests, `attested` flips true and this fires the
  // deferred deal exactly once; an already-attested User deals as before (the read
  // settles `attested` true straight away); a first-time User deals after the
  // signed-in attest flow settles true. The dealAttempt guard + joinAndDeal's
  // board-exists early-return keep the flip from double-dealing.
  //
  // ALSO gated on connectivity (#115) AND on attestation AUTHORITY (Codex #117
  // round 2): a deal is a network-bound CREATE path (joinAndDeal writes a new
  // board/player row), so it must not fire offline, and must NEVER fire on a
  // PROVISIONAL (cache-derived) attestation. It gates on the reactive `online`
  // STATE (not the `isOnline()` probe) so the deps change on reconnect, and on
  // `attestedAuthoritative` so a cache-attested User who cold-boots OFFLINE onto a
  // fresh Event does NOT deal until the authoritative read confirms the stamp: on
  // reconnect `online` flips true first, but the deal waits for the server read to
  // settle `attestedAuthoritative` true — a server NULL downgrades to a re-prompt
  // WITHOUT ever dealing (no rows created for an un-attested User). The deal then
  // FIRES exactly once for a confirmed-attested User who lacks a board (finding C);
  // a same-session optimistic attest is authoritative too (its transaction
  // succeeded), so that User deals on reconnect. A returning boarded User re-runs
  // joinAndDeal on that flip but its board-exists early-return makes it a no-op;
  // the dealAttempt guard keeps any reconnect re-run from clobbering state.
  //
  // #608 SPLITS THE GATE FROM ITS SUBJECT. Every guarantee above is about
  // proving an 18+ attestation before creating durable rows — which presupposes
  // that this Event asks for one. When `hostnames/{host}.adultContent` is false
  // no attestation is ever collected, so `attested` settles a permanent `false`
  // and the deal would never fire at all. The equivalent "the bootstrap settled
  // authoritatively" signal on that path is `profileReady`, which the ONLINE
  // branch sets only after `ensureUserProfile` has actually run — so the
  // write-safety property (never create board/player rows before the profile
  // bootstrap SUCCEEDS, never offline) is preserved rather than dropped —
  // `profileBootstrapOk`, not `profileReady`, because the latter is also true
  // after a bootstrap FAILURE and would deal on a timed-out `ensureUserProfile`
  // (Codex P2 on #615). The offline branch never sets it, and `online` gates
  // besides.
  const mayDeal = attestationRequired ? attested === true && attestedAuthoritative : profileBootstrapOk;
  useEffect(() => {
    if (user && mayDeal && online) void runDeal(user);
  }, [user, mayDeal, online, runDeal]);

  // Re-attempt a FAILED attestation bootstrap (#112 round 2): re-runs
  // ensureUserProfile + readAdultAttestation under profileAttemptRef — the same
  // guard as the auth callback whose work it re-runs — so a newer auth change
  // supersedes it. On success the attestation settles: `true` fires the deferred
  // deal via the attested gate (keep `dealing` up so the retry surface shows
  // seamless progress, and let the deal's OWN settle replace dealError — the P3
  // discipline: never clear before settle); a definite `false` hands over to the
  // full-screen re-prompt, so the stale error and in-flight flag are dropped. A
  // repeat failure re-arms the same honest error+retry surface — never the
  // silent spinner this replaces.
  const retryBootstrap = useCallback(async (u: User) => {
    const attempt = (profileAttemptRef.current += 1);
    setDealing(true);
    // The retry's OWN terminal-settle latch, the exact analogue of the one in
    // `bootstrapUser`'s online branch: whichever server answer lands first — the
    // in-time race result or the late one below — is authority for this attempt,
    // and nothing later may re-settle it. Enforced INSIDE the settle, not at the
    // call sites, for the same reason (Phase 4b P1 on #728): today the in-time and
    // late paths here are mutually exclusive (`onLate` fires only when the race
    // rejected, which skips the in-time settle), so this is belt-and-braces — but
    // that exclusivity is an accident of there being no `await` between them, and
    // the bootstrap's sibling latch was breached the moment the #519 grace put one
    // there. First settle wins, at the source, on both authority paths.
    let authorityApplied = false;
    // Snapshot of the deal generation as of THIS retry (Codex P2 on #761, the
    // analogue of `bootstrapUser`'s `dealAttemptAtBootstrap`): an outstanding
    // same-session attest can commit and fire `runDeal` via the `mayDeal` effect
    // WHILE this retry's read is still in flight, independent of anything here. If
    // that deal fails before the read settles, the "no authority" clear below must
    // not erase it — see the guard on `clearDealError`/`setDealing` there.
    const dealAttemptAtRetry = dealAttemptRef.current;
    const settleRetry = (read: boolean) => {
      if (authorityApplied) return;
      authorityApplied = true;
      const optimisticSticky = attestedUidsRef.current.has(u.uid);
      const committedSticky = attestCommittedUidsRef.current.has(u.uid);
      // The retry re-runs the SAME work `bootstrapUser`'s online branch does, so
      // it grants the same authority on success (#608, Codex P2 on #615): without
      // this, an Event with no age gate whose first bootstrap failed would sit on
      // the retry surface forever — the retry would land, clear the error, and
      // still never license the deal.
      setProfileBootstrapOk(true);
      // UI: server stamp OR optimistic attest (no re-prompt). AUTHORITY: server
      // stamp OR a COMMITTED same-session attest — never an optimistic pre-commit
      // lift (round 7).
      setAttested(read || optimisticSticky);
      if (read || committedSticky) {
        // Authority granted → let the deferred deal fire and OWN `dealing` (keep it
        // up for seamless progress; the deal's own settle replaces dealError — P3).
        setAttestedAuthoritative(true);
      } else {
        // No authority: a definite server-null with no committed attest (re-prompt),
        // or an uncommitted optimistic attest (UI-attested, no deal). Either way no
        // deal fires, so settle the retry surface here rather than spin forever.
        // This is also the arm that DOWNGRADES a #521 provisional cache lift when
        // the retry's answer is a definite server-null: `setAttested(false)` closes
        // the render gate the cache opened, so the re-prompt replaces the durable
        // card rather than the card standing on cache alone.
        //
        // Guarded on the deal generation (Codex P2 on #761): only clear/reset while
        // this retry still owns them. A deal attempt that started AFTER this read
        // began (an outstanding attest committing mid-read, via the `mayDeal`
        // effect) owns whatever error and `dealing` state it sets — that attempt's
        // own settle (see `runDeal`'s `finally`) is what retires `dealing` for it,
        // and this late "no authority" answer must not erase its fresher error.
        if (dealAttemptRef.current === dealAttemptAtRetry) {
          clearDealError();
          setDealing(false);
        }
      }
    };
    try {
      // Routed through the SHARED `startAuthorityRead` so the retry honors a LATE
      // server answer exactly as the initial bootstrap does (Codex P2 on #728).
      // Without it this path was the remaining hole in the #521 contract: a
      // provisional cache lift is standing, the Player taps Retry, this read times
      // out at AUTH_BOOTSTRAP_TIMEOUT_MS and its definite server-null arrives a
      // moment later — and, since `navigator.onLine` never flipped, no connectivity
      // event supersedes the attempt and nothing else ever re-reads authority. The
      // discarded null left the stale lift up and the durable card painted for a
      // User the server says has no stamp. Now it downgrades, same as everywhere
      // else.
      const read = await startAuthorityRead(
        u,
        (late) => {
          if (profileAttemptRef.current === attempt) settleRetry(late);
        },
        (err) => {
          // A late PERMANENT rejection during a retry (Codex P2 round 2 on
          // #762). retryBootstrap does not reset `attested` at its own start,
          // so a 'connection'-classified provisional lift (#521) carried over
          // from an EARLIER bootstrapUser attempt — or one this retry's own
          // in-time timeout below just made — can still be standing when this
          // fires. Route it through the same correction bootstrapUser's
          // onLateError applies: skip if this attempt is superseded, already
          // terminal (latch it here too, for the same reason — nothing later
          // may re-lift `attested` for this attempt), or a newer deal attempt
          // now owns the error (Codex P2 on #761, the same generation guard
          // `settleRetry`'s own clear uses above).
          if (profileAttemptRef.current !== attempt) return;
          if (authorityApplied) return;
          if (dealAttemptRef.current !== dealAttemptAtRetry) return;
          if (dealErrorReasonFor(err) !== 'permanent') return;
          // retryBootstrap has no #519 grace-repeat analogue (a single read,
          // no concurrent second attempt), so — unlike bootstrapUser's sibling
          // above — latching `authorityApplied` here is safe: there is no
          // later, more current answer this could ever suppress.
          authorityApplied = true;
          failDeal(err);
          // TRI-STATE, NOT A DEFINITE `false` (Codex P2 round 3 on #762,
          // specs/w1-attestation.md § Failure state): a REJECTED read is not
          // evidence the profile lacks a stamp — it is UNKNOWN. Settling it to
          // `false` would flip `needsAttestation` true and swap the
          // just-published permanent DealError (and its Retry control) for the
          // SignIn re-prompt, the same stranding bootstrapUser's sibling fix
          // avoids.
          setAttested(attestedUidsRef.current.has(u.uid) ? true : undefined);
          setDealing(false);
        },
      );
      if (profileAttemptRef.current !== attempt) return;
      settleRetry(read);
    } catch (err) {
      if (profileAttemptRef.current !== attempt) return;
      failDeal(err);
      setDealing(false);
    }
  }, [failDeal, clearDealError]);

  // Retry the current User's path to a dealt Board, in place (no reload). The
  // manual retry must honor the SAME write-safety gate as the automatic deal
  // effect (Codex #117 round 3, finding A) — literally the same `mayDeal`
  // expression, so the two can never drift: online AND the attestation
  // AUTHORITATIVE (server-settled or same-session attest) and `attested === true`,
  // or, on an Event that asks for no attestation at all (#608), the profile
  // bootstrap settled. Otherwise — offline, or on a merely PROVISIONAL cached
  // attestation (e.g. an offline cold boot whose reconnect bootstrap threw before
  // an authoritative read) — re-run the bootstrap instead, never joinAndDeal. A
  // retry can therefore never create board/player rows offline or on un-proven
  // attestation; it drives the authoritative read, and the deal fires (via the
  // effect) only once that confirms.
  const retryDeal = useCallback(() => {
    if (!user) return;
    if (!isOnline()) {
      // OFFLINE Retry → the CACHE-FIRST path, NEVER the transaction bootstrap
      // (Codex #117 round 4, finding A): retryBootstrap awaits ensureUserProfile —
      // a Firestore transaction that never resolves offline — so it would strand
      // the button in "Dealing…" for the whole dead zone. bootstrapUser's offline
      // branch instead settles from cache immediately (proof-of-18+ → render the
      // cached Board and clear the stale error; else stay held/retryable), and
      // never awaits the transaction. It also never deals (offline gate).
      void bootstrapUser(user, (profileAttemptRef.current += 1));
    } else if (mayDeal) {
      // Online + authoritative → re-deal in place.
      void runDeal(user);
    } else {
      // Online but not yet authoritative → re-run the full transaction bootstrap.
      void retryBootstrap(user);
    }
  }, [user, mayDeal, runDeal, retryBootstrap, bootstrapUser]);

  // Persist the current User's honor-system 18+ self-attestation (ADR 0001) and
  // lift the re-prompt gate at once. Optimistic: the local flag flips before the
  // write acks, so a slow write never re-shows the prompt the User just satisfied;
  // a failed write stays optimistically attested for the session and re-attempts
  // on the next sign-in (honor-system self-statement, never a hard gate).
  const persistAttestation = useCallback(async (u: User) => {
    // OPTIMISTIC-UI tier (#23, Finding 3): record + flip attested true BEFORE the
    // write so a later auth-state callback can never settle a re-prompt on a stale
    // read, and the UI proceeds with no flicker. This does NOT grant deal authority.
    attestedUidsRef.current.add(u.uid);
    setAttested(true);
    try {
      // Pass the full User so a create-race win writes the COMPLETE profile, not
      // just the stamp (Finding 2).
      await attestAdult(u);
      // DURABLE-AUTHORITY tier (round 7): the write COMMITTED — a durable
      // users/{uid}.attestedAdultAt now exists — so this same-session attest is
      // authoritative and may fire the deal. Grant it ONLY here, in the success
      // path, and only if this is still the current User (a sign-out/switch during
      // the await already re-armed the flag false). Never before the commit: an
      // optimistic pre-commit lift is UI-only.
      attestCommittedUidsRef.current.add(u.uid);
      if (auth.currentUser?.uid === u.uid) setAttestedAuthoritative(true);
    } catch {
      // The write REJECTED. Roll the OPTIMISTIC-ONLY lift back so a stranded
      // first-time User (re-prompt dismissed, no authority, no board, stuck on
      // "Dealing…") gets the re-prompt back to retry in session (round 8 finding A).
      // BUT never downgrade a User the bootstrap already SERVER-CONFIRMED as
      // attested (Codex #117 round 9, finding B): a returning User with a valid
      // server stamp whose redundant signIn-attest transaction merely dropped the
      // network must NOT be re-prompted despite authoritative proof. So roll back
      // ONLY when this uid is NOT authoritatively attested (no server stamp, no
      // committed attest). A never-resolving offline attest never reaches here, so
      // the #112 offline-optimistic behavior and the no-flicker SUCCESS path are
      // untouched.
      if (auth.currentUser?.uid !== u.uid) return;
      if (attestedAuthoritativeRef.current || attestCommittedUidsRef.current.has(u.uid)) return;
      attestedUidsRef.current.delete(u.uid);
      setAttested(false);
    }
  }, []);

  const attest = useCallback(async () => {
    const u = auth.currentUser;
    if (u) await persistAttestation(u);
  }, [persistAttestation]);

  // Reads the sessionStorage marker, the collected-acknowledgement record, and
  // the durable redirect-pending record EXACTLY once per mount, regardless of
  // which of the two completion signals below reaches it first. Idempotent:
  // whichever signal loses the race gets the SAME already-read values back
  // instead of re-reading storage the winner already touched.
  //
  // The pending record is PEEKED here, not consumed (Codex P2 on #836): this
  // effect runs, and calls this, before EITHER completion signal is
  // guaranteed to fire in this mount — if getRedirectResult resolves null and
  // the page reloads, crashes, or is replaced before onAuthStateChanged
  // publishes the restored user, clearing the record here would erase the
  // one thing a LATER mount could still use to complete the same redirect via
  // signal (b). It is cleared only on an actual terminal outcome:
  // `completeRedirectReturn` below (either signal completed), or a genuine
  // getRedirectResult rejection for a mount that already knows it was
  // pending (see the `.catch()` below). Left alone otherwise, it simply
  // expires on its own TTL.
  const redirectContextRef = useRef<{
    appOwnedRedirect: boolean;
    acknowledged: boolean;
    pending: boolean;
  } | null>(null);
  const consumeRedirectContextOnce = useCallback(() => {
    if (!redirectContextRef.current) {
      redirectContextRef.current = {
        appOwnedRedirect: consumePendingRedirectAttestation(),
        // PEEKED, not consumed (Codex P2 round 2 on #836) — same reason and
        // same fix shape as `pending` below: this effect can run, and read
        // this, before either completion signal is guaranteed to fire, so
        // clearing it here could drop a legitimately collected acknowledgement
        // a later mount's signal (b) still needs. Cleared only in
        // `completeRedirectReturn` or the redirect-result effect's `.catch()`.
        acknowledged: peekCollectedAcknowledgement(),
        pending: peekRedirectPending(),
      };
    }
    return redirectContextRef.current;
  }, []);

  // A top-level redirect reloads the app, so finish the Firebase transaction on
  // mount and complete the acknowledgement that gated the original sign-in tap.
  // The marker is same-origin session state and is consumed exactly once — but
  // completion does NOT require it (#346): Safari can drop sessionStorage
  // across the provider round-trip while Firebase still restores the session,
  // and gating on the marker skipped the redirect `login` event and the checked
  // 18+ attestation exactly then.
  //
  // TWO independent completion signals now race for the SAME work (Phase 4b /
  // decision-765): (a) getRedirectResult resolving non-null — the direct,
  // in-time answer; (b) the durable `gcb.signin.redirectPending` record being
  // live when onAuthStateChanged next publishes a signed-in User — the signal
  // that survives the exact partitioning that can leave (a) resolving null on
  // a return Firebase otherwise completed. `completeRedirectReturn` is the ONE
  // latch both route through, so `login` fires exactly once and the
  // attestation persists at most once no matter which signal wins, or whether
  // both fire (the common case for an actual successful return). The pending
  // record is written ONLY at redirect start (signIn), so signal (b) is a
  // no-op on every ordinary mount — including a normal cached-session restore,
  // which publishes a signed-in User via onAuthStateChanged just as often.
  // This latch also doubles as the shared outcome decision with the
  // redirect-result effect's failure path below (Codex P2 round 2 on #836):
  // whichever of a SUCCESS (here) or a genuine getRedirectResult REJECTION
  // (there) is decided first wins, and the other becomes a no-op. Without
  // that sharing, a rejection landing while signal (b) is still in flight —
  // or a signal-(b) success landing after a rejection already reported — can
  // fire both `login_failed` and `login` for the same attempt.
  const redirectCompletionLatchRef = useRef(false);
  // `sameTabConfirmed` (Phase 4b P1 on #836): whether THIS completion is
  // known to belong to THIS browsing context, not merely to SOME same-origin
  // tab. Signal (a)'s caller always passes `true` — `getRedirectResult`
  // resolving non-null is Firebase's OWN internal, per-tab-scoped record of
  // ITS OWN most recent `signInWithRedirect` call, so a DIFFERENT tab that
  // never called it can only ever see that tab's own `null`. Signal (b) has
  // no such guarantee — the durable record is origin-wide localStorage, so
  // it passes whether the SESSION-STORAGE marker (tab-scoped; cleared and
  // re-created only by THIS tab's own `signIn`/redirect-return cycle) was
  // ALSO present. Gates the ATTESTATION WRITE specifically — the honor-
  // system self-statement that must never land on an account THIS browsing
  // context did not itself confirm — while `login` still fires from the
  // durable record alone (further narrowed by `isFirstAuthSettle` at the
  // call site above), since an occasional extra analytics ping in a
  // contrived concurrent-tab collision is a far smaller cost than
  // fabricating an 18+ attestation for the wrong signed-in account.
  const completeRedirectReturn = useCallback(
    (u: User, sameTabConfirmed: boolean) => {
      if (redirectCompletionLatchRef.current) return;
      redirectCompletionLatchRef.current = true;
      track('login', { method: 'google' });
      const { acknowledged } = consumeRedirectContextOnce();
      // Clearing the durable records is ALSO gated on `sameTabConfirmed`
      // (Phase 4b P1 on #836), not run unconditionally: an unconfirmed
      // signal-(b) firing (the cross-tab collision case) must not destroy
      // the ONE thing the legitimate originating tab's own return — which
      // may still be in flight — needs to complete WITH full confirmation
      // later. Left standing, an unconfirmed record simply expires on its
      // own TTL if truly abandoned, same as a mount that only ever read it.
      if (sameTabConfirmed) {
        clearRedirectPending();
        clearCollectedAcknowledgement();
      }
      // Persist ONLY an acknowledgement that was actually collected (Phase 4b
      // round 4) AND same-tab confirmed. The posture is read when the
      // redirect STARTS, not when it returns: an Event that turns adult
      // while the player is away at Google would otherwise have this branch
      // stamp a durable, cross-Event `attestedAdultAt` for a checkbox that
      // was never on screen — and walk them straight through the gate it
      // had just raised. `sameTabConfirmed` closes the companion risk
      // (Phase 4b P1 on #836): without it, an unrelated same-origin tab's
      // own sign-in could inherit and persist THIS tab's collected
      // acknowledgement onto a DIFFERENT account. Either gate failing is
      // exactly right to fall through to nothing: `needsAttestation` settles
      // against the current posture and the existing re-prompt collects it
      // properly.
      if (acknowledged && sameTabConfirmed) void persistAttestation(u);
    },
    [consumeRedirectContextOnce, persistAttestation],
  );

  // Signal (a). getRedirectResult settles once per mount, nothing
  // render-critical awaits it, and it resolves non-null ONLY on an actual
  // redirect return — never on an ordinary mount — so on its own it cannot
  // emit phantom `login` events; routing it through the shared latch keeps
  // that true even when signal (b) also fires. The marker still scopes FAILURE
  // reporting: a rejection becomes `login_failed` only when the marker proves
  // an app-owned redirect was in flight — a marker-less rejection on an
  // ordinary mount (e.g. partitioned helper storage) stays out of analytics.
  useEffect(() => {
    if (redirectResultHandledRef.current) return;
    redirectResultHandledRef.current = true;
    const { appOwnedRedirect } = consumeRedirectContextOnce();

    void getRedirectResult(auth)
      .then((result) => {
        if (!result) return;
        // Always same-tab CONFIRMED (Phase 4b P1 on #836): a non-null result
        // here is Firebase's own per-tab record of THIS Auth instance's most
        // recent signInWithRedirect() call — a different tab that never
        // called it only ever sees its own null, regardless of the
        // origin-wide durable record's state.
        completeRedirectReturn(result.user, true);
      })
      .catch((err: unknown) => {
        // A genuine getRedirectResult rejection is a terminal outcome for
        // this attempt — but ONLY if signal (b) has not already claimed it a
        // SUCCESS (Codex P2 round 2 on #836): onAuthStateChanged can publish
        // the restored user, via the cached `pending` value above, before
        // this rejection is even caught (Firebase's own getRedirectResult()
        // throwing does not mean the session it restored failed to land).
        // Sharing `redirectCompletionLatchRef` with `completeRedirectReturn`
        // keeps the two outcomes mutually exclusive in EITHER firing order —
        // whichever lands first wins, and the other becomes a no-op, so a
        // single attempt can never report both `login_failed` and `login`.
        //
        // Gated on `appOwnedRedirect`, NOT `pending` (Codex P2 on the merged
        // HEAD — the round after the round-2 fix this comment used to
        // describe): the marker proves THIS rejection belongs to THIS app's
        // own redirect attempt, so it is safe to treat as definitively dead
        // and clear both durable records below. When the marker is lost but
        // the durable record still stands, this rejection is NOT proof of
        // failure — it is exactly the "Firebase's own helper threw, but the
        // session it restored is still landing" case signal (b) exists to
        // rescue (#346) — so clearing here would be premature. If THIS mount
        // then reloads/crashes before onAuthStateChanged ever fires (signal
        // (b) never gets its chance), a cleared record would leave the NEXT
        // mount with nothing to recover from — the exact regression the
        // round-1 fix closed for the "mount merely read it" case, reopened
        // here for the "mount saw an inconclusive rejection" case. Left
        // standing, it simply expires on its own TTL if truly abandoned.
        if (appOwnedRedirect) {
          if (!redirectCompletionLatchRef.current) {
            redirectCompletionLatchRef.current = true;
            trackSignInFailure(err);
          }
          clearRedirectPending();
          clearCollectedAcknowledgement();
        }
      })
      .finally(() => {
        // The app-owned redirect return has settled — release the signed-out
        // handoff paths (#357). Ref and state flip together: the ref is what the
        // handoff chokepoint reads synchronously; the state re-arms the timer.
        if (redirectReturnPendingRef.current) {
          redirectReturnPendingRef.current = false;
          setRedirectReturnPending(false);
        }
      });
  }, [completeRedirectReturn, consumeRedirectContextOnce]);

  const signIn = useCallback((acknowledgedAdultContent: boolean): Promise<void> => {
    if (signInAttemptRef.current) return signInAttemptRef.current;

    // Captured from SignIn's actual checkbox state BEFORE any auth transaction
    // starts, and threaded through both paths. The mutable Event posture answers
    // whether a box is needed now; it cannot prove one was shown and ticked on
    // the render whose button the player pressed.
    const acknowledged = acknowledgedAdultContent === true;

    const attempt = (async () => {
      if (onFallbackAuthOrigin) {
        // A signed-out fallback-origin visitor never starts an auth transaction
        // here — delegate to the shared chokepoint so its started-once dedupe
        // and pending-redirect-return guard cover the tap path too (#354): a
        // raw replace() here could re-navigate after the auth-settled or timer
        // handoff already fired. replace() (inside the chokepoint) avoids
        // leaving a signed-out origin-scoped session as the Back target. When
        // suppressed (handoff already started, or a redirect return is
        // completing), the tap is a no-op and the chokepoint's owner — the
        // in-flight navigation or the re-armed settle timer — finishes the job.
        handoffSignedOutWebApp();
        return;
      }
      const sameOriginHandler = auth.config?.authDomain === window.location.hostname;
      if (sameOriginHandler && shouldRedirectSignIn(window.navigator, isStandaloneApp())) {
        // One top-level redirect keeps the browser on a single origin so the
        // helper's sessionStorage survives the Google round-trip — the flow the
        // mobile tab and the installed desktop PWA (#395) both need. See
        // shouldRedirectSignIn; the popup path below still serves desktop browser
        // tabs and installed iOS PWAs.
        // A failed or abandoned prior attempt must not authorize this one.
        // Clear first, then write only the acknowledgement collected for this
        // exact redirect transaction.
        clearCollectedAcknowledgement();
        markPendingRedirectAttestation();
        // The durable #346 signal (b) companion to the marker above — written
        // alongside it, in the same store as the acknowledgement record, for
        // the same reason: it must survive the partitioning that can drop the
        // sessionStorage marker across this exact round trip.
        markRedirectPending();
        // Recorded only when the box was actually shown and ticked; the return
        // path reads THIS, never the posture as it stands on return.
        if (acknowledged) markCollectedAcknowledgement();
        try {
          await signInWithRedirect(auth, googleProvider);
        } catch (err) {
          // A failed START (signInWithRedirect rejects before navigating away)
          // is a terminal outcome for this attempt — clear every record it
          // wrote so it cannot be mistaken for an in-flight redirect by a
          // later attempt on this same, still-live page.
          consumePendingRedirectAttestation();
          clearCollectedAcknowledgement();
          clearRedirectPending();
          trackSignInFailure(err);
          throw err;
        }
        return;
      }

      try {
        await signInWithPopup(auth, googleProvider);
      } catch (err) {
        // Sign-in failures were invisible in analytics (#163): track('login') only
        // fires on success, and the storage-partition handler error (#161) renders
        // on the OAuth handler's own origin, which PostHog never loads. Emit an
        // explicit failure event carrying the Firebase error code so popup-path
        // breakage (blocked popup, account-exists, network) is at least observable.
        // Rethrow to preserve the prior contract — the caller (SignIn.tsx) surfaces
        // the error. NOTE: the in-app-webview redirect fallback unloads the app
        // before this catch can run, so it won't capture that path — the funnel
        // (sign-in pageviews vs `login`) remains the signal there (#162/#163).
        trackSignInFailure(err);
        throw err;
      }
      track('login', { method: 'google' });
      // The 18+ checkbox gated this sign-in (SignIn.tsx), so signing in IS the
      // attestation — persist it now that we have a uid, so a first-time User is not
      // re-prompted for the box they just ticked (#23).
      //
      // …UNLESS no acknowledgement was collected (#608, tightened by Phase 4b
      // round 4). `attestedAdultAt` is a cross-Event record on the global
      // `users/{uid}` document, and on an Event with no adult content SignIn
      // renders no checkbox at all — so writing the stamp would fabricate a
      // self-attestation the Player never made and carry it to every other Event
      // they join. `acknowledged` is captured at the START of this attempt, not
      // re-read here: a popup can stay open while an admin approves the first
      // explicit Prompt, and the posture that governs what the player agreed to
      // is the one that was on their screen.
      if (acknowledged) await attest();
    })();

    signInAttemptRef.current = attempt;
    void attempt
      .finally(() => {
        if (signInAttemptRef.current === attempt) signInAttemptRef.current = null;
      })
      .catch(() => {});
    return attempt;
  }, [attest, handoffSignedOutWebApp, onFallbackAuthOrigin]);

  const signOutUser = async () => {
    await signOut(auth);
  };

  // Re-prompt a signed-in User whose SETTLED profile lacks the 18+ attestation,
  // before they reach the Board (#23) — full-screen, mirroring the signed-out
  // SignIn gate App renders on `!user`. Gated on profileReady so a still-loading
  // bootstrap (attestation UNKNOWN) never flashes the prompt. `SignIn` reads
  // `user` from context to render its re-prompt mode.
  //
  // …and gated FIRST on whether this Event asks at all (#608). This is the whole
  // retroactive path the dynamic posture needs, and it needs no new surface: an
  // Event that turns 18+ mid-flight (an admin approves the first explicit Prompt)
  // flips `hostnames/{host}.adultContent`, the next resolution installs `true`,
  // and this one condition re-gates every un-attested Player through the
  // re-prompt that already exists.
  const needsAttestation = attestationRequired && user != null && profileReady && attested === false;
  // Event content may render once the age gate is settled — or once it is
  // established that this Event has no age gate and the profile bootstrap has
  // landed. `profileReady` rather than a bare `user != null` keeps the durable
  // card fallback from painting before the bootstrap it is meant to follow.
  const canRenderEventContent =
    user != null && (attestationRequired ? attested === true : profileReady);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        profileReady,
        needsAttestation,
        canRenderEventContent,
        dealError,
        dealErrorReason,
        dealing,
        signInReady: true,
        signIn,
        signOutUser,
        attest,
        retryDeal,
      }}
    >
      {/* The confirm-path Moment emitter (#41) mounts for ANY signed-in user,
          BESIDE the attestation gate rather than inside `children` — so an admin
          confirming an admin_confirmed Claim while the player sits on the
          attestation prompt still fires the win's Moment (Codex #116 R3 finding 2):
          the listener observes the Claim pending in-session and survives the gate,
          instead of unmounting and baselining the confirm as history after the
          player attests. Its uid-keyed module state (getConfirmState) also carries
          any parked ceremony across the remount. Renders nothing; scoped to the
          mount location only — the attestation gate itself is #117's surface. */}
      {/* Keeps the 18+ posture current while a tab stays open (Phase 4b P1).
          Deliberately NOT gated on `user`, unlike the watchers below it: the
          posture decides what the SIGNED-OUT gate renders. */}
      <AdultContentWatcher />
      {user && <ConfirmWinMoments />}
      {/* The retraction-path fall observer (#479) mounts at the SAME shell spot
          and for the same reason: a published win can stop standing while Board
          is unmounted (a proof deleted from the Feed tab, an admin rejecting a
          confirmed claim), and Board's remount would baseline the fall away.
          Renders nothing; all irreversibility gates live in src/data/moments.ts
          (createRetractionFallObserver). */}
      {user && <RetractWinMoments />}
      {/* The pool-recovery auto-retry watcher (#70), mounted HERE — above the tab
          Router, beside the attestation gate — for the same reason ConfirmWinMoments
          is: it must survive the exact recovery path. The Card-route DealError panel
          UNMOUNTS when the Player navigates to /items to add Prompts, so a watcher
          living there dies mid-recovery (PR #66 finding 3542374455). Mounted at the
          shell it observes the whole below-floor → above-floor journey. It only opens
          a pool subscription while a pool-shortfall deal error is up (it renders null
          otherwise), and fires the SAME retryDeal a manual Retry does — so it inherits
          #117's online && attestedAuthoritative deal gate rather than re-deriving it. */}
      {user && <PoolRecoveryWatcher />}
      {needsAttestation ? <SignIn /> : children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
