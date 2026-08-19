/**
 * The draft transforms Step 3 · Squares commits through `updateDraft` (#791,
 * specs/event-setup-wizard.md § "Squares").
 *
 * Pure and React-free, for the reason `wizardSteps.ts` is: every rule here has
 * an edge the UI cannot demonstrate on its own — re-indexing after a removal,
 * the ten-Day refusal, what a hole in a pool does to a text edit — and each is
 * worth a unit test that renders nothing.
 *
 * TWO INVARIANTS RUN THROUGH ALL OF IT.
 *
 * 1. EVERY SUCCESSFUL TRANSFORM RETURNS A FULLY DENSE DRAFT — both `days` and
 *    all three prompt pools, through the single `normalizeDraft` chokepoint,
 *    whatever the edit was. A sparse draft is not merely
 *    untidy: `EventDraftStore.save` re-parses its own serialization before
 *    replacing the stored blob, `JSON.stringify` turns a hole into an explicit
 *    `null`, and `parseEventDraft` refuses that — so a draft that acquires one
 *    hole silently STOPS PERSISTING while the organizer keeps typing (spec
 *    § "Draft lifecycle" — Save). Holes are also invisible to the predicates
 *    that use `every`/`forEach`, which is why `assignedPoolIssues` counts real
 *    entries and `promptTextIssues` walks by index. Since a hole holds nothing
 *    an organizer could lose, compacting it out on the next edit is a repair
 *    with no cost — so these transforms build their results by index walk and
 *    drop holes rather than preserving them.
 * 2. NO TRANSFORM INFERS ONE FIELD FROM ANOTHER. `pool` decides what a Day
 *    deals; `tutorial` decides only whether its wins count toward Event-wide
 *    First to BINGO. Both are total, every combination is meaningful, and
 *    Bodega's easy-pool Friday is `tutorial: false` (#785) — so `setDayPool`
 *    leaves `tutorial` exactly as it found it, and `setDayTutorial` leaves
 *    `pool` alone. The same rule is why adding a Day does NOT move the closing
 *    pool onto it (see `addDay`).
 */

import type {
  DayDef,
  DraftCardFormat,
  DraftDayDef,
  DraftPromptPools,
  EventDraft,
} from '../types';
import type { PoolId } from '../game/pool';
import { MAX_DAYS, countPrompts } from './draftValidation';
import { occasionById } from './occasions';
import { seedPromptsFromPack, type StarterPack } from './starterPacks';

/** The three pools, in the order the step renders them. */
export const POOL_ORDER: readonly PoolId[] = ['main', 'easy', 'closing'];

/** A Day with only the fields Step 3 authors. Everything else is Step 4's
 *  (#792): `date`, `unlockAt`, `place`, `placeEmoji`, `theme` and `tonight`
 *  are left unset, and `dayCompletenessIssues` reports each one against the
 *  Look step until it does.
 *
 *  `freeText` is deliberately ABSENT rather than `''`: both the deal path and
 *  the locked-card preview read `day.freeText ?? FREE_TEXT`, so a present
 *  empty string does not mean "no override" — it SUPPRESSES the fallback and
 *  deals an empty centre Square. */
function blankDay(index: number, pool: DayDef['pool'], tutorial: boolean): DraftDayDef {
  return {
    index,
    date: '',
    unlockAt: null,
    place: '',
    placeEmoji: '',
    theme: null,
    pool,
    tutorial,
    tonight: [],
  };
}

/** The stored Days with holes dropped, in STORED ORDER.
 *
 *  Stored order, not sorted: `Board`, `eventPreview` and `DaySwitcher` all
 *  select `days[i]` by ARRAY POSITION, so the stored sequence is what ships —
 *  and `dayCompletenessIssues` judges `days[position].index === position` for
 *  exactly that reason. Sorting here would let this module quietly reorder a
 *  schedule the organizer can see. */
function denseDays(draft: EventDraft): DraftDayDef[] {
  return draft.days.filter((day) => day !== null && day !== undefined);
}

/** Renumber a Day list so `days[position].index === position`, the one
 *  property every launched-Day consumer relies on. */
function reindex(days: readonly DraftDayDef[]): DraftDayDef[] {
  return days.map((day, index) => (day.index === index ? day : { ...day, index }));
}

