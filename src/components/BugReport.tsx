import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bug as BugIconGlyph } from 'lucide-react';
import {
  BUG_REPORT_DESCRIPTION_MAX,
  blobToDataUrl,
  buildBugReportInput,
  captureAppSurface,
  submitBugReport,
  type BugReportKind,
} from '../data/bugReports';

// `lucide-react`'s `Bug` (daily-cards-spec § "Iconography — Lucide"), formerly
// a hand-inlined bug-shaped `<svg>`. `.bug-report-icon` (not
// `.bug-report-trigger svg`) so sizing/stroke survive `variant="row"`, where
// the button drops the `bug-report-trigger` class for `more-row` — see
// index.css § bug reporting.
function BugIcon() {
  return <BugIconGlyph className="bug-report-icon" aria-hidden="true" focusable="false" />;
}

function errorMessage(error: unknown): string {
  const { code = '', message } = (error as { code?: string; message?: string } | null) ?? {};
  if (code.includes('resource-exhausted')) return 'Too many reports right now. Please try again later.';
  if (code.includes('unauthenticated')) return 'Please sign in again before submitting.';
  if (code.includes('invalid-argument')) {
    // The callable names the real reason (e.g. a screenshot the contract
    // rejects); connection-error copy would misdirect the reporter (#361).
    const detail = typeof message === 'string' ? message.trim().slice(0, 200) : '';
    return detail || 'The report was rejected. Adjust it and try again.';
  }
  return 'Could not submit the report. Check your connection and try again.';
}

/**
 * The report sheet is either up (`'sheet'`), parked while the reporter
 * navigates to the screen they want captured (`'pick'`), or gone
 * (`'closed'`). `'pick'` exists because `captureAppSurface()` can only
 * photograph the currently rendered route: a report opened from More would
 * otherwise only ever show the More menu (#324).
 */
type FlowStage = 'closed' | 'sheet' | 'pick';

interface BugReportFlow {
  open: (trigger: HTMLElement | null) => void;
}

const BugReportFlowContext = createContext<BugReportFlow | null>(null);

/**
 * Owns the whole report flow — sheet, capture state, and the pick-a-screen
 * bar — and renders it from the app shell (`App.tsx`) rather than from the
 * trigger's own route. That split is what lets pick mode survive tab
 * navigation: the More-mounted trigger unmounts the moment the reporter
 * leaves `/more`, but the flow (description draft included) lives here and
 * stays up until they capture or cancel (#324). The surface keeps the
 * `data-bug-report-ui` marker so `captureAppSurface()` never photographs the
 * reporting UI itself.
 */
