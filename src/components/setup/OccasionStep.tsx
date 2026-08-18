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
 * Re-selecting the SAME occasion is a no-op in every field
 * `applyOccasionDefaults` touches, so it re-applies without a prompt.
 */
export default function OccasionStep({ draft, updateDraft }: StepRenderProps) {
  const [pending, setPending] = useState<OccasionDef | null>(null);
  const current = occasionById(draft.occasion);

  function commit(occasion: OccasionDef) {
    updateDraft((d) => applyOccasionDefaults(d, occasion));
  }

  function handleSelect(occasion: OccasionDef) {
    if (draft.occasion !== null && draft.occasion !== occasion.id) {
      setPending(occasion);
      return;
    }
    commit(occasion);
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
        The occasion sets the edition your players see, the starter square pack, and sensible defaults — every one
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
