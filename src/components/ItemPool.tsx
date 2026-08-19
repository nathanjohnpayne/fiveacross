import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useItems, useMyPendingItems, useMyActiveItems, useEventDoc } from '../hooks/useData';
import { addItem, checkItemRateLimit, itemRateLimitRemainingMs, reportItem } from '../data/api';
import { useNextUnlockClock } from '../hooks/useNextUnlockClock';
import {
  loadTrackedSuggestions,
  trackSuggestion,
  deriveMySubmissions,
  refreshLastKnownStatuses,
  type MySubmissionStatus,
  type TrackedSuggestion,
} from '../data/mySuggestions';
import { track } from '../analytics';
import LoadingState from './LoadingState';
import { editionBrand } from '../editions';
import { useAdultContent } from '../hooks/useAdultContent';
import { EVENT_ID } from '../firebase';

// Pre-sail framing (ADR 0003): a Board freezes the moment a Player joins, so
// a Prompt added afterward can never land on THAT Player's own card — it only
// ever joins the pool for a FUTURE deal. Mid-cruise adds are allowed (and
// still take effect for late joiners / future Events); they are just mostly
// inert on cards already dealt, which is expected, not a bug.
// Whole-string per Edition (#608): the DEADLINE is the cruise-coded part
// ("before we sail"), and it has no neutral token — a general Event's deadline
// is the first deal, not a departure.
const presailNote = (): string => editionBrand().promptDeadlineNote;

// Phase 1.5 approval flow (#210, daily-cards-spec § "Item pools and the approval
// flow"): a companion caption to `presailNote`, not a replacement — that one
// explains freeze-on-deal, this one explains the NEW admin-review gate a
// submission passes through before it can ever be dealt.
const APPROVAL_NOTE = "New prompts go to admin review before they join the pool—yours will show here as “pending review” until then.";

// Phase 0 client-side throttle copy — see `checkItemRateLimit` in
// `../data/api` for why this is presentational only, not a security boundary.
const ADD_THROTTLE_MESSAGE = 'Slow down—you can add another prompt in a few seconds.';
const REPORT_THROTTLE_MESSAGE = 'Slow down—you can report again in a few seconds.';

// How long a submission that just vacated the live pending query, with no
// active arrival yet, keeps reporting "pending" instead of falling through
// to `deriveMySubmissions`' `not_selected` default (#559, Codex P2, PR #845
// round 8). Generous enough to absorb realistic skew between the
// `useMyPendingItems`/`useMyActiveItems` listeners for the SAME underlying
// approval write — they ride the same watch stream, so in practice this
// resolves in well under a second — without leaving a genuinely rejected
// submission looking like it is still under review for long.
export const APPROVAL_GRACE_MS = 5000;

/**
 * Ids present in `prevPendingIds` but absent from BOTH `currentPendingIds`
 * and `activeIds` — a submission whose pending row just disappeared with no
 * active arrival YET. Pulled out as a pure, exported function (#862) so the
 * "which ids need a grace window" computation is directly unit-testable
 * without exercising React's render/effect ordering at all.
 */
export function vacatedPendingIds(
  prevPendingIds: ReadonlySet<string>,
  currentPendingIds: ReadonlySet<string>,
  activeIds: ReadonlySet<string>,
): string[] {
  return [...prevPendingIds].filter((id) => !currentPendingIds.has(id) && !activeIds.has(id));
}

// First-time 🔞 explainer (#610) — the PLAYER half of the ticket, and
// deliberately an EXPLAINER, not a confirm. A player's tick is a request:
// their submission lands `status: 'pending'` (#210) and the #608 derivation
// only counts `status: 'active'`, so nothing about the Event's posture changes
// until an admin approves it — the consequential-action confirm lives on THAT
// flip (`admin/AdultContentConfirm`), not here. This sheet just tells a
// first-time tagger what the tag means, once per Event, and never gates the
// checkbox itself.
//
// Event-keyed localStorage, the established one-time-explainer pattern
// (`gcb.coachOverlay.${eventId}.dismissedAt`, `gcb.seen.reshuffleIntro`).
// try/catch falls OPEN — private-mode/storage-unavailable shows the explainer
// on every tick rather than never: annoying beats invisible, the same
// direction CoachOverlay and LaunchIntro take.
const explicitTagSeenKey = (eventId: string): string => `gcb.seen.explicitTag.${eventId}`;
function hasSeenExplicitTag(eventId: string): boolean {
  try {
    return localStorage.getItem(explicitTagSeenKey(eventId)) !== null;
  } catch {
    return false;
  }
}
function markExplicitTagSeen(eventId: string): void {
  try {
    localStorage.setItem(explicitTagSeenKey(eventId), String(Date.now()));
  } catch {
    /* nothing to persist */
  }
}

