import { useState, type ReactNode } from 'react';
import type { DayDef } from '../../types';
import type { PoolId } from '../../game/pool';
import { MIN_POOL } from '../../game/logic';
import { normalizePool } from '../../game/pool';
import { MAX_DAYS, assignedPools, type DraftIssue } from '../../data/draftValidation';
import {
  POOL_ORDER,
  addDay,
  addPrompt,
  canAddDay,
  duplicatePromptTexts,
  poolCounts,
  removeDay,
  removePrompt,
  seedPack,
  setCardFormat,
  setDayPool,
  setDayTutorial,
  setMainPromptSpicy,
  setPromptText,
} from '../../data/draftSquares';
import { packPromptCount, starterPackForOccasion } from '../../data/starterPacks';
import type { StepRenderProps } from './stepRegistry';
import { issuesForStep } from './wizardSteps';

/**
 * Step 3 · Squares (#791, specs/event-setup-wizard.md § "Squares";
 * `#frame-setup-squares`). Card format, pack seeding, Prompt CRUD with pool
 * classification, the per-Day pool/tutorial assignment, and the live per-pool
 * minimum gate.
 *
 * WHAT THIS STEP DOES NOT DO: create `ItemDoc`s. Every write here goes through
 * `updateDraft` into the device-local draft, and the launch provisioner (#793)
 * seeds the items — which is also why nothing here has to think about the
 * legacy persisted `embark`/`farewell` pool spellings on the write side. It
 * still READS through `normalizePool`, because a resumed draft can carry them.
 *
 * WHY THE GATE IS `issuesForStep` AND NOT A LOCAL RE-CHECK: the shared launch
 * gate (`validateEventDraft`) is what Step 5's checklist and the provisioner
 * both read, and a step that re-derived "am I short?" from its own counting
 * would be free to disagree with the thing that actually blocks the launch —
 * the exact drift `wizardSteps.ts` exists to prevent. So the counts below are
 * rendered from `countPrompts` (the gate's own counter, re-exported) while
 * every VERDICT comes from the issue list, anchored to the row that fixes it
 * via the `pool` and `dayIndex` fields `DraftIssue` carries for the purpose.
 *
 * The `Date.now()` passed to that classifier is inert for this step: all nine
 * codes it routes to `squares` come from clock-free predicates
 * (`assignedPoolIssues`, `finaleClosingPoolIssues`, `dayCountIssues`,
 * `promptPoolIssues`, `promptTextIssues`) — only `firstUnlockIssues` reads the
 * clock, and that routes to Look. Calling the shared classifier anyway, rather
 * than hand-picking those five predicates, is what keeps this step and the
 * shell's own Continue gate structurally the same answer (`StepRenderProps`
 * deliberately carries no clock — #788's contract).
 */
