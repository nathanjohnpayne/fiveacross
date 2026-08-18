import { useState } from 'react';
import type { StepRenderProps } from './stepRegistry';
import type { OccasionDef } from '../../types';
import { OCCASIONS, applyOccasionDefaults, occasionById } from '../../data/occasions';
import { editionBrand } from '../../editions';
import OccasionChangeConfirm from './OccasionChangeConfirm';

/**
 * Step 1 · Occasion (#789, specs/event-setup-wizard.md § "Step 1 ·
 * Occasion"). Renders the six rows of `#frame-setup-occasion` straight from
 * `OCCASIONS` (`src/data/occasions.ts`) — never a second, hand-authored copy
 * of the matrix — and commits a pick through `applyOccasionDefaults`, the
 * SAME function `occasions.test.ts` already covers at the data layer. This
 * component's own job is picking the occasion and gating a re-pick; what
 * each occasion BINDS is `occasions.ts`'s contract to consume, not fork.
 *
 * RE-SELECTION GUARD. The acceptance criteria (#789) asks that re-entering
 * this step and picking a DIFFERENT occasion either "re-seed only fields the
 * organizer has not hand-edited" or "warn before overwriting — never a
 * silent clobber". `EventDraft` (domainTypes.d.ts) carries no hand-edited
 * tracking for the fields `applyOccasionDefaults` recommits — card format,
 * claim mode, default Theme, settings — only their CURRENT value, so the
 * first branch would mean inventing dirty-tracking the spec never asked for
 * and the merged #787 contract does not carry. specs/event-setup-wizard.md's
 * own documented contract for `applyOccasionDefaults` is instead "always
 * recommits those fields" (its one stated destructive exception is clearing
 * `days[]` on a one-card re-pick) — so re-seeding is genuinely unconditional
 * by design, not an oversight this step should work around. This step
 * therefore takes the second branch: a FIRST pick (`draft.occasion === null`)
 * applies immediately, since nothing is at risk of being overwritten: but a
 * pick that would change an ALREADY-SELECTED occasion interposes
 * `OccasionChangeConfirm` first, because Steps 2/4/5 (#790/#792/#793) can
 * each hand-edit exactly the fields a re-pick would silently recommit.
 * Re-selecting the SAME occasion is a TRUE no-op — `handleSelect` returns
 * without calling `commit` at all (Codex P1, PR #855 round 1): nothing about
 * the draft changes, so nothing needs re-applying, and re-running
 * `applyOccasionDefaults` here would silently discard exactly the same
 * later-step hand-edits the confirm dialog exists to protect.
 *
 * TWO EDGE CASES about a draft this step did not itself produce — resumed,
 * imported, or hand-crafted, never a normal in-flow edit:
 * - `draft.occasion` may hold an id `OCCASIONS` no longer recognizes (a
 *   stale/removed matrix entry), so `current` (`occasionById(draft.occasion)`)
 *   is `null`. An unrecognized id is NOT proof there's nothing to protect
 *   (Codex P2, PR #855 round 3): the rest of the draft — claim mode, card
 *   format, default Theme, settings, Days — can still be real, organizer-
 *   entered data that `applyOccasionDefaults` would overwrite, or for a
 *   one-card `to`, clear outright. So this still routes through
 *   `OccasionChangeConfirm`, which accepts `from: OccasionDef | null` and
 *   adapts its copy when there's no valid occasion left to name.
 * - `draft.occasion` may resolve, but disagree with `draft.edition`
 *   (specs/event-setup-wizard.md § Validation's `event-occasion-edition-mismatch`,
 *   which routes the organizer back to THIS step to fix it). A same-occasion
 *   re-click there patches ONLY `edition` — never the full `commit` (Codex
 *   P2, PR #855 round 4): that would reintroduce the same silent-overwrite
 *   risk round 3 fixed for a stale occasion id, this time for a stale
 *   EDITION on an otherwise-recognized one. The validator's complaint is
 *   specifically that `edition` disagrees with `occasion`, so the repair is
 *   exactly that field — never a no-op, which would leave "switch away and
 *   back" as the only way out, but never a full recommit either.
 */