/**
 * The one chokepoint every successful transform returns through: BOTH
 * collections dense, on every edit, whatever the edit was.
 *
 * The guarantee has to be draft-wide because `EventDraftStore.save` is
 * draft-wide: it re-parses its own serialization and `parseEventDraft`
 * refuses the whole blob when EITHER `days` or any prompt pool carries a gap.
 * Densifying only the collection an edit happens to touch therefore does not
 * deliver the promise — a Day edit on a draft with a sparse pool, or a Prompt
 * edit on a draft with a sparse schedule, still leaves the draft unstorable,
 * so the change shows up in memory and is gone after a reload (Phase 4b P2).
 * Routing every return through here is what makes "any edit repairs it" true
 * rather than approximately true, and it is why the rule lives in one
 * function instead of being restated in each transform — three earlier review
 * rounds each found a different helper that had forgotten it.
 *
 * Entry objects are PRESERVED, only the arrays are rebuilt: `densePrompts`
 * and `denseDays` filter rather than copy, so the Prompt-row editor's
 * identity check still sees an untouched row as untouched.
 *
 * Days are renumbered as well as compacted: dropping a hole without
 * renumbering would leave `days[position].index !== position`, which is the
 * one property `Board`, `eventPreview` and `DaySwitcher` all select by. A
 * hole holds nothing an organizer could lose, so this is the same repair the
 * Day list's own gap row performs, applied consistently.
 *
 * No-op transforms deliberately do NOT come through here — they return the
 * original draft by identity, because nothing was edited and a refusal should
 * not quietly rewrite the draft it refused.
 */
function normalizeDraft(draft: EventDraft): EventDraft {
  return {
    ...draft,
    days: reindex(denseDays(draft)),
    prompts: {
      main: densePrompts(draft.prompts.main),
      easy: densePrompts(draft.prompts.easy),
      closing: densePrompts(draft.prompts.closing),
    },
  };
}

/**
 * The Days an occasion's schedule SHAPE proposes — pools and tutorial flags
 * only.
 *
 * Deliberately not unlock instants: turning an `OccasionScheduleShape`'s
 * `unlockTime` into an absolute `unlockAt` needs a zone-aware clock and is
 * Step 4's job (spec § "The occasion matrix"). Shape is clock-free, so Step 3
 * can propose it without borrowing that job.
 *
 * `schedule: null` yields NO Days, not one invented one. It means the occasion
 * proposes no schedule at all — Wedding because a one-card Event has none, and
 * Custom because "Start empty, choose everything" is the whole point, so Step 4
 * "authors every Day from nothing rather than deleting rows the organizer never
 * asked for" (spec § "The occasion matrix"). An empty schedule is not a silent
 * state either: `dayCountIssues` reports `no-days`, this step renders it, and
 * "Add a Day" sits directly underneath.
 *
 * When a schedule proposes a single Day, the FINAL Day's pool and tutorial flag
 * win over the first's. The finale is the rules fact — `finaleTimes` returns
 * `null` with no Day on the closing pool, and there is then no standings
 * freeze, no podium and no Most-Loved Photo — whereas "the opener is a warm-up"
 * is a preference. A one-Day schedule is its own finale.
 */
function daysFromOccasion(draft: EventDraft): DraftDayDef[] {
  const schedule = occasionById(draft.occasion)?.defaults.schedule ?? null;
  if (!schedule) return [];
  const count = Math.max(1, Math.min(MAX_DAYS, schedule.dayCount));
  return Array.from({ length: count }, (_unused, index) => {
    const isFinal = index === count - 1;
    const isFirst = index === 0;
    if (isFinal) return blankDay(index, schedule.finalDayPool, schedule.finalDayTutorial);
    if (isFirst) return blankDay(index, schedule.firstDayPool, schedule.firstDayTutorial);
    return blankDay(index, 'main', false);
  });
}

/**
 * Switch between the one-card and daily-cards shapes.
 *
 * `one_card` IS an Event with an empty `days[]`, so switching to it CLEARS the
 * schedule — the same single destructive move `applyOccasionDefaults` makes
 * when a one-card occasion is re-picked, and for the same reason: a one-card
 * draft carrying Days fails `dayCountIssues` (`one-card-has-days`) and no
 * Day-authoring surface, all of them scoped to `daily_cards`, can reach the
 * rows to delete them. The step warns before calling this; see `StepSquares`.
 *
 * Switching BACK proposes the occasion's schedule shape rather than restoring
 * what was cleared. Nothing is kept to restore, and re-deriving from the
 * occasion is the same answer Step 1 would have given.
 */
