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
 * TWO EDGE CASES where re-applying IS the right move (Codex P2, PR #855
 * round 2), both about a draft this step did not itself produce — resumed,
 * imported, or hand-crafted:
 * - `draft.occasion` may hold an id `OCCASIONS` no longer recognizes (a
 *   stale/removed matrix entry). `current` (`occasionById(draft.occasion)`)
 *   is then `null`, so the confirm dialog — which needs a real occasion to
 *   name as "what you're leaving" — could never render if every pick still
 *   required matching a `current` that doesn't exist. Any pick commits
 *   directly in that case, same as a first pick.
 * - `draft.occasion` may resolve, but disagree with `draft.edition`
 *   (specs/event-setup-wizard.md § Validation's `event-occasion-edition-mismatch`,
 *   which routes the organizer back to THIS step to fix it). A same-occasion
 *   re-click there recommits — the repair the validator is asking for —
 *   rather than a no-op that would leave "switch away and back" as the only
 *   way out.
 */
export default function OccasionStep({ draft, updateDraft }: StepRenderProps) {
  const [pending, setPending] = useState<OccasionDef | null>(null);
  const current = occasionById(draft.occasion);

  function commit(occasion: OccasionDef) {
    updateDraft((d) => applyOccasionDefaults(d, occasion));
  }

  function handleSelect(occasion: OccasionDef) {
    if (draft.occasion === null || current === null) {
      // A first pick, OR a resumed/imported draft whose STORED occasion no
      // longer resolves in the matrix — a stale/unknown id (Codex P2, PR
      // #855 round 2). The confirm dialog below needs a real `current`
      // occasion to name as "what you're leaving"; requiring one here too
      // would mean every row falls through to `setPending` with no way for
      // the dialog to ever render, permanently stranding the organizer on
      // Step 1. There is nothing valid to protect in either case, so commit
      // directly.
      commit(occasion);
      return;
    }
    if (draft.occasion === occasion.id) {
      if (draft.edition !== occasion.edition) {
        // A stale Edition binding (Codex P2, PR #855 round 2): a resumed or
        // imported draft can carry a recognized occasion whose `edition`
        // disagrees with it (specs/event-setup-wizard.md § Validation, "The
        // occasion must agree with the draft's edition"). `eventCompletenessIssues`
        // reports `event-occasion-edition-mismatch` and routes the organizer
        // BACK to this step specifically to fix it by re-picking — so
        // recommitting here IS the repair, not a clobber. A bare no-op would
        // leave "switch to another occasion, then switch back" as the only
        // way out, resetting unrelated fields twice for one fix.
        commit(occasion);
        return;
      }
      // A TRUE no-op otherwise (Codex P1, PR #855 round 1): nothing about
      // the draft changes on a same-occasion re-click, so this must not fall
      // through to `commit`. Doing so would re-run `applyOccasionDefaults`
      // and silently restore matrix defaults over card format / claim mode /
      // default Theme / settings the organizer may have hand-edited on a
      // LATER step since the first pick — exactly the silent clobber the
      // confirm dialog below exists to prevent for a DIFFERENT occasion.
      return;
    }
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
      {pending && current && (
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
