import { useEffect, useId, useRef, useState } from 'react';
import type { ClaimMode } from '../../types';
import type { StepRenderProps } from './stepRegistry';
import { deviceTimezoneSuggestion } from '../../data/eventDraft';
import { isSupportedTimezone } from '../../data/draftValidation';
import { checkEventAddressAvailability, type SlugAvailability } from '../../data/hostnames';
import { alternateNamespaceApex, CANONICAL_NAMESPACE_APEX } from '../../editions';
import { normalizeSlug, validateSlug, SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, type SlugRejection } from '../../slug';

/**
 * Step 2 · Basics (#790, specs/event-setup-wizard.md § "Step 2 · Basics").
 *
 * Name, dates, timezone, the live-checked address, marking mode and
 * audience. `plans/daily-cards-wireframes.html#frame-setup-basics` is
 * exploratory reference only — its own banner says control placement is
 * non-binding — so this component, not the frame, is what a reviewer checks
 * against; the frame draws the timezone control and a daily-email opt-in
 * differently, and this ticket does not follow either deviation (the daily
 * email toggle belongs to `settings.dailyEmailEnabled`, which no ticket in
 * the epic currently collects, and #785 supersedes the frame's "(auto)"
 * timezone caption outright).
 */

const CLAIM_MODES: readonly ClaimMode[] = ['honor', 'proof_required', 'admin_confirmed'];

/** The CONTEXT.md § "Claim Mode" vocabulary verbatim — the same labels
 *  `GameSettings.tsx` uses for the live Admin control over the same field,
 *  so an organizer sees one name for one concept whether they are setting it
 *  here or adjusting it after launch. */
const CLAIM_MODE_LABEL: Record<ClaimMode, string> = {
  honor: 'Honor',
  proof_required: 'Proof-to-mark',
  admin_confirmed: 'Admin-confirmed',
};


/** Debounce window before an edited candidate is checked over the network.
 *  Long enough that a fast typist does not fire one read per keystroke,
 *  short enough that "live" still reads as live. Exported so
 *  `StepBasics.test.tsx` can advance fake timers by the exact value rather
 *  than a duplicated magic number. */
export const CHECK_DEBOUNCE_MS = 400;

/** Copy for every `SlugRejection` `validateSlug` (`../../slug`) can report —
 *  the SAME reasons the shared #545 contract enumerates, never a second,
 *  looser set of messages guessed at in this component. */
const REJECTION_COPY: Record<SlugRejection, string> = {
  empty: 'Enter an address.',
  'too-short': `At least ${SLUG_MIN_LENGTH} characters.`,
  'too-long': `At most ${SLUG_MAX_LENGTH} characters.`,
  'invalid-characters': 'Lowercase letters, numbers and hyphens only.',
  'edge-hyphen': "Can't start or end with a hyphen.",
  'reserved-tag': "Can't use a double hyphen there.",
  'reserved-label': 'That address is reserved for platform use — try something else.',
};

type AddressStatus =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: SlugRejection }
  | { kind: 'checking' }
  | { kind: 'available' }
  /** `hostname` names WHICH of the two previewed addresses is occupied. Both
   *  are checked (the Edition alternate is a guarantee, not a bonus — owner
   *  ruling 2026-08-19), so "already taken" without naming one would block a
   *  candidate for a reason the organizer can see previewed but cannot act
   *  on: the canonical may be free and the alternate not. */
  | { kind: 'taken'; hostname: string }
  | { kind: 'check-failed' };

function statusCopy(status: AddressStatus): string {
  switch (status.kind) {
    case 'empty':
      return 'Enter an address to check availability.';
    case 'invalid':
      return REJECTION_COPY[status.reason];
    case 'checking':
      return 'Checking availability…';
    case 'available':
      return '✓ available';
    case 'taken':
      return `✕ ${status.hostname} is already taken`;
    case 'check-failed':
      return "Couldn't check right now — try again in a moment.";
  }
}

/**
 * Fold an Event name into a DNS-safe candidate label: lowercase, collapse
 * every run of non-`[a-z0-9]` into one hyphen, trim leading/trailing
 * hyphens, and cap at the Slug ceiling. `validateSlug` (`../../slug`) is
 * still the one authority on whether the RESULT is claimable — this
 * function only proposes a starting point, and a name that folds to
 * something too short or reserved is left for the organizer to fix by
 * typing their own address, exactly like editing any other auto-suggestion.
 */