export function setCardFormat(draft: EventDraft, cardFormat: DraftCardFormat): EventDraft {
  if (cardFormat === draft.cardFormat) return draft;
  if (cardFormat === 'one_card') return normalizeDraft({ ...draft, cardFormat, days: [] });
  const existing = denseDays(draft);
  return normalizeDraft({
    ...draft,
    cardFormat,
    days: existing.length > 0 ? existing : daysFromOccasion(draft),
  });
}

/** Whether another Day may be added. The ceiling is a RULES fact, not a
 *  product preference: `daysThemeLockOk` (`firestore.rules`) unrolls its
 *  schedule lock over indexes 0–9 only, so an eleventh Day would sit outside
 *  the lock and stay editable after it had unlocked. */
export function canAddDay(draft: EventDraft): boolean {
  return draft.cardFormat === 'daily_cards' && denseDays(draft).length < MAX_DAYS;
}

/**
 * Append a Day.
 *
 * The new Day lands on the MAIN pool and `tutorial: false`, and NOTHING ELSE
 * MOVES — in particular, the closing pool is not lifted off the Day that
 * currently holds it. That is deliberate. Reassigning a pool the organizer
 * chose is exactly the "looked honoured, silently changed" class of failure
 * #785 catalogues, and the two predicates that now fire say precisely what to
 * do: `no-closing-day` names the new final Day, `extra-closing-day` names the
 * old one and explains that the finale resolves to the FIRST closing Day. Both
 * render anchored to their own rows, where the pool control already sits.
 *
 * Refuses past `MAX_DAYS` by returning the draft unchanged; the step disables
 * the control and states the reason rather than letting the refusal be silent.
 */
export function addDay(draft: EventDraft): EventDraft {
  if (!canAddDay(draft)) return draft;
  const days = denseDays(draft);
  return normalizeDraft({ ...draft, days: [...days, blankDay(days.length, 'main', false)] });
}

/** Remove the Day at `position` in the stored array and renumber the rest, so
 *  `days[position].index === position` still holds. */
export function removeDay(draft: EventDraft, position: number): EventDraft {
  const days = denseDays(draft);
  if (position < 0 || position >= draft.days.length) return draft;
  const removed = draft.days[position];
  return normalizeDraft({
    ...draft,
    // Compare by identity rather than re-deriving the position: `denseDays`
    // may have shifted it when the stored array held holes before `position`.
    days: removed ? days.filter((day) => day !== removed) : days,
  });
}

/**
 * Set one Day's pool, leaving `tutorial` untouched.
 *
 * Two Days MAY share a `date` — Bodega's Sunday is a competitive main-pool Day
 * at 06:00 and a closing wrap-up at 11:00 (#785) — so this addresses a Day by
 * its POSITION in the schedule and never by its date. Collapsing the two would
 * delete the competitive card and freeze standings early.
 */
export function setDayPool(draft: EventDraft, position: number, pool: DayDef['pool']): EventDraft {
  return patchDay(draft, position, (day) => ({ ...day, pool }));
}

/**
 * Set one Day's `tutorial` flag, leaving `pool` untouched.
 *
 * `tutorial: true` excludes the Day from Event-wide First to BINGO ("warm-up")
 * and does nothing else; `false` is "counts ✓". It is NOT inferable from the
 * pool in either direction, and it is a different set again from *ceremonial*
 * for standings (`ceremonialDayIndexSet`), which the wizard does not author —
 * one control labelled for both would set neither (#785, ADR 0011 / #531).
 */
export function setDayTutorial(draft: EventDraft, position: number, tutorial: boolean): EventDraft {
  return patchDay(draft, position, (day) => ({ ...day, tutorial }));
}

function patchDay(
  draft: EventDraft,
  position: number,
  patch: (day: DraftDayDef) => DraftDayDef,
): EventDraft {
  const target = draft.days[position];
  if (!target) return draft;
  return normalizeDraft({
    ...draft,
    days: denseDays(draft).map((day) => (day === target ? patch(day) : day)),
  });
}