// Submitter-state pill copy (#559 acceptance: "the submitter sees pending /
// approved / scheduled / not selected"). `scheduled` names the Day so the
// promise reads concretely ("Day 3") rather than as a bare status word.
const SUBMISSION_STATUS_LABEL: Record<MySubmissionStatus, string> = {
  pending: 'pending review',
  scheduled: 'scheduled',
  approved: 'approved',
  not_selected: 'not selected',
};

export default function ItemPool() {
  const { user } = useAuth();
  const { items, loading } = useItems();
  // The 🔞 tag is a CATEGORY within an adults-only pool, not a warning label
  // (#608): on an Event with no adult content there is nothing to categorise,
  // so the control is hidden rather than shown-and-inert. `spicy` then stays
  // false on every submission, which is what the derivation reads.
  const adult = useAdultContent();
  // The submitter's own pending submissions (#210): `useItems` reads only
  // `status == 'active'`, so a fresh `pending` add would otherwise vanish from
  // this list the instant it lands. `deriveMySubmissions` below unions this
  // LIVE, cross-device query with the local tracker for the follow-up states.
  const { items: myPending, hasServerData: pendingServerReady } = useMyPendingItems(user?.uid);
  // The submitter's own ACTIVE submissions (#559, Codex P2 round 2, PR #845):
  // its OWN unfiltered query, not a client-side filter of `useItems()`'s
  // public pool — see `useMyActiveItems`'s own doc comment for why the public
  // pool's presentational hides (report threshold, adult-content posture, a
  // since-banned author) must never make a genuinely `active` submission of
  // the submitter's OWN read as `'not_selected'`.
  const { items: activeMine, hasServerData: activeServerReady } = useMyActiveItems(user?.uid);
  // The Day schedule, for `submitterStatus`'s "is the promised Day still
  // open" check (#559) — the SAME `useEventDoc` subscription every other
  // schedule-reading surface (Board, More) already holds; no new read.
  const { data: event } = useEventDoc();
  const days = event?.days ?? [];
  // This device's own submission history (#559) — see src/data/mySuggestions.ts
  // for why a rejected row can't just be READ back. Reloaded whenever the
  // signed-in uid changes (account switch on a shared device). Keyed on the
  // PRIMITIVE `user?.uid`, not the `user` object itself: `useAuth()` is not
  // guaranteed to return a referentially-stable object on every render (a
  // caller-supplied stand-in — e.g. an `useAuth: () => ({ user: {...}, ... })`
  // test double with no memoization — can hand back a fresh object every
  // call), and depending on the whole object here would re-run this effect,
  // and re-`setTracked`, on EVERY render, forever.
  const uid = user?.uid;
  // Latest-uid ref (#861): `add`'s async continuation below closes over
  // whichever `user` was signed in when the SUBMIT happened, which is
  // correct for the Firestore write and for keying `trackSuggestion`'s
  // localStorage entry — both must stay attributed to the uid that actually
  // submitted. But `setTracked` below updates SHARED component state, and if
  // auth changes (sign-out/sign-in as a different account on a shared
  // device) while the write is still pending, the account-switch effect just
  // below has already reset `tracked` to the NEW uid's own history by the
  // time the OLD request resolves — so an unguarded `setTracked` would
  // splice the old account's submission into the new account's on-screen
  // list, even though it was persisted correctly under the old uid. Reading
  // this ref (updated after every commit, so it always reflects the LATEST
  // rendered uid) lets the continuation skip that specific state update
  // without needing to skip the (correctly-attributed) Firestore write or
  // localStorage persist.
  const uidRef = useRef(uid);
  // `useLayoutEffect`, not a raw render-phase write (Codex P1, PR #890
  // round 4, correcting round 2's own "fix"). Round 2 tried assigning this
  // ref UNCONDITIONALLY in the render body, reasoning that the render phase
  // always runs before any effect could — true, but that reasoning proves
  // too much: React can START a render (running this line) and then
  // INTERRUPT or ABANDON it without ever committing, and a raw ref mutation
  // is not part of React's reconciliation — it is not rolled back when that
  // happens, unlike a `setState` call. A layout effect only ever runs for a
  // render that ACTUALLY commits, which is the correctness property this
  // ref needs; round 2's own concern (a same-tick microtask observing a
  // stale ref before this effect gets a turn to run) is real but narrower
  // in consequence than it first appears, because `uidRef` is no longer the
  // ONLY thing guarding account-owned state: `tracked` below and the
  // compose fields above are BOTH reset via a render-phase `setState` call
  // (safe from the abandoned-render problem, since React manages that
  // rollback) keyed on `uid` itself, not on this ref — so even a
  // momentarily-stale `uidRef` cannot make stale data survive into what
  // actually renders for the new account; the ref's remaining job (skipping
  // a stale `setTracked`/`setText`/analytics call from an old completion)
  // is a belt-and-suspenders layer on top of that, not the sole guarantee.
  useLayoutEffect(() => {
    uidRef.current = uid;
  }, [uid]);
  const [tracked, setTracked] = useState<TrackedSuggestion[]>([]);
  // Loaded on the uid TRANSITION itself, DURING RENDER — not in a passive
  // `useEffect` (CodeRabbit, PR #890 round 2, re-verifying round 2's OWN
  // fix: a passive effect here has the exact same gap `uidRef` and the
  // compose-state reset just above document — the new account's render can
  // still commit (and be found in the DOM) showing the OLD account's
  // `tracked` rows before that effect ever runs). `loadTrackedSuggestions`
  // is a plain synchronous `localStorage` READ (no network, no promise), so
  // it is safe to call directly in the render body — the same "adjusting
  // state when a prop changes" pattern already used for `composeResetForUid`
  // just below and for `issuesShownForStep` in WizardChrome.tsx.
  const [trackedLoadedForUid, setTrackedLoadedForUid] = useState<string | undefined>(undefined);
  if (uid !== trackedLoadedForUid) {
    setTrackedLoadedForUid(uid);
    setTracked(uid ? loadTrackedSuggestions(EVENT_ID, uid) : []);
  }
  // The previous render's `myPending` ids (#559, Codex P2, PR #845 rounds 8
  // + 9) — see the `graceIds` effect below, just above where this is read.
  const prevPendingIdsRef = useRef<ReadonlySet<string>>(new Set());
  // Ids currently within their post-pending grace window (#559, Codex P2,
  // PR #845 round 8), and the live timer that will expire each one. Real
  // STATE, not a ref (Codex P2, PR #845 round 9): round 8's first cut kept
  // this in a plain ref and relied on "some later render" to notice the
  // window had passed — but mutating a ref never itself schedules a
  // re-render, so a submission that is genuinely REJECTED (no active
  // snapshot ever arriving to trigger one) had nothing left to trigger that
  // later render at all, and could keep showing "pending review" forever.
  // `setGraceIds` on the timer's own fire is what guarantees the window
  // actually closes on its own.
  const [graceIds, setGraceIds] = useState<ReadonlySet<string>>(new Set());
  const graceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // A ticking clock (#559, Codex P2 round 2, PR #845), shared with
  // Board.tsx/ProofFeed.tsx's identical need (Codex P2, PR #845 round 5 —
  // extracted into one hook after the same unclamped-timer overflow bug,
  // round 4 P1, turned up in all three hand-copies): without it, a panel
  // left open across the submission's target Day's `unlockAt` keeps
  // reporting `'scheduled'` off a stale `Date.now()` until some UNRELATED
  // render happens to fire.
  const now = useNextUnlockClock(event?.days);
  // Persist each tracked entry's last-observed-active status (#559, Codex P2,
  // PR #845 round 7): once a submission is actually SEEN in `activeMine`,
  // remember its status/target so a LATER render where it's transiently
  // absent (an admin approving mid-session — the pending and active
  // listeners update independently) or permanently absent (an admin
  // hard-hiding it after approval, which is unreadable to the submitter same
  // as a rejection) keeps reporting that last-known state instead of
  // flashing/settling into a false "not selected" — see
  // `deriveMySubmissions`'s own doc comment. `refreshLastKnownStatuses`
  // returns the SAME array reference when nothing changed, so this only
  // writes when a tracked entry's observed status genuinely moved.
  useEffect(() => {
    const refreshed = refreshLastKnownStatuses(tracked, activeMine, days, now);
    if (refreshed === tracked || !uid) return;
    for (let i = 0; i < refreshed.length; i++) {
      if (refreshed[i] !== tracked[i]) trackSuggestion(EVENT_ID, uid, refreshed[i]);
    }
    setTracked([...refreshed]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `days` derives from `event?.days ?? []` (a fresh [] literal each render); this effect's own `setTracked` is what re-evaluates it on every genuine change to `tracked`/`activeMine`/`now`, matching the established pattern elsewhere in this file.
  }, [tracked, activeMine, now, uid]);
  // `ready` (#559, Codex P2 rounds 1 + 2): BOTH live queries must have
  // delivered a SERVER-CONFIRMED snapshot — not merely cleared `loading` —
  // before an absent tracked id can honestly mean "not selected". `loading`
  // alone clears on an empty CACHE-only snapshot too (an offline or cold
  // start), which would have let a genuinely still-pending or still-active
  // submission read as `not_selected` while offline — see
  // `deriveMySubmissions`'s own doc comment for the flash this prevents.
  //
  // A bounded grace window for the FIRST-time approval race (#559, Codex P2,
  // PR #845 rounds 8 + 9): `myPending`/`activeMine` are independent
  // listeners, so the pending-removal snapshot can land before the
  // active-addition snapshot — for a submission this device has NEVER
  // before seen active (round 7's `lastKnownStatus` cache is still unset),
  // that overlap would otherwise read `'not_selected'` the instant the
  // pending listener fires. An id that just vacated `myPending` without yet
  // appearing in `activeMine` enters `graceIds` and gets a real
  // `APPROVAL_GRACE_MS` timer (round 9 — a PLAIN ref-diff with no timer, the
  // round-8 cut, relied on some LATER render to notice the window had
  // passed; mutating a ref never schedules one, so a genuine rejection, with
  // no active arrival ever coming to trigger a re-render, could keep
  // reporting "pending review" forever). The timer's own `setGraceIds` fire
  // is what guarantees the window closes on its own; the second effect below
  // clears it EARLIER, the moment the id actually resolves active, so a fast
  // approval does not have to wait out the full window.
  // `useLayoutEffect`, not `useEffect` (#862): `deriveMySubmissions` below
  // runs during THIS component's own render, reading `graceIds` STATE — but
  // a passive effect only runs AFTER the browser has already had a chance to
  // paint the commit that just happened. So on the exact render where the
  // pending listener's removal snapshot lands (with the active listener's
  // addition not yet arrived), a passive effect would let React commit AND
  // the browser potentially PAINT a `'not_selected'` render before this
  // effect ever runs to add the id to `graceIds` and correct it — the exact
  // false-rejection flash the grace window exists to prevent, arriving one
  // render late via the effect itself. A layout effect runs SYNCHRONOUSLY
  // after the commit but BEFORE the browser paints, so the `setGraceIds`
  // call below still lands (and re-renders/re-commits) before anything is
  // ever shown to the player — the correction never becomes visible.
  useLayoutEffect(() => {
    const currentPendingIds = new Set(myPending.map((it) => it.id));
    const activeIds = new Set(activeMine.map((it) => it.id));
    const vacated = vacatedPendingIds(prevPendingIdsRef.current, currentPendingIds, activeIds);
    prevPendingIdsRef.current = currentPendingIds;
    if (vacated.length === 0) return;
    setGraceIds((prev) => {
      const next = new Set(prev);
      for (const id of vacated) next.add(id);
      return next;
    });
    for (const id of vacated) {
      if (graceTimersRef.current.has(id)) continue;
      const timer = setTimeout(() => {
        graceTimersRef.current.delete(id);
        setGraceIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, APPROVAL_GRACE_MS);
      graceTimersRef.current.set(id, timer);
    }
  }, [myPending, activeMine]);
  useEffect(() => {
    if (graceIds.size === 0) return;
    const activeIds = new Set(activeMine.map((it) => it.id));
    const resolved = [...graceIds].filter((id) => activeIds.has(id));
    if (resolved.length === 0) return;
    setGraceIds((prev) => {
      const next = new Set(prev);
      for (const id of resolved) {
        next.delete(id);
        const timer = graceTimersRef.current.get(id);
        if (timer) {
          clearTimeout(timer);
          graceTimersRef.current.delete(id);
        }
      }
      return next;
    });
  }, [activeMine, graceIds]);
  useEffect(
    () => () => {
      for (const timer of graceTimersRef.current.values()) clearTimeout(timer);
    },
    [],
  );
  const mySubmissions = deriveMySubmissions(
    tracked,
    myPending,
    activeMine,
    days,
    now,
    pendingServerReady && activeServerReady,
    graceIds,
  );
  // Every id `mySubmissions` already renders WITH a status pill (#559, Codex
  // P2) — excluded here so the plain pool list below never shows the SAME
  // Prompt a second time with no status at all.
  const mySubmissionIds = new Set(mySubmissions.map((s) => s.id));
  const poolItems = items.filter((it) => !mySubmissionIds.has(it.id));
  const [text, setText] = useState('');
  const [spicy, setSpicy] = useState(false);
  // Reset on the uid TRANSITION itself (#861 round 2, Codex P1): guarding
  // the OLD account's completion from clearing this state (CodeRabbit,
  // round 1) is not sufficient on its own. If the NEW account never types
  // anything before that guarded completion is skipped, the OLD account's
  // half-typed text — and its `spicy` flag, which decides whether the
  // submission is tagged explicit — would otherwise sit in the compose box
  // INDEFINITELY: visible to, and tappable/submittable by, the new account
  // with no edit of their own.
  //
  // Compared and reset DURING RENDER — React's documented "adjusting state
  // when a prop changes" pattern, the SAME one WizardChrome.tsx's
  // `issuesShownForStep` already uses in this codebase — not in ANY effect,
  // not even `useLayoutEffect` (round 2's own first cut). `uidRef` above
  // has the full account of why an effect-based reset, layout or not, needs
  // React to actually get a turn to run it, which a render-phase update
  // does not: calling `setState` DURING rendering makes React re-render
  // again immediately, before committing anything, so the very FIRST commit
  // the new uid ever produces already has a blank compose box — with no
  // dependency on an effect ever running at all.
  const [composeResetForUid, setComposeResetForUid] = useState(uid);
  if (uid !== composeResetForUid) {
    setComposeResetForUid(uid);
    setText('');
    setSpicy(false);
  }
  // The first-time explainer (#610). State, not a render-time storage read:
  // it opens on the TICK (the moment of first use), not on mount — a player
  // who never touches the tag never sees it.
  const [showExplicitIntro, setShowExplicitIntro] = useState(false);
  const [addThrottled, setAddThrottled] = useState(false);
  const [reportThrottled, setReportThrottled] = useState(false);
  const addTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Un-throttle timers are real (not just presentational math) so the button
  // re-enables on its own once the window passes — clear them on unmount so a
  // throttled ItemPool that unmounts mid-window never calls setState after
  // unmount (tab switch away from Prompts while throttled).
  useEffect(
    () => () => {
      if (addTimer.current) clearTimeout(addTimer.current);
      if (reportTimer.current) clearTimeout(reportTimer.current);
    },
    [],
  );

  const add = async () => {
    if (!user || !text.trim()) return;
    // Captured now, not re-read after the `await` (#861): this closure keeps
    // whichever `user` was signed in when the submit happened, which is
    // correct for the Firestore write and the localStorage key below — both
    // must stay attributed to whoever actually submitted, regardless of who
    // is signed in by the time the write resolves.
    const submittingUid = user.uid;
    const now = Date.now();
    const key = `add:${submittingUid}`;
    if (!checkItemRateLimit(key, now)) {
      setAddThrottled(true);
      if (addTimer.current) clearTimeout(addTimer.current);
      // Arm for the ACTUAL time left on the guard's window (anchored to the
      // last SUCCESSFUL add), not a full re-armed ITEM_RATE_LIMIT_MS from
      // THIS blocked attempt — the latter would drift the control's re-enable
      // later than checkItemRateLimit itself expires (Codex P2, PR #92).
      addTimer.current = setTimeout(() => setAddThrottled(false), itemRateLimitRemainingMs(key, now));
      return;
    }
    try {
      const result = await addItem(submittingUid, text, adult && spicy);
      // Analytics attribution is ALSO guarded (#861 round 2, Codex P2):
      // firing unconditionally after the awaited write would attribute
      // whatever identity the analytics SDK is CURRENTLY identified as
      // (PostHog/GA4) to this event — if auth switched mid-flight, that is
      // the NEW account, not whoever actually submitted. Suppressing the
      // event when the identity has since changed is simpler and safer
      // than trying to override the SDK's ambient identity for one event,
      // and losing one event for this narrow timing overlap is a much
      // smaller cost than misattributing it.
      if (uidRef.current === submittingUid) {
        track('add_item');
        // `prompt_suggestion_submitted` (#559): NO Prompt text in the
        // payload — just whether a Day could be named. Reports the target
        // `addItem` itself ACTUALLY committed, never a client-recomputed
        // guess (Codex P2, PR #845): a stale/reloading schedule snapshot
        // here could disagree with what the write resolved against its OWN
        // fresh read, corrupting the analytics at exactly the schedule
        // boundaries it exists to measure.
        track('prompt_suggestion_submitted', {
          hasTargetDay: result?.targetDayIndex != null,
          ...(result?.targetDayIndex != null ? { dayIndex: result.targetDayIndex } : {}),
        });
      }
      if (result) {
        const submitted = { id: result.id, text: text.trim().slice(0, 80), submittedAt: Date.now() };
        // Persisted under the SUBMITTING uid regardless of who is current —
        // this write is always correct, auth change or not.
        trackSuggestion(EVENT_ID, submittingUid, submitted);
        // But the in-memory `tracked` STATE is shared, component-wide, and
        // the account-switch effect above already resets it the instant
        // `uid` changes. If auth changed while this write was in flight
        // (`uidRef.current` no longer matches `submittingUid`), that reset
        // has already happened for the NEW account, and splicing this
        // submission in here would insert the OLD account's row into the
        // NEW account's on-screen list — the exact leak #861 describes. Skip
        // the state update in that case; the persisted write above is
        // already correct and complete on its own.
        if (uidRef.current === submittingUid) {
          setTracked((prev) => [...prev.filter((s) => s.id !== submitted.id), submitted]);
        }
      }
      // Clearing the form is ALSO guarded (CodeRabbit, PR #890 round 1): the
      // OLD account's completion clearing `text`/`spicy` unconditionally
      // would erase whatever the NEW account already started typing after
      // the switch — the same leak #861 describes, just for the compose
      // fields instead of the tracked-submissions list. Only the account
      // that actually submitted gets to clear its own form.
      if (uidRef.current === submittingUid) {
        setText('');
        setSpicy(false);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const report = (id: string) => {
    if (!user) return;
    const now = Date.now();
    const key = `report:${user.uid}`;
    if (!checkItemRateLimit(key, now)) {
      setReportThrottled(true);
      if (reportTimer.current) clearTimeout(reportTimer.current);
      // Same real-remaining-time arming as `add` above, for the same reason.
      reportTimer.current = setTimeout(() => setReportThrottled(false), itemRateLimitRemainingMs(key, now));
      return;
    }
    reportItem(id).catch(console.error);
    track('report_item');
  };

  return (
    <div>
      {/* `data-unsaved-work` while a suggestion is half-typed (Codex P2 round 5,
          PR #720): it lives only in `text`, so an automatic post-deploy reload
          would eat it. See `midInteraction` in src/swClientBridge.ts.
          Trimmed, matching the Add button's own `disabled` predicate below
          (post-review #750/#755/#758): whitespace-only text is not something
          Add can commit or clear, so marking it as unsaved work would pin the
          tab to a condemned build with no way to release the marker. */}
      <div className="addbar" data-unsaved-work={text.trim() !== '' || undefined}>
        <input
          className="input"
          maxLength={80}
          placeholder="Add a prompt…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Gate Enter with the SAME `addThrottled` state the Add button's
            // `disabled` uses, so the keyboard path can never submit while
            // the UI is showing "throttled" — it now expires in lockstep
            // with the button instead of re-checking the guard on its own.
            if (e.key === 'Enter' && !addThrottled) add();
          }}
        />
        <button className="btn primary" onClick={add} disabled={!text.trim() || addThrottled}>
          Add
        </button>
        {adult && (
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={spicy}
              onChange={(e) => {
                const next = e.target.checked;
                // The tick lands regardless — this is an explainer over the
                // player's (reversible, non-consequential) choice, never a
                // gate in front of it. Only a CHECK can open it: unticking
                // needs no explanation.
                setSpicy(next);
                if (next && !hasSeenExplicitTag(EVENT_ID)) setShowExplicitIntro(true);
              }}
            />{' '}
            🔞 Spicy
          </label>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        {presailNote()} {items.length} in the pool.
      </p>
      <p className="muted" style={{ fontSize: 12 }}>
        {APPROVAL_NOTE}
      </p>
      {addThrottled && (
        <p className="muted" role="alert" style={{ fontSize: 12 }}>
          {ADD_THROTTLE_MESSAGE}
        </p>
      )}
      {loading ? (
        <LoadingState label="Fetching prompts…" />
      ) : (
        <div className="list">
          {poolItems.map((it) => (
            <div key={it.id} className="row">
              <div className="grow">
                <div className="name" style={{ fontWeight: 500 }}>
                  {it.text}
                </div>
              </div>
              <button
                className="iconbtn"
                title="Report"
                disabled={reportThrottled}
                onClick={() => report(it.id)}
              >
                ⚑
              </button>
            </div>
          ))}
          {/* Own submissions (#210, extended #559): visible ONLY to their
              submitter, never to other Players (mirrors the read rule's
              carve-out) — no Report control, since reporting your own Prompt
              is meaningless. `mySubmissions` carries every state the
              acceptance list names: pending / scheduled / approved / not
              selected (src/data/mySuggestions.ts). */}
          {mySubmissions.map((s) => (
            <div key={s.id} className="row">
              <div className="grow">
                <div className="name" style={{ fontWeight: 500 }}>
                  {s.text}
                  <span className={'pill' + (s.status === 'not_selected' ? ' pill-muted' : '')}>
                    {SUBMISSION_STATUS_LABEL[s.status]}
                    {s.status === 'scheduled' && typeof s.dayIndex === 'number' ? ` · Day ${s.dayIndex + 1}` : ''}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {reportThrottled && (
        <p className="muted" role="alert" style={{ fontSize: 12 }}>
          {REPORT_THROTTLE_MESSAGE}
        </p>
      )}
      {/* The same `.sheet`/`.sheet-backdrop` shell as CoachOverlay and
          LaunchIntro — the repo's one-time-explainer shape — with its own
          identity class (the LaunchIntro discipline: `.coach-overlay` is that
          overlay's IDENTITY, not a shared skin). One CTA, no cancel: there is
          nothing to cancel, the tick already landed and stays reversible.
          Copy carries no Edition-coded token, so it reads correctly in every
          register (#608) — the substance must not change between Editions. */}
      {showExplicitIntro && (
        <div className="sheet-backdrop explicit-tag-intro-backdrop">
          <div
            className="sheet explicit-tag-intro"
            role="dialog"
            aria-modal="true"
            aria-label="What the 🔞 tag does"
          >
            <p className="sheet-title">What the 🔞 tag does</p>
            <p>
              It marks a prompt as explicit. Explicit prompts only reach players who have confirmed
              they&rsquo;re 18 or older.
            </p>
            <p>
              An admin reviews every suggestion before it can be dealt&mdash;tagging it
              doesn&rsquo;t put it on anyone&rsquo;s card by itself.
            </p>
            <div className="sheet-actions">
              <button
                type="button"
                className="btn primary block"
                onClick={() => {
                  // Mark seen on DISMISS, not on open (the CoachOverlay
                  // pattern): a sheet the player never acknowledged — tab
                  // closed mid-read — shows again next time.
                  markExplicitTagSeen(EVENT_ID);
                  setShowExplicitIntro(false);
                }}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