export default function StepSquares({ draft, updateDraft }: StepRenderProps) {
  const issues = issuesForStep('squares', draft, Date.now());
  const counts = poolCounts(draft);
  const assigned = assignedPools(draft);
  const pack = starterPackForOccasion(draft.occasion);
  const dailyCards = draft.cardFormat === 'daily_cards';

  const shortPools = new Set(
    issues.filter((i) => i.code === 'pool-below-minimum').map((i) => i.pool),
  );
  const dayIssues = issues.filter((i) => i.dayIndex !== undefined);
  const scheduleIssues = issues.filter(
    (i) => i.code === 'no-days' || i.code === 'too-many-days' || i.code === 'one-card-has-days',
  );
  const promptIssues = issues.filter(
    (i) =>
      i.code === 'prompt-text-out-of-bounds' ||
      i.code === 'main-prompt-spicy-not-boolean' ||
      i.code === 'curated-prompt-is-spicy',
  );

  return (
    <div className="squares-step" data-testid="setup-step-squares">
      <CardFormatSection draft={draft} updateDraft={updateDraft} issues={scheduleIssues} />

      <div className="squares-subhead">Squares</div>
      <PackRow
        packLabel={pack ? `${pack.emoji} ${pack.label}` : null}
        packSquares={pack ? packPromptCount(pack) : 0}
        seeded={counts.main + counts.easy + counts.closing}
        onSeed={pack ? () => updateDraft((d) => seedPack(d, pack)) : null}
      />

      <ul className="squares-counts" aria-label="Prompts per pool">
        {POOL_ORDER.map((pool) => (
          <PoolCount
            key={pool}
            pool={pool}
            count={counts[pool]}
            assigned={assigned.includes(pool)}
            short={shortPools.has(pool)}
          />
        ))}
      </ul>
      <p className="squares-note">
        Minimum {MIN_POOL} <b>per assigned pool</b>, checked separately. A total is not enough — a
        Day deals from its own pool alone, so a big pack with a thin closing pool still cannot deal
        the farewell card.
      </p>

      <DuplicateAdvice duplicates={duplicatePromptTexts(draft)} />
      <PromptList draft={draft} updateDraft={updateDraft} />
      <IssueList issues={promptIssues} label="Prompt problems" />
      <AddPromptBar onAdd={(pool, text, spicy) => updateDraft((d) => addPrompt(d, pool, text, spicy))} />

      {dailyCards && (
        <DaysAndPools draft={draft} updateDraft={updateDraft} issues={dayIssues} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- card format */

function CardFormatSection({
  draft,
  updateDraft,
  issues,
}: Pick<StepRenderProps, 'draft' | 'updateDraft'> & { issues: DraftIssue[] }) {
  // Switching to one card CLEARS the schedule, and an authored schedule is
  // real work. Confirmed inline rather than through a dialog: the choice is
  // reversible (switching back re-proposes the occasion's shape), so it does
  // not warrant the modal ceremony `CancelConfirmDialog` carries for a discard.
  const [confirmingOneCard, setConfirmingOneCard] = useState(false);
  const dayCount = draft.days.length;
  const dailyCards = draft.cardFormat === 'daily_cards';

  const chooseOneCard = () => {
    if (dailyCards && dayCount > 0) {
      setConfirmingOneCard(true);
      return;
    }
    updateDraft((d) => setCardFormat(d, 'one_card'));
  };

  return (
    <>
      <div className="squares-subhead">Card format</div>
      <div className="seg squares-seg">
        <button
          type="button"
          className={'seg-btn' + (dailyCards ? '' : ' on')}
          aria-pressed={!dailyCards}
          onClick={chooseOneCard}
        >
          One card
        </button>
        <button
          type="button"
          className={'seg-btn' + (dailyCards ? ' on' : '')}
          aria-pressed={dailyCards}
          onClick={() => {
            setConfirmingOneCard(false);
            updateDraft((d) => setCardFormat(d, 'daily_cards'));
          }}
        >
          {dailyCards && dayCount > 0 ? `Daily cards · ${dayCount} Days` : 'Daily cards'}
        </button>
      </div>
      {confirmingOneCard && (
        <div className="squares-confirm" role="alert">
          <span className="grow">
            One card, one celebration — a one-card Event has no schedule, so the {dayCount}{' '}
            {dayCount === 1 ? 'Day' : 'Days'} you have authored would be removed.
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setConfirmingOneCard(false);
              updateDraft((d) => setCardFormat(d, 'one_card'));
            }}
          >
            Remove Days
          </button>
          <button type="button" className="btn" onClick={() => setConfirmingOneCard(false)}>
            Keep daily cards
          </button>
        </div>
      )}
      <p className="squares-note">
        Maximum {MAX_DAYS} Days — the Firestore schedule lock (<code>daysThemeLockOk</code>) only
        covers Day indexes 0–{MAX_DAYS - 1}, so an eleventh Day would stay editable after it
        unlocked.
      </p>
      <IssueList issues={issues} label="Schedule problems" />
    </>
  );
}

/* ------------------------------------------------------------------ pack seed */

function PackRow({
  packLabel,
  packSquares,
  seeded,
  onSeed,
}: {
  packLabel: string | null;
  packSquares: number;
  seeded: number;
  onSeed: (() => void) | null;
}) {
  // Replacing a non-empty pool destroys Prompts the organizer may have typed
  // themselves — the draft carries no per-Prompt provenance to spare them (see
  // `seedPack`) — so the cost is stated before the tap, not after.
  const [confirming, setConfirming] = useState(false);

  if (!packLabel || !onSeed) {
    return (
      <div className="squares-pack" data-testid="squares-pack-empty">
        <div className="grow">
          <div className="name">No starter pack yet</div>
          <div className="sub">
            This occasion has no pack bound to it, so the Squares below are yours to write. Add them
            with the bar underneath — {MIN_POOL} per pool each Day deals from.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="squares-pack" data-testid="squares-pack">
      <div className="grow">
        <div className="name">{packLabel}</div>
        <div className="sub">
          {packSquares} squares{seeded > 0 ? ` · ${seeded} in this draft` : ''}
        </div>
      </div>
      {seeded === 0 ? (
        <button type="button" className="btn" onClick={onSeed}>
          Seed
        </button>
      ) : confirming ? (
        <>
          <span className="squares-confirm-text">Replaces all {seeded} Prompts, including your own.</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setConfirming(false);
              onSeed();
            }}
          >
            Replace
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => setConfirming(true)}>
          Change
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- pool counts */

const POOL_LABEL: Record<PoolId, string> = { main: 'main', easy: 'easy', closing: 'closing' };

function PoolCount({
  pool,
  count,
  assigned,
  short,
}: {
  pool: PoolId;
  count: number;
  assigned: boolean;
  short: boolean;
}) {
  // Three states, never two. An UNASSIGNED pool is not "passing" — no Day
  // deals from it, so the minimum simply does not apply, and rendering it with
  // a ✓ would tell an organizer their four closing Prompts were fine right up
  // until they assigned the finale.
  const verdict = !assigned ? 'no Day deals from it' : short ? `needs ${MIN_POOL}` : '✓';
  const className =
    'squares-count' + (!assigned ? ' is-idle' : short ? ' is-short' : ' is-ok');
  return (
    <li className={className} data-testid={`squares-count-${pool}`}>
      <b>{POOL_LABEL[pool]}</b> {count} · {verdict}
    </li>
  );
}

/**
 * Repeated Prompt text, said out loud but never blocking.
 *
 * Twenty-four identically worded Prompts clear the minimum and deal a legal
 * but miserable card. That is worth flagging and NOT worth refusing: nothing
 * downstream breaks, and a repeat can be deliberate. So this is a note, not a
 * `DraftIssue` — see `duplicatePromptTexts`.
 */
function DuplicateAdvice({ duplicates }: { duplicates: Record<PoolId, string[]> }) {
  const pools = POOL_ORDER.filter((pool) => duplicates[pool].length > 0);
  if (pools.length === 0) return null;
  return (
    <p className="squares-note squares-duplicates" role="status">
      Repeated wording —{' '}
      {pools
        .map((pool) => `${POOL_LABEL[pool]}: ${duplicates[pool].map((t) => `“${t}”`).join(', ')}`)
        .join(' · ')}
      . Not a blocker: duplicates still deal, they just make a duller card.
    </p>
  );
}

/* -------------------------------------------------------------- prompt CRUD */

function PromptList({ draft, updateDraft }: Pick<StepRenderProps, 'draft' | 'updateDraft'>) {
  const rows = POOL_ORDER.flatMap((pool) => {
    const prompts = draft.prompts[pool] as readonly unknown[];
    // An INDEX walk, matching `promptTextIssues`: `map`/`flatMap` skip holes,
    // and a hole is exactly what the organizer needs to be able to see — it is
    // an entry the gate reports as missing and that nothing else can reach.
    const out: ReactNode[] = [];
    for (let position = 0; position < prompts.length; position++) {
      const entry = prompts[position];
      const key = `${pool}-${position}`;
      if (entry === null || entry === undefined) {
        out.push(
          <li className="squares-prompt-row is-gap" key={key}>
            <span className="squares-chip">{POOL_LABEL[pool]}</span>
            <span className="grow">Prompt {position + 1} is missing</span>
            <button
              type="button"
              className="iconbtn"
              aria-label={`Remove the gap at Prompt ${position + 1} in the ${POOL_LABEL[pool]} pool`}
              onClick={() => updateDraft((d) => removePrompt(d, pool, position))}
            >
              ✕
            </button>
          </li>,
        );
        continue;
      }
      const prompt = entry as { text?: unknown; spicy?: unknown };
      out.push(
        <PromptRow
          key={key}
          pool={pool}
          position={position}
          text={typeof prompt.text === 'string' ? prompt.text : ''}
          spicy={prompt.spicy === true}
          onText={(text) => updateDraft((d) => setPromptText(d, pool, position, text))}
          onSpicy={(spicy) => updateDraft((d) => setMainPromptSpicy(d, position, spicy))}
          onRemove={() => updateDraft((d) => removePrompt(d, pool, position))}
        />,
      );
    }
    return out;
  });

  if (rows.length === 0) {
    return <p className="squares-note squares-empty">No Squares yet.</p>;
  }
  return (
    <ul className="squares-prompts list" aria-label="Prompts">
      {rows}
    </ul>
  );
}

function PromptRow({
  pool,
  position,
  text,
  spicy,
  onText,
  onSpicy,
  onRemove,
}: {
  pool: PoolId;
  position: number;
  text: string;
  spicy: boolean;
  onText: (text: string) => void;
  onSpicy: (spicy: boolean) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const label = `Prompt ${position + 1} in the ${POOL_LABEL[pool]} pool`;

  const commit = () => {
    if (value.trim() !== '' && value.trim() !== text) onText(value);
    setEditing(false);
  };

  // `data-unsaved-work` while the inline editor holds copy that differs from
  // what is stored — the same declaration `PromptPool`'s row and the Admin
  // message editor make, for the same reason: this draft lives only in React
  // state, so an automatic post-deploy reload would destroy it rather than
  // interrupt it. (The committed draft is safe; `updateDraft` persists it.)
  const dirty = editing && value.trim() !== '' && value.trim() !== text;

  return (
    <li className="squares-prompt-row" data-unsaved-work={dirty || undefined}>
      <span className="squares-chip">{POOL_LABEL[pool]}</span>
      {editing ? (
        <input
          className="grow"
          value={value}
          maxLength={80}
          aria-label={`Edit ${label}`}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span className="grow">{text}</span>
      )}
      {/* Spicy is offered on MAIN rows only. Not disabled-but-present: a
          control that renders and does nothing is exactly the "looks
          honoured, silently dropped" shape #785 warns about, and `PromptPool`'s
          admin bar (which does disable it) is a different surface with a
          different audience. */}
      {pool === 'main' && (
        <label className="squares-spicy">
          <input
            type="checkbox"
            checked={spicy}
            aria-label={`Spicy — ${label}`}
            onChange={(e) => onSpicy(e.target.checked)}
          />{' '}
          🔞
        </label>
      )}
      {editing ? (
        <>
          <button type="button" className="btn" onClick={commit}>
            Save
          </button>
          <button type="button" className="iconbtn" aria-label="Cancel edit" onClick={() => setEditing(false)}>
            ✕
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="iconbtn"
            aria-label={`Edit ${label}`}
            onClick={() => {
              setValue(text);
              setEditing(true);
            }}
          >
            ✎
          </button>
          <button type="button" className="iconbtn" aria-label={`Delete ${label}`} onClick={onRemove}>
            ✕
          </button>
        </>
      )}
    </li>
  );
}

function AddPromptBar({
  onAdd,
}: {
  onAdd: (pool: PoolId, text: string, spicy: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [pool, setPool] = useState<PoolId>('main');
  const [spicy, setSpicy] = useState(false);

  const submit = () => {
    if (text.trim() === '') return;
    onAdd(pool, text, pool === 'main' && spicy);
    setText('');
  };

  return (
    <div className="squares-addbar" data-unsaved-work={text.trim() !== '' || undefined}>
      <input
        className="grow"
        value={text}
        maxLength={80}
        placeholder="Add your own… ask a local for a favourite detour"
        aria-label="New Prompt text"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <select
        aria-label="Pool"
        value={pool}
        onChange={(e) => {
          const next = e.target.value as PoolId;
          setPool(next);
          // Cleared rather than merely hidden, so a flag tapped while the pool
          // said "main" cannot ride along into a curated add.
          if (next !== 'main') setSpicy(false);
        }}
      >
        <option value="main">main</option>
        <option value="easy">easy</option>
        <option value="closing">closing</option>
      </select>
      {pool === 'main' ? (
        <label className="squares-spicy">
          <input
            type="checkbox"
            checked={spicy}
            aria-label="Spicy"
            onChange={(e) => setSpicy(e.target.checked)}
          />{' '}
          🔞 spicy
        </label>
      ) : (
        <span className="squares-spicy-off">off · main only</span>
      )}
      <button type="button" className="btn" disabled={text.trim() === ''} onClick={submit}>
        Add
      </button>
    </div>
  );
}

/* ----------------------------------------------------------- days and pools */

function DaysAndPools({
  draft,
  updateDraft,
  issues,
}: Pick<StepRenderProps, 'draft' | 'updateDraft'> & { issues: DraftIssue[] }) {
  const atCeiling = !canAddDay(draft);
  return (
    <>
      <div className="squares-subhead">Days &amp; pools</div>
      <ul className="squares-days list" aria-label="Days">
        {draft.days.map((day, position) => {
          if (day === null || day === undefined) {
            return (
              <li className="squares-day-row is-gap" key={`gap-${position}`}>
                <span className="grow">Day {position + 1} is missing</span>
                <button
                  type="button"
                  className="iconbtn"
                  aria-label={`Remove the gap at Day ${position + 1}`}
                  onClick={() => updateDraft((d) => removeDay(d, position))}
                >
                  ✕
                </button>
              </li>
            );
          }
          return (
            <DayRow
              key={`day-${position}`}
              position={position}
              date={day.date}
              pool={day.pool}
              tutorial={day.tutorial}
              issues={issues.filter((i) => i.dayIndex === day.index)}
              onPool={(pool) => updateDraft((d) => setDayPool(d, position, pool))}
              onTutorial={(tutorial) => updateDraft((d) => setDayTutorial(d, position, tutorial))}
              onRemove={() => updateDraft((d) => removeDay(d, position))}
            />
          );
        })}
      </ul>
      <div className="squares-btnrow">
        <button
          type="button"
          className="btn"
          disabled={atCeiling}
          onClick={() => updateDraft((d) => addDay(d))}
        >
          Add a Day
        </button>
      </div>
      {atCeiling && (
        <p className="squares-note squares-ceiling" role="status">
          That is the {MAX_DAYS}-Day maximum. It is a rules fact, not a preference:
          <code> daysThemeLockOk</code> in <code>firestore.rules</code> unrolls its schedule lock
          over Day indexes 0–{MAX_DAYS - 1} only, so Day {MAX_DAYS + 1} would sit outside the lock
          and stay editable after it had unlocked.
        </p>
      )}
      <p className="squares-note">
        A Day is not a calendar date — two Days may share one (a competitive morning card and a
        closing wrap-up the same afternoon), so these rows are per Day and never merged by date. The
        final Day must deal from the <b>closing</b> pool: with no Day on it{' '}
        <code>finaleTimes</code> returns <code>null</code> — no standings freeze, no podium, no
        Most-Loved Photo. <b>counts ✓ / warm-up</b> is separate again: it decides only whether a
        Day&apos;s wins count toward Event-wide First to BINGO, and the pool never decides it.
        Unlock times, Themes and places are Look, the next step.
      </p>
    </>
  );
}

function DayRow({
  position,
  date,
  pool,
  tutorial,
  issues,
  onPool,
  onTutorial,
  onRemove,
}: {
  position: number;
  date: string;
  pool: DayDef['pool'];
  tutorial: boolean;
  issues: DraftIssue[];
  onPool: (pool: DayDef['pool']) => void;
  onTutorial: (tutorial: boolean) => void;
  onRemove: () => void;
}) {
  const label = `Day ${position + 1}`;
  return (
    <li className="squares-day-row" data-testid={`squares-day-${position}`}>
      <div className="squares-day-head">
        <span className="grow">
          {label}
          {date ? <span className="sub"> · {date}</span> : null}
        </span>
        {/* Normalized on READ only: a resumed draft can carry the legacy
            persisted `embark`/`farewell` spellings, which must select the
            right option rather than silently falling through to main. Writes
            are always canonical. */}
        <select
          aria-label={`${label} pool`}
          value={normalizePool(pool)}
          onChange={(e) => onPool(e.target.value as DayDef['pool'])}
        >
          <option value="main">main</option>
          <option value="easy">easy</option>
          <option value="closing">closing</option>
        </select>
        <select
          aria-label={`${label} counts toward First to BINGO`}
          value={tutorial ? 'warm-up' : 'counts'}
          onChange={(e) => onTutorial(e.target.value === 'warm-up')}
        >
          <option value="counts">counts ✓</option>
          <option value="warm-up">warm-up</option>
        </select>
        <button type="button" className="iconbtn" aria-label={`Remove ${label}`} onClick={onRemove}>
          ✕
        </button>
      </div>
      <IssueList issues={issues} label={`${label} problems`} />
    </li>
  );
}

/* ------------------------------------------------------------------ shared */

/** Blocking issues, rendered from the shared gate's own `message`s.
 *
 *  `role="status"` rather than `alert`: these are LIVE — they appear as the
 *  organizer edits, not in response to pressing Continue — and an assertive
 *  region that re-announces on every keystroke is hostile. The shell's
 *  own on-Continue list keeps `role="alert"`, where the interruption is the
 *  point. */
function IssueList({ issues, label }: { issues: DraftIssue[]; label: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="squares-issues" role="status" aria-label={label}>
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${i}`}>{issue.message}</li>
      ))}
    </ul>
  );
}