/**
 * Replace every pool with a pack's contents.
 *
 * Seeding REPLACES rather than merges, and the step confirms before calling it
 * on a non-empty draft. The draft contract carries no per-Prompt provenance —
 * a Prompt is `{ text, spicy }` and nothing more — so nothing here can tell a
 * pack's Prompt from one the organizer typed, and a "swap the pack, keep my
 * own" merge would have to guess. Adding provenance is a `DraftMainPrompt`
 * change behind a `DRAFT_SCHEMA_VERSION` bump, which belongs to the ticket
 * that owns the draft type (#787), not to this step. So the step states the
 * cost in the confirm instead of guessing at it.
 */
export function seedPack(draft: EventDraft, pack: StarterPack): EventDraft {
  return normalizeDraft({ ...draft, prompts: seedPromptsFromPack(pack) });
}

/** Real entries per pool, for the live counter. `countPrompts` is imported
 *  from the gate itself so the number shown and the number judged are the same
 *  number — a nominal `.length` here would render "24 ✓" beside a
 *  `pool-below-minimum` issue raised over 23 real entries. */
export function poolCounts(draft: EventDraft): Record<PoolId, number> {
  return {
    main: countPrompts(draft.prompts.main),
    easy: countPrompts(draft.prompts.easy),
    closing: countPrompts(draft.prompts.closing),
  };
}

/**
 * Append an authored Prompt.
 *
 * `spicy` is accepted for the main pool ALONE and dropped for the others —
 * the type already says so (`DraftCuratedPrompt['spicy']: never`), and this is
 * the runtime half of the same rule. `adminAddItem` forces `spicy: false`
 * outside main and the 18+ posture derivation ignores non-main pools, so a
 * spicy curated Prompt is not a stronger flag, it is a silently dropped one —
 * an explicit Square reaching a card with no 18+ gate (#785). The step renders
 * no control to drop in the first place; this makes the drop unrepresentable
 * rather than merely unrendered.
 *
 * Text is stored TRIMMED. `firestore.rules` applies `text.size() <= 80` to the
 * value as persisted, so 80 visible characters plus a trailing space is 81
 * stored and refused at provisioning — `promptTextIssues` measures the raw
 * string for the same reason. Blank text is refused outright rather than
 * appended and then reported.
 */
export function addPrompt(
  draft: EventDraft,
  pool: PoolId,
  text: string,
  spicy: boolean,
): EventDraft {
  const trimmed = text.trim();
  if (trimmed === '') return draft;
  const prompts: DraftPromptPools = {
    main: densePrompts(draft.prompts.main),
    easy: densePrompts(draft.prompts.easy),
    closing: densePrompts(draft.prompts.closing),
  };
  if (pool === 'main') prompts.main = [...prompts.main, { text: trimmed, spicy }];
  else prompts[pool] = [...prompts[pool], { text: trimmed }];
  return normalizeDraft({ ...draft, prompts });
}

/** Drop the Prompt at `position` in `pool`. Holes anywhere in that pool go
 *  with it (invariant 1) — the step renders each hole as its own removable
 *  row so the repair is reachable at all. */
export function removePrompt(draft: EventDraft, pool: PoolId, position: number): EventDraft {
  return mapPool(draft, pool, (entry, index) => (index === position ? null : entry));
}

/** Retitle the Prompt at `position`. Blank text is refused rather than stored:
 *  `promptTextIssues` would report it, but a Prompt the organizer can only
 *  blank and never restore is a worse editor than one that declines. */
export function setPromptText(
  draft: EventDraft,
  pool: PoolId,
  position: number,
  text: string,
): EventDraft {
  const trimmed = text.trim();
  if (trimmed === '') return draft;
  return mapPool(draft, pool, (entry, index) =>
    index === position ? { ...entry, text: trimmed } : entry,
  );
}

/** Flip one main-pool Prompt's `spicy` flag.
 *
 *  Main-pool only, by signature: there is no curated equivalent, because the
 *  18+ derivation (`settings.forceAdult || any active spicy main-pool Prompt`)
 *  never reads one. Offered on existing rows and not just at the add bar
 *  because that derivation is what raises the Event's 18+ acknowledgement —
 *  a seeded or mis-tapped flag with no way back would decide an Event's
 *  audience posture with no repair path inside the wizard. */
