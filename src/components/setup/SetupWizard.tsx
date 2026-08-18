import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import type { EventDraft, SetupStep } from '../../types';
import { FALLBACK_PATH } from '../tabs';
import { createEventDraft, createLocalDraftStore, type EventDraftStore } from '../../data/eventDraft';
import { STEP_REGISTRY } from './stepRegistry';
import WizardChrome from './WizardChrome';
import CancelConfirmDialog from './CancelConfirmDialog';
import { isSetupIndex, setupRouteParams, setupStepPath } from './route';
import { SETUP_STEP_ORDER, draftHasContent, firstIncompleteStep, stepIndex } from './wizardSteps';
import LoadingState from '../LoadingState';

/**
 * The setup wizard's mount point (#788, specs/event-setup-wizard.md § "Shell
 * & navigation"). Route-level: owns the `EventDraftStore` and every
 * navigation decision. `App.tsx` mounts this at exactly one sibling
 * `<Route path="/setup/*">`, before the catch-all — everything below is this
 * component's own sub-navigation, parsed via `matchPath` (`./route.ts`)
 * rather than a nested `<Routes>` tree, mirroring `More.tsx`'s
 * `adminSectionFromPath` convention for a route-driven sub-surface.
 *
 * `/setup` (bare) always starts a FRESH draft. This is a deliberate,
 * revisitable choice, not an oversight: conflating "New event" with "resume
 * my last one" would silently hand an organizer someone else's — or their
 * own stale — in-progress draft when they meant to start over. Resuming a
 * specific draft is only ever a direct link to `/setup/:draftId/:step`,
 * which is exactly the shape a reload keeps and the shape #766 (the root
 * create-Event entry point, not yet decided) can construct from a "Resume
 * draft" list once it exists.
 */
export default function SetupWizard() {
  const location = useLocation();
  const params = setupRouteParams(location.pathname);
  const index = isSetupIndex(location.pathname);

  if (!index && !params) {
    // Neither the bare index nor a well-formed `/setup/:draftId/:step` —  a
    // typo or a stale link. Defer to the app's own unrecognized-route
    // fallback, matching `More.tsx`'s `unknownSubpath` handling.
    return <Navigate to={FALLBACK_PATH} replace />;
  }

  if (index) return <NewDraftEntry />;
  // `params` is non-null here: `index` is false and the guard above already
  // ruled out the remaining case. Keyed by draftId (Codex, PR #840): without
  // it, navigating directly from one `/setup/:draftId/:step` URL to another
  // reuses this component instance, so it can render the NEW url's step
  // against the OLD draft still sitting in state until the load effect
  // catches up. Keying forces a clean remount per draft.
  return <SetupWizardStep key={params!.draftId} draftId={params!.draftId} step={params!.step} />;
}

/**
 * Saves, then reads the draft straight back, returning it only if the round
 * trip actually succeeded.
 *
 * `EventDraftStore.save` is deliberately best-effort (specs/event-setup-wizard.md
 * § "Draft lifecycle" — "Save"): a quota or serialization failure is
 * swallowed and the call still resolves, exactly like the durable card
 * snapshot. That is the right contract for a fire-and-forget autosave, but it
 * is the WRONG contract for the two moments this shell makes an explicit
 * claim to the organizer — "this draft now lives at this URL" (creation) and
 * "Saved" (the header button) — so both verify via a real read-back instead
 * of trusting the write (Codex P1, PR #840).
 */
async function verifiedSave(store: EventDraftStore, draft: EventDraft): Promise<EventDraft | null> {
  const saved = await store.save(draft);
  const readBack = await store.load(saved.draftId);
  // A non-null read is not automatically success: a write that silently
  // failed against an ALREADY-EXISTING key can leave the OLD blob readable —
  // present, but stale. `save` always re-stamps `updatedAt` from its clock,
  // so comparing it is enough to tell "this write actually landed" from
  // "something readable happens to still be sitting there".
  if (!readBack || readBack.updatedAt !== saved.updatedAt) return null;
  return readBack;
}

/**
 * Discards, then confirms the key actually stopped reading back.
 *
 * `EventDraftStore.discard` is best-effort in the same way `save` is
 * (specs/event-setup-wizard.md § "Draft lifecycle" — "Discard" carries no
 * soft-delete, but the underlying `removeItem` can still throw against
 * write-restricted storage and be swallowed). Leaving without checking would
 * make Cancel LOOK like it worked while the "discarded" draft stays in
 * `list()` and can resurface in a future resume UI (Codex P2, PR #840).
 */
async function verifiedDiscard(store: EventDraftStore, draftId: string): Promise<boolean> {
  await store.discard(draftId);
  return (await store.load(draftId)) === null;
}

