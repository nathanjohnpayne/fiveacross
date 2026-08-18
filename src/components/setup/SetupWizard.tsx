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
  // ruled out the remaining case.
  return <SetupWizardStep draftId={params!.draftId} step={params!.step} />;
}

/** `/setup`: create a fresh draft, persist it immediately (so a reload before
 *  any field is touched still finds it), and land on Step 1. */
function NewDraftEntry() {
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    const store = createLocalDraftStore();
    const draft = createEventDraft();
    void store.save(draft).then(() => {
      if (!cancelled) navigate(setupStepPath(draft.draftId, 'occasion'), { replace: true });
    });
    return () => {
      cancelled = true;
    };
    // Intentionally empty-array: this effect creates exactly ONE draft for
    // this mount. `navigate` is stable from react-router and does not need to
    // re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // The deep-link / stale-step guard: once the draft is loaded, a requested
  // step further ahead than the first one the draft doesn't yet satisfy is
  // NOT rendered directly — that would show, e.g., Step 4 as if Steps 1–3
  // were already answered. Landing earlier (including exactly on the first
  // incomplete step) is always fine — that is ordinary back-navigation.
  useEffect(() => {
    if (!draft) return;
    const landing = firstIncompleteStep(draft, Date.now());
    if (stepIndex(step) > stepIndex(landing)) {
      navigate(setupStepPath(draftId, landing), { replace: true });
    }
  }, [draft, step, draftId, navigate]);

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
    void store.save(draft).then(() => {
      setSavedFlash('Saved');
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = setTimeout(() => setSavedFlash(null), 1500);
    });
  }, [draft, store]);

  const discardAndLeave = useCallback(async () => {
    if (draft) await store.discard(draft.draftId);
    navigate(FALLBACK_PATH, { replace: true });
  }, [draft, store, navigate]);

  const requestCancel = useCallback(() => {
    if (!draft) return;
    if (draftHasContent(draft)) {
      setConfirmingCancel(true);
    } else {
      void discardAndLeave();
    }
  }, [draft, discardAndLeave]);

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

  return (
    <>
      <WizardChrome
        registry={STEP_REGISTRY}
        currentStep={step}
        draft={draft}
        now={Date.now()}
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
