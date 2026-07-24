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
import { firebaseAuthOriginRedirectUrl } from '../canonical-redirect';
import SignIn from '../components/SignIn';
import ConfirmWinMoments from '../components/ConfirmWinMoments';
import PoolRecoveryWatcher from '../components/PoolRecoveryWatcher';

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
  signIn: () => Promise<void>;
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
  const [redirectReturnPending, setRedirectReturnPending] = useState(peekPendingRedirectAttestation);
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
    // Three-way (#434, Codex #438): a PERMANENT rules/schema/permission or
    // unknown-coded failure is NOT 'connection' — reconnecting cannot fix it, so
    // it must always surface the error rather than let App swap in a cached card.
    // Mirrors the #403 swallow, which likewise refuses to hide a permanent failure
    // behind a Firestore-cached board.
    setDealErrorReason(
      isPoolShortfall(err) ? 'pool-shortfall' : isTransientDealError(err) ? 'connection' : 'permanent',
    );
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
    let attestedRead: boolean | undefined;
    let bootstrapFailure: { err: unknown } | null = null;
    try {
      attestedRead = await withTimeout(
        (async () => {
          await ensureUserProfile(u);
          // SERVER-ONLY authority read (Codex #117 round 6): getDocFromServer, NOT the
          // cache-capable getDoc — a stamp served from cache must never authorize a
          // deal. It REJECTS when the server is actually unreachable (a flaky reconnect
          // where navigator.onLine is true but there is no route), which falls into the
          // catch below → authority NOT established, no deal, deferred to reconnect.
          return (await readAdultAttestationFromServer(u.uid)) !== null;
        })(),
        AUTH_BOOTSTRAP_TIMEOUT_MS,
      );
    } catch (err) {
      bootstrapFailure = { err };
    }
    if (profileAttemptRef.current !== attempt) return;
    // OPTIMISTIC-UI vs DURABLE-AUTHORITY (round 7): the optimistic sticky only keeps
    // the UI attested (no re-prompt); ONLY a COMMITTED same-session attest grants
    // deal authority when the server read cannot.
    const optimisticSticky = attestedUidsRef.current.has(u.uid);
    const committedSticky = attestCommittedUidsRef.current.has(u.uid);
    if (bootstrapFailure) {
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
        setAttested(true);
        const failure = bootstrapFailure.err;
        void hasCachedBoard(u.uid).then((boarded) => {
          if (profileAttemptRef.current === attempt && !boarded) {
            failDeal(failure);
          }
        });
      } else {
        failDeal(bootstrapFailure.err);
      }
    } else {
      // Authoritative read SETTLED. UI: the server stamp, or an optimistic attest
      // (don't re-prompt on a not-yet-visible write). AUTHORITY: the server stamp,
      // or a COMMITTED same-session attest — NEVER an optimistic pre-commit lift
      // (round 7). A definite server-null with no attest downgrades to a re-prompt
      // (finding D).
      setAttested(attestedRead || optimisticSticky);
      if (attestedRead || committedSticky) setAttestedAuthoritative(true);
      // An authoritative settle SUPERSEDES any stale dealError (round 4 audit): on
      // reconnect this clears an error left by a prior offline/failed attempt so the
      // Board (or re-prompt) renders, not the stale panel. A confirmed-attested User
      // then deals, and a genuine re-deal failure re-sets dealError from runDeal.
      clearDealError();
    }
    setProfileReady(true);
    // Online gate resolved — release the "Loading…" hold and render (finding B).
    setLoading(false);
  }, [failDeal, clearDealError]);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      // Auth changed: retire the previous account's in-flight deal/bootstrap and
      // clear its stale state so a late result can't clobber the incoming User (P2).
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
      () => {
        if (dealAttemptRef.current === attempt) clearDealError();
      },
      () => {},
    );
    try {
      const dealt = await withTimeout(dealPromise, DEAL_TIMEOUT_MS, 'Deal timed out');
      if (dealAttemptRef.current !== attempt) return;
      clearDealError();
      // Record `join_event` ONLY on an actual join — a NEW board (Codex #117 round
      // 8, finding B). runDeal re-fires on every online/authority flip, and
      // joinAndDeal no-ops (returns false) for an already-boarded Player, so a
      // ship-wifi reconnect must record nothing rather than inflate join analytics.
      if (dealt) track('join_event');
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
      }
      failDeal(err);
    } finally {
      if (dealAttemptRef.current === attempt) setDealing(false);
    }
  }, [failDeal, clearDealError]);

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
  useEffect(() => {
    if (user && attested === true && attestedAuthoritative && online) void runDeal(user);
  }, [user, attested, attestedAuthoritative, online, runDeal]);

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
    try {
      const read = await withTimeout(
        (async () => {
          await ensureUserProfile(u);
          // SERVER-ONLY authority read (round 6), same as bootstrapUser — a retry must
          // not authorize a deal from a cache-served getDoc either.
          return (await readAdultAttestationFromServer(u.uid)) !== null;
        })(),
        AUTH_BOOTSTRAP_TIMEOUT_MS,
      );
      if (profileAttemptRef.current !== attempt) return;
      const optimisticSticky = attestedUidsRef.current.has(u.uid);
      const committedSticky = attestCommittedUidsRef.current.has(u.uid);
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
        clearDealError();
        setDealing(false);
      }
    } catch (err) {
      if (profileAttemptRef.current !== attempt) return;
      failDeal(err);
      setDealing(false);
    }
  }, [failDeal, clearDealError]);

  // Retry the current User's path to a dealt Board, in place (no reload). The
  // manual retry must honor the SAME write-safety gate as the automatic deal
  // effect (Codex #117 round 3, finding A): deal ONLY when online AND the
  // attestation is AUTHORITATIVE (server-settled or same-session attest) AND
  // `attested === true`. Otherwise — offline, or on a merely PROVISIONAL cached
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
    } else if (attestedAuthoritative && attested === true) {
      // Online + authoritative → re-deal in place.
      void runDeal(user);
    } else {
      // Online but not yet authoritative → re-run the full transaction bootstrap.
      void retryBootstrap(user);
    }
  }, [user, attestedAuthoritative, attested, runDeal, retryBootstrap, bootstrapUser]);

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

  // A top-level redirect reloads the app, so finish the Firebase transaction on
  // mount and complete the acknowledgement that gated the original sign-in tap.
  // The marker is same-origin session state and is consumed exactly once — but
  // completion does NOT require it (#346): Safari can drop sessionStorage
  // across the provider round-trip while Firebase still restores the session,
  // and gating on the marker skipped the redirect `login` event and the checked
  // 18+ attestation exactly then. getRedirectResult is the bounded secondary
  // completion signal: it settles once per mount, nothing render-critical
  // awaits it, and it resolves non-null ONLY on an actual redirect return —
  // never on an ordinary mount — so it cannot emit phantom `login` events. And
  // signIn() is the only initiator of signInWithRedirect, always behind the
  // checked 18+ box, so a non-null result is itself proof the acknowledgement
  // happened. The marker still scopes FAILURE reporting: a rejection becomes
  // `login_failed` only when the marker proves an app-owned redirect was in
  // flight — a marker-less rejection on an ordinary mount (e.g. partitioned
  // helper storage) stays out of analytics.
  useEffect(() => {
    if (redirectResultHandledRef.current) return;
    redirectResultHandledRef.current = true;
    const appOwnedRedirect = consumePendingRedirectAttestation();

    void getRedirectResult(auth)
      .then(async (result) => {
        if (!result) return;
        track('login', { method: 'google' });
        await persistAttestation(result.user);
      })
      .catch((err: unknown) => {
        if (appOwnedRedirect) trackSignInFailure(err);
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
  }, [persistAttestation]);

  const signIn = useCallback((): Promise<void> => {
    if (signInAttemptRef.current) return signInAttemptRef.current;

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
        markPendingRedirectAttestation();
        try {
          await signInWithRedirect(auth, googleProvider);
        } catch (err) {
          consumePendingRedirectAttestation();
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
      await attest();
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
  const needsAttestation = user != null && profileReady && attested === false;
  const canRenderEventContent = user != null && attested === true;

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
      {user && <ConfirmWinMoments />}
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