export function setMainPromptSpicy(
  draft: EventDraft,
  position: number,
  spicy: boolean,
): EventDraft {
  return mapPool(draft, 'main', (entry, index) =>
    index === position ? { ...entry, spicy } : entry,
  );
}

/**
 * Texts that appear more than once within a pool, per pool.
 *
 * ADVISORY, NOT A GATE — deliberately. Twenty-four identically worded Prompts
 * clear `MIN_POOL` and deal a legal but miserable card (spec § "Deliberately
 * not in this ticket", which assigns the concern to this step), so it is worth
 * saying out loud. It is not worth BLOCKING: a repeated Prompt breaks no
 * downstream contract — `dealBoard` deals it, `firestore.rules` accepts it —
 * and a duplicate can be perfectly deliberate on a long schedule. Making it a
 * `DraftIssueCode` would also put it in the shared launch gate and the
 * provisioner's own refusal, which is a much larger claim than "this card will
 * be dull".
 *
 * Compared case-insensitively on the trimmed text, because that is the
 * distinction a player would fail to notice on a card.
 */
export function duplicatePromptTexts(draft: EventDraft): Record<PoolId, string[]> {
  const out = { main: [] as string[], easy: [] as string[], closing: [] as string[] };
  for (const pool of POOL_ORDER) {
    const seen = new Map<string, string>();
    const reported = new Set<string>();
    for (const entry of draft.prompts[pool] as readonly unknown[]) {
      if (entry === null || entry === undefined) continue;
      const raw = (entry as { text?: unknown }).text;
      if (typeof raw !== 'string') continue;
      const key = raw.trim().toLocaleLowerCase();
      if (key === '') continue;
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, raw.trim());
        continue;
      }
      if (!reported.has(key)) {
        reported.add(key);
        out[pool].push(first);
      }
    }
  }
  return out;
}

/**
 * The pool's real entries in order — holes AND explicit `null`/`undefined`
 * both dropped.
 *
 * `filter(() => true)` drops only holes and would KEEP an explicit `null`,
 * which defeats the whole point at the moment it matters most: `addPrompt`
 * compacts through here, so adding a Prompt to a pool carrying an explicit
 * missing entry left that entry in place, `parseEventDraft` refused the
 * serialized draft, and `save` kept the previous blob — the new Prompt
 * appeared in memory and silently vanished on the next load (Codex P2, round
 * 3). Matches `countPrompts` and `mapPool`, and makes the spec's "every
 * transform returns a dense array" true for the explicit case too.
 */
function densePrompts<T>(prompts: readonly T[]): T[] {
  return prompts.filter((prompt) => prompt !== null && prompt !== undefined);
}

/**
 * Rebuild one pool by INDEX WALK, dropping holes and any entry the mapper
 * returns `null` for.
 *
 * An index walk rather than `map`: `Array.prototype.map` preserves holes (it
 * skips the callback but keeps the slot), so a `map`-based edit would leave
 * the draft sparse and therefore unsaveable. Positions are the CALLER's — the
 * ones the step just rendered from the stored array, holes included — so a row
 * and its edit always refer to the same entry.
 */
function mapPool(
  draft: EventDraft,
  pool: PoolId,
  mapper: (entry: { text: string; spicy?: boolean }, index: number) => unknown,
): EventDraft {
  const source = draft.prompts[pool] as readonly unknown[];
  const next: unknown[] = [];
  for (let index = 0; index < source.length; index++) {
    const entry = source[index];
    if (entry === null || entry === undefined) continue;
    const mapped = mapper(entry as { text: string; spicy?: boolean }, index);
    if (mapped === null || mapped === undefined) continue;
    next.push(mapped);
  }
  // EVERY pool is compacted, not just the edited one. Storability is a
  // property of the whole draft: `save` re-parses its own serialization and
  // `parseEventDraft` refuses the `null` a hole or an explicit missing entry
  // serializes to, so leaving a gap in either OTHER pool means this edit —
  // and every edit after it — silently stops persisting while the organizer
  // keeps typing. `addPrompt` already compacted all three; this is the same
  // guarantee for the edit paths (Codex P2, round 4).
  return normalizeDraft({
    ...draft,
    prompts: { ...draft.prompts, [pool]: next } as DraftPromptPools,
  });
}