export default function OccasionStep({ draft, updateDraft }: StepRenderProps) {
  const [pending, setPending] = useState<OccasionDef | null>(null);
  const current = occasionById(draft.occasion);

  function commit(occasion: OccasionDef) {
    updateDraft((d) => applyOccasionDefaults(d, occasion));
  }

  function handleSelect(occasion: OccasionDef) {
    if (draft.occasion === null) {
      // A genuinely fresh draft — nothing anywhere is at risk of being
      // overwritten, so there is nothing to confirm.
      commit(occasion);
      return;
    }
    if (draft.occasion === occasion.id) {
      // Only reachable when `current` resolves: a stale/unrecognized id can
      // never equal a real OCCASIONS entry's id.
      if (draft.edition !== occasion.edition) {
        // A stale Edition binding (Codex P2, PR #855 round 2): a resumed or
        // imported draft can carry a recognized occasion whose `edition`
        // disagrees with it (specs/event-setup-wizard.md § Validation, "The
        // occasion must agree with the draft's edition"). `eventCompletenessIssues`
        // reports `event-occasion-edition-mismatch` and routes the organizer
        // BACK to this step specifically to fix it by re-picking — so this
        // must repair the mismatch, not no-op past it. But it must NOT go
        // through `commit`/`applyOccasionDefaults` to do it (Codex P2, PR
        // #855 round 4): that recommits card format, claim mode, default
        // Theme and settings too — the SAME silent-overwrite risk round 3
        // fixed for a stale/unrecognized occasion id, reintroduced here for
        // a stale EDITION on an otherwise-recognized one. The validator's
        // complaint is specifically that `edition` disagrees with
        // `occasion`, so the repair is exactly that field, and nothing else.
        updateDraft((d) => ({ ...d, edition: occasion.edition }));
        return;
      }
      // A TRUE no-op otherwise (Codex P1, PR #855 round 1): nothing about
      // the draft changes on a same-occasion re-click, so this must not fall
      // through to `commit`. Doing so would re-run `applyOccasionDefaults`
      // and silently restore matrix defaults over card format / claim mode /
      // default Theme / settings the organizer may have hand-edited on a
      // LATER step since the first pick — exactly the silent clobber the
      // confirm dialog below exists to prevent for a different pick.
      return;
    }
    // Everything else — a genuinely different occasion, OR a stored id that
    // doesn't resolve at all (`current === null`) — replaces whatever is
    // stored, so it always confirms first (Codex P2, PR #855 round 3).
    setPending(occasion);
  }

  return (
    <div className="wizard-occasion-step" data-testid="wizard-step-occasion">
      <div className="wizard-occasion-list" role="group" aria-label="Occasion">
        {OCCASIONS.map((occasion) => {
          const selected = draft.occasion === occasion.id;
          return (
            <button
              key={occasion.id}
              type="button"
              className={`wizard-occasion-row${selected ? ' is-selected' : ''}`}
              aria-pressed={selected}
              onClick={() => handleSelect(occasion)}
            >
              <span className="wizard-occasion-icon" aria-hidden="true">
                {occasion.emoji}
              </span>
              <span className="wizard-occasion-text">
                <span className="wizard-occasion-label">{occasion.label}</span>
                <span className="wizard-occasion-blurb">{occasion.blurb}</span>
              </span>
              {/* The Edition pill: only the SELECTED row names it, matching
                  the frame (`#frame-setup-occasion` draws it only on the
                  highlighted row) and the acceptance criteria ("the Edition
                  pill names the player-facing Edition"). */}
              {selected && (
                <span className="pill wizard-occasion-pill">{editionBrand(occasion.edition).appName} edition</span>
              )}
            </button>
          );
        })}
      </div>
      <p className="wizard-occasion-note muted">
        {/* Frame copy (`#frame-setup-occasion`) named a starter square pack
            here too, but every `starterPackId` in the matrix is `null` today
            (content ownership is open, #786 Decision 2) — no occasion seeds
            one yet, so this note only promises what selecting an occasion
            actually commits right now (CodeRabbit, PR #855). */}
        The occasion sets the edition your players see and sensible defaults for your schedule and Look — every one
        changeable before launch.
      </p>
      {pending && (
        <OccasionChangeConfirm
          from={current}
          to={pending}
          willClearSchedule={pending.defaults.cardFormat === 'one_card' && draft.days.length > 0}
          onKeepCurrent={() => setPending(null)}
          onSwitch={() => {
            commit(pending);
            setPending(null);
          }}
        />
      )}
    </div>
  );
}