/** `/setup`: create a fresh draft, verify it actually persisted (so a reload
 *  before any field is touched still finds it — an UNVERIFIED save that
 *  silently failed would otherwise navigate to a draft URL that immediately
 *  reads back as missing, and the missing-draft branch below sends it right
 *  back here, looping forever), and land on Step 1. */
function NewDraftEntry() {
  const navigate = useNavigate();
  // Guards React.StrictMode's dev-only mount → cleanup → mount replay: without
  // it, the replay creates and saves a SECOND orphan draft, because the first
  // invocation's `save` already completed before its cleanup ran (Codex P2,
  // PR #840). The ref is stable across the replay (same component instance),
  // so only the first invocation ever starts the create-and-save chain; the
  // second sees it already claimed and does nothing. Deliberately NOT paired
  // with a "cancelled" flag guarding the eventual `navigate` call — that
  // would suppress it precisely when StrictMode's synthetic cleanup runs
  // between the two invocations, i.e. always in dev.
  const startedRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const store = createLocalDraftStore();
    const draft = createEventDraft();
    void verifiedSave(store, draft).then((confirmed) => {
      if (!confirmed) {
        setFailed(true);
        return;
      }
      navigate(setupStepPath(confirmed.draftId, 'occasion'), { replace: true });
    });
    // `attempt` is a manual retry lever (below); `navigate` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (failed) {
    return (
      <div className="wizard-shell wizard-storage-error" role="alert">
        <p>
          Couldn't start a new event — this device isn't able to save right now (storage may be full or
          restricted).
        </p>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            startedRef.current = false;
            setFailed(false);
            setAttempt((a) => a + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  return <LoadingState label="Starting a new event…" />;
}

/** `/setup/:draftId/:step`: load the draft, land on the first incomplete step
 *  when the URL asks for one further ahead than the draft supports, and wire
 *  the chrome to the store. */
function SetupWizardStep({ draftId, step }: { draftId: string; step: SetupStep }) {
  const navigate = useNavigate();
  // One store per draftId for the component's lifetime — `createLocalDraftStore`
  // is a thin, stateless wrapper over `localStorage`, so this is cheap, but a
  // stable instance keeps the save-on-mutation effect below from tearing down
  // and rebuilding on every render.
  const storeRef = useRef<EventDraftStore | null>(null);
  if (!storeRef.current) storeRef.current = createLocalDraftStore();
  const store = storeRef.current;

  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Forces a re-render — and so a fresh `Date.now()` read — at least once
  // around every upcoming Day unlock, not only when the organizer happens to
  // interact with the page. Without it, a wizard left open across an unlock
  // deadline can keep showing Look/Launch as complete after the shared gate
  // would no longer agree (Codex P1, PR #840): `firstUnlockIssues` is exactly
  // the kind of check that flips from "fine" to "not fine" with no draft
  // mutation involved.
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    void store.load(draftId).then((loaded) => {
      if (cancelled) return;
      if (!loaded) {
        setLoadState('missing');
        return;
      }
      setDraft(loaded);
      setLoadState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [store, draftId]);

  useEffect(() => () => {
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
  }, []);

  useEffect(() => {
    if (!draft) return;
    const now = Date.now();
    const upcoming = draft.days
      .filter((d): d is NonNullable<typeof d> => d != null)
      .map((d) => d.unlockAt)
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > now);
    const nextBoundary = upcoming.length > 0 ? Math.min(...upcoming) : null;
    // Cap the wait rather than parking on one long-lived timer: `setTimeout`
    // silently clamps delays beyond ~24.8 days (32-bit overflow), and even a
    // multi-day-out single wake would leave every OTHER time-sensitive check
    // (a first-unlock-past that flips with no Day involved at all, say) stale
    // for just as long. Firing re-schedules itself via the `clockTick`
    // dependency below, using a fresh `now` each time — so this always
    // converges on the real boundary within one cap-length window of it.
    const CAP_MS = 5 * 60_000;
    const delay = Math.max(nextBoundary === null ? CAP_MS : Math.min(nextBoundary - now, CAP_MS), 1_000);
    const timer = setTimeout(() => setClockTick((t) => t + 1), delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, clockTick]);

  // Persists the render-time landing correction below (rather than only
  // changing the URL) — otherwise a draft saved on, say, Launch, that later
  // becomes unreachable (its first unlock elapses while the wizard sits
  // open) keeps `draft.step: 'launch'` in storage forever: every future
  // Resume reopens at the stale step, redirects, and never records that it
  // did (Codex P2, PR #840). A plain effect, not folded into the render-body
  // redirect itself, so the redirect stays a pure render decision — no write
  // in the render path.
  useEffect(() => {
    if (!draft) return;
    const landing = firstIncompleteStep(draft, Date.now());
    if (stepIndex(step) > stepIndex(landing) && draft.step !== landing) {
      void store.save({ ...draft, step: landing });
    }
  }, [draft, step, store]);

  const persist = useCallback(
    (next: EventDraft) => {
      setDraft(next);
      void store.save(next);
    },
    [store],
  );

  const updateDraft = useCallback(
    (updater: (d: EventDraft) => EventDraft) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = updater(prev);
        void store.save(next);
        return next;
      });
    },
    [store],
  );

  const goToStep = useCallback(
    (target: SetupStep) => {
      if (!draft) return;
      // `step` tracks where Resume reopens — wherever the organizer most
      // recently navigated to, forward or back, is exactly that.
      persist({ ...draft, step: target });
      navigate(setupStepPath(draftId, target));
    },
    [draft, draftId, navigate, persist],
  );

  const handleAdvance = useCallback(() => {
    const next = SETUP_STEP_ORDER[stepIndex(step) + 1];
    if (next) goToStep(next);
  }, [step, goToStep]);

  const handleSaveNow = useCallback(() => {
    if (!draft) return;
    void verifiedSave(store, draft).then((confirmed) => {
      setSavedFlash(confirmed ? 'Saved' : "Couldn't save — check this device's storage");
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = setTimeout(() => setSavedFlash(null), confirmed ? 1500 : 4000);
    });
  }, [draft, store]);

  const discardAndLeave = useCallback(async () => {
    if (!draft) {
      navigate(FALLBACK_PATH, { replace: true });
      return;
    }
    const removed = await verifiedDiscard(store, draft.draftId);
    if (!removed) {
      // Stay put rather than navigating away on an unconfirmed discard — the
      // draft the organizer just told this to throw away may still be
      // sitting in `list()`, and leaving here would hide that (Codex P2, PR
      // #840).
      setCancelError("Couldn't discard this draft — this device's storage may be restricted. Try again.");
      return;
    }
    navigate(FALLBACK_PATH, { replace: true });
  }, [draft, store, navigate]);

  const requestCancel = useCallback(() => {
    if (!draft) return;
    // A second request while the confirm dialog is already open — reachable
    // only via Escape, since WizardChrome owns the one document-level
    // listener for it — closes it, same as tapping "Keep editing". This
    // keeps Escape-handling to that ONE listener rather than adding a second
    // one inside the dialog that would race it on the same keypress.
    if (confirmingCancel) {
      setConfirmingCancel(false);
      return;
    }
    setCancelError(null);
    if (draftHasContent(draft)) {
      setConfirmingCancel(true);
    } else {
      void discardAndLeave();
    }
  }, [draft, confirmingCancel, discardAndLeave]);

  if (loadState === 'missing') {
    // A dead or foreign draftId (never written by this store, a different
    // device's blob copied in, or already discarded) — never repaired,
    // matching `EventDraftStore.load`'s own "any miss reads as null, never a
    // half-shaped draft" contract. Start fresh rather than dead-ending.
    return <Navigate to="/setup" replace />;
  }
  if (loadState === 'loading' || !draft) {
    return <LoadingState label="Loading your draft…" />;
  }

  // The deep-link / stale-step landing rule, computed IN this render rather
  // than in a follow-up effect: an effect-based redirect lets React commit
  // and mount the requested (too-far-ahead) step's body for one frame before
  // correcting course — including, on Launch, briefly presenting an
  // inaccessible draft as ready (Codex P2, PR #840). Deciding here means the
  // mismatched step's `render` never mounts at all.
  const now = Date.now();
  const landing = firstIncompleteStep(draft, now);
  if (stepIndex(step) > stepIndex(landing)) {
    return <Navigate to={setupStepPath(draftId, landing)} replace />;
  }

  return (
    <>
      {cancelError && (
        <div className="wizard-shell wizard-cancel-error" role="alert">
          {cancelError}
        </div>
      )}
      <WizardChrome
        registry={STEP_REGISTRY}
        currentStep={step}
        draft={draft}
        now={now}
        onStepSelect={goToStep}
        onRequestCancel={requestCancel}
        onAdvance={handleAdvance}
        onSaveNow={handleSaveNow}
        savedFlash={savedFlash}
      >
        {STEP_REGISTRY.find((s) => s.id === step)?.render({ draft, updateDraft })}
      </WizardChrome>
      {confirmingCancel && (
        <CancelConfirmDialog
          onKeepEditing={() => setConfirmingCancel(false)}
          onDiscard={() => {
            setConfirmingCancel(false);
            void discardAndLeave();
          }}
        />
      )}
    </>
  );
}