export function slugify(name: string): string {
  return normalizeSlug(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    // Re-trim: slicing at the length ceiling can leave a trailing hyphen
    // that was previously mid-string.
    .replace(/-+$/g, '');
}

export default function StepBasics({ draft, updateDraft }: StepRenderProps) {
  const timezoneHintId = useId();
  const addressStatusId = useId();

  // The raw text in the address field. NOT the same value as
  // `draft.slugCandidate` moment-to-moment: the draft only ever holds a
  // candidate this component has confirmed format-valid and available (see
  // the effect below) — everything in between is local, so a check that is
  // freshly in flight or has failed can never leave the wrong address
  // sitting in the draft for the shared launch gate to trust (#785/#790
  // acceptance: "an availability check in flight or failed fails closed").
  // The one exception is a candidate that ALREADY matches the committed
  // value on mount — see the effect's optimistic branch below.
  const [slugInput, setSlugInput] = useState(draft.slugCandidate);
  // "Editable once" (#785): auto-generation from the name stops the moment
  // the organizer types into the address field directly. A resumed draft
  // that already carries a candidate is treated as already-edited, so
  // reopening this step never silently overwrites it with a fresh
  // auto-suggestion the organizer never asked for.
  const [addressTouched, setAddressTouched] = useState(draft.slugCandidate !== '');
  // Optimistic initial read, matching the effect below: an already-committed
  // candidate paints as available on first render rather than flashing
  // "checking" for a value already confirmed once.
  const [status, setStatus] = useState<AddressStatus>(
    draft.slugCandidate ? { kind: 'available' } : { kind: 'empty' },
  );
  // Guards the async availability read against being superseded by a later
  // edit — the request for an earlier candidate can resolve AFTER a newer
  // one has already started checking, and only the latest may ever write.
  const checkIdRef = useRef(0);

  useEffect(() => {
    if (addressTouched) return;
    setSlugInput(slugify(draft.name));
    // Re-derives only from the name and the touched flag; `addressTouched`
    // flips true the instant the organizer edits the field directly (see the
    // input's `onChange` below), which is what stops this from clobbering a
    // manual edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.name, addressTouched]);

  useEffect(() => {
    const candidate = normalizeSlug(slugInput);
    const myCheckId = ++checkIdRef.current;

    if (candidate === '') {
      setStatus({ kind: 'empty' });
      if (draft.slugCandidate !== '') updateDraft((d) => ({ ...d, slugCandidate: '' }));
      return;
    }

    const format = validateSlug(candidate);
    if (!format.ok) {
      // A malformed or reserved candidate is refused entirely client-side —
      // no network read (#785 acceptance: reserved labels are "rejected
      // client-side without a network read").
      setStatus({ kind: 'invalid', reason: format.reason });
      if (draft.slugCandidate !== '') updateDraft((d) => ({ ...d, slugCandidate: '' }));
      return;
    }

    if (draft.slugCandidate === candidate) {
      // OPTIMISTIC trust for a candidate that is ALREADY the committed one —
      // a re-mount (returning to this step, or a resumed draft) shows it as
      // available immediately rather than blocking Continue on a network
      // round trip for a value already confirmed once. A background
      // re-check still runs below and downgrades it the moment the world
      // has actually changed (someone else claimed it since).
      setStatus({ kind: 'available' });
    } else {
      // A GENUINELY NEW candidate — freshly typed, or auto-derived from an
      // edited name — fails closed immediately: its availability is
      // UNKNOWN until a fresh check says otherwise (#785/#790 acceptance:
      // "an availability check in flight or failed fails closed"), so it is
      // never left sitting in the draft for the shared launch gate to trust
      // on the strength of nothing.
      setStatus({ kind: 'checking' });
      if (draft.slugCandidate !== '') updateDraft((d) => ({ ...d, slugCandidate: '' }));
    }

    const timer = setTimeout(() => {
      void checkEventAddressAvailability(candidate, alternateNamespaceApex(draft.edition)).then((checked) => {
        if (checkIdRef.current !== myCheckId) return; // superseded by a later edit
        // Fail closed on the WORST answer across every address a launch would
        // claim, and name the first address that is not free. `check-failed`
        // outranks `taken` because "we could not tell" must never read as a
        // definite refusal the organizer might try to work around.
        const failed = checked.find((c) => c.status === 'check-failed');
        const taken = checked.find((c) => c.status === 'taken');
        const result: SlugAvailability = failed ? 'check-failed' : taken ? 'taken' : 'available';
        if (failed) setStatus({ kind: 'check-failed' });
        else if (taken) setStatus({ kind: 'taken', hostname: taken.hostname });
        else setStatus({ kind: 'available' });
        if (result === 'available') {
          updateDraft((d) => (d.slugCandidate === candidate ? d : { ...d, slugCandidate: candidate }));
        } else {
          // Downgrades an optimistic commit the instant the background
          // re-check learns it no longer holds (taken since, or the read
          // itself failed) — never left standing on stale trust.
          updateDraft((d) => (d.slugCandidate === '' ? d : { ...d, slugCandidate: '' }));
        }
      });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // Invalidate the IN-FLIGHT request too, not just the pending timer
      // (Codex, PR #911). Clearing the timer only helps while the debounce has
      // not fired; once it has, the promise is already running and unmount
      // does nothing to it. Its `.then` re-reads `checkIdRef.current`, which
      // still equals `myCheckId` after an unmount, so the guard passes and the
      // handler commits — on a component that is gone, and worse, against an
      // Edition that may have changed. Leaving Basics for Occasion, switching
      // to a Vacay occasion and returning would then trust a `slugCandidate`
      // that was never checked against the newly-required `vacaybingo.com`
      // alternate, because re-entry treats an already-committed candidate as
      // optimistically available. Bumping the id makes the stale response fail
      // the guard it already has, rather than adding a second mechanism.
      checkIdRef.current += 1;
    };
    // `draft.slugCandidate` and `updateDraft` are deliberately excluded: this
    // effect WRITES the former (via the latter), so depending on it would
    // make every write re-trigger the effect that made it. Re-checking is
    // driven only by the organizer's own input (or, on mount, the draft's
    // own already-committed value, read once via `draft.slugCandidate` at
    // the top of this run rather than as a reactive dependency).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `draft.edition` IS a dependency: it selects the Edition alternate apex,
    // so a re-picked occasion that rebinds the Edition changes WHICH addresses
    // a launch would claim. Leaving it out would leave a candidate showing
    // "available" against the previous Edition's pair.
  }, [slugInput, draft.edition]);

  // Read once per render: the device zone cannot change mid-session, and both
  // the control's availability and its written value must agree on one answer.
  const deviceSuggestion = deviceTimezoneSuggestion();
  const normalizedCandidate = normalizeSlug(slugInput);
  const alternateApex = alternateNamespaceApex(draft.edition);

  return (
    <div className="wizard-step-basics">
      <div className="row">
        <div className="grow">
          <div className="name">Event name</div>
          <input
            className="input"
            type="text"
            value={draft.name}
            placeholder="Weekend in Point Reyes"
            aria-label="Event name"
            onChange={(e) => {
              const name = e.target.value;
              updateDraft((d) => ({ ...d, name }));
            }}
          />
        </div>
      </div>

      <div className="row">
        <div className="grow">
          <div className="name">Dates</div>
          <div className="sub">Bounds the range — the Squares step owns which days actually deal a card.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              type="date"
              value={draft.startsOn}
              aria-label="Start date"
              onChange={(e) => {
                const startsOn = e.target.value;
                updateDraft((d) => ({ ...d, startsOn }));
              }}
            />
            <input
              className="input"
              type="date"
              value={draft.endsOn}
              aria-label="End date"
              onChange={(e) => {
                const endsOn = e.target.value;
                updateDraft((d) => ({ ...d, endsOn }));
              }}
            />
          </div>
        </div>
      </div>

      <div className="row">
        <div className="grow">
          <div className="name">Timezone</div>
          <div className="sub" id={timezoneHintId}>
            What the whole schedule is interpreted in — suggested from this device, always editable. Never left
            on the organizer's own zone for a destination Event.
          </div>
          <input
            className="input"
            type="text"
            value={draft.timezone}
            aria-label="Timezone"
            aria-describedby={timezoneHintId}
            placeholder="America/Los_Angeles"
            onChange={(e) => {
              const timezone = e.target.value;
              updateDraft((d) => ({ ...d, timezone }));
            }}
          />
          {draft.timezone.trim() !== '' && !isSupportedTimezone(draft.timezone) && (
            <div className="wizard-field-hint" role="alert">
              Not a recognized IANA zone — try a region name such as America/Los_Angeles.
            </div>
          )}
          {isSupportedTimezone(deviceSuggestion) ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                updateDraft((d) => ({ ...d, timezone: deviceSuggestion }));
              }}
            >
              Use this device's zone
            </button>
          ) : (
            /* The device reports a zone the read-side contract refuses — `UTC`
             * on a UTC host, which is every CI runner and plenty of servers and
             * VMs. Offering the button there hands the organizer a control that
             * writes an INVALID value and blocks completion, which is the exact
             * opposite of what it is for (CodeRabbit Major, PR #911).
             *
             * The validator's refusal is deliberate and not the thing to relax:
             * it demands a REGION zone because DST and date boundaries decide
             * which calendar day a Day unlocks on, and `UTC` cannot express
             * that. So the control is withdrawn and the reason is stated,
             * rather than writing a value the very next line renders an error
             * for. */
            <div className="wizard-field-hint">
              This device reports <code>{deviceSuggestion || 'no zone'}</code>, which isn't specific enough — Day
              unlocks need a region zone to land on the right date. Type one, such as America/Los_Angeles.
            </div>
          )}
        </div>
      </div>

      <div className="row">
        <div className="grow">
          <div className="name">Your event's address</div>
          <input
            className="input"
            type="text"
            value={slugInput}
            aria-label="Event address"
            aria-describedby={addressStatusId}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => {
              setAddressTouched(true);
              setSlugInput(e.target.value);
            }}
          />
          {/* NOT `role="status"` — the shell's own "Saved" flash
              (`WizardChrome`) already claims that live-region role, and a
              second one would make `getByRole('status')` ambiguous
              (collision found via the shell's own SetupWizard tests).
              `aria-describedby` on the input above already surfaces this
              text to assistive tech without a duplicate live region. */}
          <div
            id={addressStatusId}
            data-testid="address-availability-status"
            // A live region, but deliberately NOT `role="status"` (Codex, PR
            // #911). This text changes asynchronously — checking → available /
            // taken / check-failed — and `aria-describedby` alone only
            // ASSOCIATES it with the input; it does not oblige assistive tech
            // to announce a change while focus sits elsewhere, which is
            // exactly where an organizer's focus is during a debounced check.
            //
            // `role="status"` would announce it and also collide: the wizard
            // shell's "Saved" flash (`WizardChrome.tsx`) already carries that
            // role, and `SetupWizard.test.tsx` queries `getByRole('status')`
            // in the singular four times — a second one throws. The bare
            // attributes give the same announcement behaviour the role implies
            // without claiming the role, so the shell's query stays unambiguous
            // and the announcement is not traded away to keep a test query
            // working.
            aria-live="polite"
            aria-atomic="true"
            className={`wizard-address-status wizard-address-status--${status.kind}`}
          >
            {statusCopy(status)}
          </div>
          {normalizedCandidate !== '' && (
            <div className="wizard-address-hosts">
              <div className="wizard-address-host">
                {normalizedCandidate}.{CANONICAL_NAMESPACE_APEX} · canonical
              </div>
              {alternateApex !== null && (
                <div className="wizard-address-host">
                  {normalizedCandidate}.{alternateApex} · Edition alternate
                </div>
              )}
            </div>
          )}
          <div className="sub">
            Generated from the name — edit it once and it stays yours. Checked live against reserved and taken
            addresses; claiming it happens once, at launch.
          </div>
        </div>
      </div>

      <div className="row">
        <div className="grow">
          <div className="name">Marking</div>
          <div className="sub">A friction knob, not a trust level.</div>
        </div>
        <div className="seg" role="group" aria-label="Marking">
          {CLAIM_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={'seg-btn' + (draft.claimMode === mode ? ' on' : '')}
              aria-pressed={draft.claimMode === mode}
              onClick={() => updateDraft((d) => ({ ...d, claimMode: mode }))}
            >
              {CLAIM_MODE_LABEL[mode]}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="grow">
          <div className="name">Audience</div>
          <div className="sub">
            18+ records intent (<code>settings.forceAdult</code>) — it is half the verdict, not the whole one. An
            explicit main-pool Prompt raises the acknowledgement regardless of this choice, and Step 5 shows the
            resolved posture with the reason.
          </div>
        </div>
        <div className="seg" role="group" aria-label="Audience">
          <button
            type="button"
            className={'seg-btn' + (!draft.settings.forceAdult ? ' on' : '')}
            aria-pressed={!draft.settings.forceAdult}
            onClick={() => updateDraft((d) => ({ ...d, settings: { ...d.settings, forceAdult: false } }))}
          >
            All ages
          </button>
          <button
            type="button"
            className={'seg-btn' + (draft.settings.forceAdult ? ' on' : '')}
            aria-pressed={draft.settings.forceAdult}
            onClick={() => updateDraft((d) => ({ ...d, settings: { ...d.settings, forceAdult: true } }))}
          >
            18+ (sets forceAdult)
          </button>
        </div>
      </div>
    </div>
  );
}