export function BugReportProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  const kindRef = useRef<HTMLInputElement>(null);
  const captureAttemptRef = useRef(0);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [stage, setStage] = useState<FlowStage>('closed');
  const [description, setDescription] = useState('');
  // What the reporter says this is. `'bug'` by default, which is both the
  // common case and the value the server normalises an absent field to — so the
  // control changes what an abuse report does, never what a bug report does
  // (#670).
  const [kind, setKind] = useState<BugReportKind>('bug');
  const [screenshot, setScreenshot] = useState<Blob | null>(null);
  // The route the attached screenshot was taken on. Submission reports this
  // rather than the submit-time pathname, so a capture picked up on Card and
  // sent from the reopened sheet never gets labeled with a later route.
  const [captureRoute, setCaptureRoute] = useState<string | null>(null);
  const [captureState, setCaptureState] = useState<'idle' | 'capturing' | 'ready' | 'failed'>('idle');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  // What the SERVER did, not what the sheet hoped it would do. Only the server
  // knows whether an abuse report reached an admin, so the receipt reports the
  // outcome rather than the sheet promising one before submitting (#670).
  const [escalationEligible, setEscalationEligible] = useState(false);
  // The kind the SUBMITTED report actually carried. The live `kind` keeps
  // tracking the control, and the sheet stays mounted across a slow submit, so
  // reading `kind` on the receipt would describe whatever is selected NOW rather
  // than what was sent (#670, Codex P2 round 5).
  const [submittedKind, setSubmittedKind] = useState<BugReportKind>('bug');
  const previewUrl = useMemo(() => (screenshot ? URL.createObjectURL(screenshot) : null), [screenshot]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);
  useEffect(() => {
    // The pick bar has no field, so move focus onto it explicitly for
    // screen-reader users when the sheet parks.
    if (stage === 'pick') pickRef.current?.focus();
  }, [stage]);
  useEffect(() => {
    // THE SHEET OPENS ON THE KIND CHOICE, not on the textarea it used to
    // autofocus (#670). Forward navigation from the textarea never reaches a
    // control that sits ABOVE it, so a keyboard or screen-reader user could
    // describe harmful content and submit it under the default `bug`
    // classification without ever meeting the control that escalates it.
    //
    // It costs every reporter one Tab to start typing, which is a real cost paid
    // by the common case; it is worth it because the failure it removes is a
    // report of harm being silently misclassified, and because a classification
    // question is a reasonable thing to be asked first.
    if (stage === 'sheet' && !submittedId) kindRef.current?.focus();
  }, [stage, submittedId]);

  const capture = useCallback(async () => {
    const attempt = ++captureAttemptRef.current;
    const hadScreenshot = screenshot !== null;
    // Snapshot the route NOW: captureAppSurface() clones the DOM as it runs,
    // and the tab bar stays usable during a pick-mode capture, so reading the
    // pathname after the await could label the image with a later tab.
    const routeAtCapture = window.location.pathname;
    setCaptureState('capturing');
    setCaptureError(null);
    setError(null);
    try {
      const image = await captureAppSurface();
      if (captureAttemptRef.current !== attempt) return;
      setScreenshot(image);
      setCaptureRoute(routeAtCapture);
      setCaptureState('ready');
    } catch (captureFailure) {
      if (captureAttemptRef.current !== attempt) return;
      const message = captureFailure instanceof Error ? captureFailure.message.slice(0, 200) : 'Capture unavailable';
      if (hadScreenshot) {
        setError('Could not capture this screen. Keeping the previous screenshot.');
        setCaptureState('ready');
        return;
      }
      setCaptureError(message);
      setCaptureState('failed');
    }
  }, [screenshot]);

  const open = useCallback(
    (trigger: HTMLElement | null) => {
      restoreFocusRef.current = trigger;
      // Re-tapping a trigger mid-flow (e.g. back on /more during pick mode)
      // recalls the in-progress sheet instead of discarding the draft.
      if (stage !== 'closed') {
        setStage('sheet');
        return;
      }
      setStage('sheet');
      setDescription('');
      setKind('bug');
      setError(null);
      setSubmittedId(null);
      setSubmittedKind('bug');
      setEscalationEligible(false);
      void capture();
    },
    [stage, capture],
  );

  const close = useCallback(() => {
    if (busy) return;
    captureAttemptRef.current += 1;
    setStage('closed');
    setScreenshot(null);
    setCaptureRoute(null);
    setCaptureState('idle');
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restore?.isConnected) restore.focus();
  }, [busy]);

  const captureHere = async () => {
    await capture();
    // Success or failure, the sheet presents the result — 'failed' lands on
    // its existing retry affordance rather than stranding the pick bar.
    setStage('sheet');
  };

  useEffect(() => {
    if (stage === 'closed') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (stage === 'pick') {
          // Mid-capture the bar's buttons are disabled; keep Escape symmetric
          // so an in-flight pick capture can't be orphaned half-applied.
          if (captureState !== 'capturing') setStage('sheet');
        } else {
          close();
        }
        return;
      }
      if (stage !== 'sheet' || event.key !== 'Tab') return;
      const candidates = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      // A RADIO GROUP IS ONE SEQUENTIAL TAB STOP, not one per radio. Browsers
      // visit only the checked member (or the first, when none is checked), so a
      // raw query makes `first` a radio the user can never actually land on once
      // a LATER member is selected — and the backward-wrap test below, which
      // compares against `first` by identity, then never fires and focus walks
      // straight out of the modal. Reachable in this sheet the moment a reporter
      // picks "Abuse or harmful content" and presses Shift+Tab (#670, Codex P2).
      const radios = candidates.filter(
        (element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === 'radio',
      );
      const focusable = candidates.filter((element) => {
        if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) return true;
        const group = radios.filter((radio) => radio.name === element.name);
        return element === (group.find((radio) => radio.checked) ?? group[0]);
      });
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [stage, captureState, close]);

  const submit = async () => {
    if (!description.trim()) return;
    // Read ONCE, at click time. Everything below is async, and this closure must
    // send and report the same classification even if the control moves under it.
    const sentKind = kind;
    setBusy(true);
    setError(null);
    try {
      const screenshotDataUrl = screenshot ? await blobToDataUrl(screenshot) : null;
      const result = await submitBugReport(
        buildBugReportInput({
          description,
          kind: sentKind,
          screenshotDataUrl,
          captureError,
          route: screenshot ? (captureRoute ?? undefined) : undefined,
        }),
      );
      setSubmittedId(result.reportId);
      setSubmittedKind(sentKind);
      setEscalationEligible(result.escalationEligible === true);
      setScreenshot(null);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  const flow = useMemo(() => ({ open }), [open]);

  return (
    <BugReportFlowContext.Provider value={flow}>
      {children}
      {stage !== 'closed' && (
        // `data-unsaved-work` covers the WHOLE flow, not just the dialog phase
        // (Codex P2 round 4, src/swClientBridge.ts). The description, the
        // screenshot, and the route it was taken on live in this component's
        // state and nowhere else until submit, so an automatic post-deploy
        // reload does not interrupt the report — it destroys it. The pick phase
        // is the dangerous one: its container is a `role="group"`, invisible to
        // the generic modal query, and it is the phase that explicitly invites
        // the reporter to go wander the app while the draft is held here.
        <div className="bug-report-ui" data-bug-report-ui data-unsaved-work>
          {stage === 'sheet' && (
            <div className="sheet-backdrop bug-report-backdrop" role="presentation" onClick={close}>
              <section
                ref={dialogRef}
                className="sheet bug-report-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="bug-report-title"
                onClick={(event) => event.stopPropagation()}
              >
                {submittedId ? (
                  <>
                    <h2 className="sheet-title" id="bug-report-title">Report received</h2>
                    <p>Thanks. Your report ID is <code>{submittedId}</code>.</p>
                    {submittedKind === 'abuse' && (
                      <p className="bug-report-privacy">
                        {escalationEligible
                          ? 'We’re escalating this to the event’s admins too.'
                          : 'We can’t escalate this to the event’s admins automatically. If someone is in danger, tell an event organizer directly.'}
                      </p>
                    )}
                    <div className="sheet-actions">
                      <button className="btn primary" type="button" onClick={close}>Done</button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="sheet-title" id="bug-report-title">Report a bug</h2>
                    <p className="bug-report-privacy">
                      We’ll send your description, this app view, route, app version, browser, and screen size. Review the image before sending; no email or auth token is included.
                    </p>
                    {/* The abuse marking (#670). A radio pair rather than a
                        checkbox because the two are alternatives, not a flag on
                        a bug — and radios state the default visibly, which a
                        checkbox does not. `bug` is pre-selected, so a reporter
                        who ignores this control sends exactly the payload every
                        already-shipped client sends. */}
                    {/* Frozen while a submit is in flight, alongside Cancel: a
                        classification that can move after Send is a receipt that
                        can describe a report nobody filed. */}
                    <fieldset className="bug-report-kind" disabled={busy}>
                      <legend className="bug-report-label">What kind of report is this?</legend>
                      <label className="bug-report-kind-option">
                        <input
                          ref={kind === 'bug' ? kindRef : undefined}
                          type="radio"
                          name="bug-report-kind"
                          value="bug"
                          checked={kind === 'bug'}
                          onChange={() => setKind('bug')}
                        />
                        <span>Something is broken</span>
                      </label>
                      <label className="bug-report-kind-option">
                        <input
                          ref={kind === 'abuse' ? kindRef : undefined}
                          type="radio"
                          name="bug-report-kind"
                          value="abuse"
                          checked={kind === 'abuse'}
                          onChange={() => setKind('abuse')}
                        />
                        <span>Abuse or harmful content</span>
                      </label>
                    </fieldset>
                    {kind === 'abuse' && (
                      // "We'll TRY", because at this point nothing has been
                      // checked at all: eligibility is decided server-side after
                      // Send, and the server may deliberately decline — a
                      // stranger naming somebody else's Event, or a member
                      // reporting against an archived one. Promising the outcome
                      // here would be false for exactly those cases (Phase 4b
                      // P2). The second clause is the part that is always true,
                      // and it is the reassurance that actually matters: the
                      // report is filed either way. The receipt then states
                      // which of the two happened.
                      <p className="bug-report-privacy">
                        We’ll try to raise this with the event’s admins; either way your report is filed.
                      </p>
                    )}
                    <label className="bug-report-label" htmlFor="bug-report-description">What happened?</label>
                    <textarea
                      id="bug-report-description"
                      className="input bug-report-description"
                      rows={5}
                      maxLength={BUG_REPORT_DESCRIPTION_MAX}
                      placeholder="What were you trying to do, and what happened instead?"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                    <div className="bug-report-capture" aria-live="polite">
                      {captureState === 'capturing' && <p>Capturing this app view…</p>}
                      {captureState === 'ready' && previewUrl && (
                        <>
                          <img src={previewUrl} alt="Screenshot that will be submitted with this bug report" />
                          <div className="bug-report-capture-actions">
                            <button className="btn" type="button" onClick={capture}>Retake screenshot</button>
                            <button className="btn" type="button" onClick={() => setStage('pick')}>Capture a different screen</button>
                          </div>
                        </>
                      )}
                      {captureState === 'failed' && (
                        <>
                          <p>Screenshot unavailable. You can still send a text-only report.</p>
                          <div className="bug-report-capture-actions">
                            <button className="btn" type="button" onClick={capture}>Try screenshot again</button>
                            <button className="btn" type="button" onClick={() => setStage('pick')}>Capture a different screen</button>
                          </div>
                        </>
                      )}
                    </div>
                    {error && <p className="bug-report-error" role="alert">{error}</p>}
                    <div className="sheet-actions">
                      <button className="btn" type="button" disabled={busy} onClick={close}>Cancel</button>
                      <button className="btn primary" type="button" disabled={!description.trim() || busy} onClick={submit}>
                        {busy ? 'Sending…' : 'Send report'}
                      </button>
                    </div>
                  </>
                )}
              </section>
            </div>
          )}
          {stage === 'pick' && (
            <div
              ref={pickRef}
              className="bug-report-pick"
              role="group"
              tabIndex={-1}
              aria-label="Capture a different screen"
            >
              <p className="bug-report-pick-hint">Go to the screen with the bug, then capture it. Your report is saved.</p>
              <div className="bug-report-pick-actions">
                <button
                  className="btn"
                  type="button"
                  disabled={captureState === 'capturing'}
                  onClick={() => setStage('sheet')}
                >
                  Back
                </button>
                <button className="btn primary" type="button" disabled={captureState === 'capturing'} onClick={captureHere}>
                  {captureState === 'capturing' ? 'Capturing…' : 'Capture this screen'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </BugReportFlowContext.Provider>
  );
}

/**
 * `variant`: `'floating'` (default) is the original fixed bottom-right chip
 * (w4-bug-report-inbox.md) — kept intact for that spec's own coverage.
 * `'row'` is a plain full-width menu row, used ONLY by `More.tsx` (#208,
 * daily-cards-spec § "More menu" § Support): the live app mounts
 * `variant="row"` exclusively now, so only one "Report a bug" affordance is
 * ever on screen at a time. Either way this is just the launcher — the sheet
 * itself renders from `BugReportProvider` at the app shell (#324), which is
 * why a provider is required above every mount.
 */
export default function BugReport({ variant = 'floating' }: { variant?: 'floating' | 'row' }) {
  const flow = useContext(BugReportFlowContext);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!flow) throw new Error('BugReport must be rendered inside BugReportProvider');
  return (
    <div className="bug-report-ui" data-bug-report-ui>
      <button
        ref={triggerRef}
        className={variant === 'row' ? 'more-row' : 'bug-report-trigger'}
        type="button"
        aria-label="Report a bug"
        onClick={() => flow.open(triggerRef.current)}
      >
        <BugIcon />
        <span>Report a bug</span>
      </button>
    </div>
  );
}
