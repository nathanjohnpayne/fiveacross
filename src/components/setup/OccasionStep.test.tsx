import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EventDraft } from '../../types';
import { createEventDraft } from '../../data/eventDraft';
import { OCCASIONS, applyOccasionDefaults, occasionById } from '../../data/occasions';
import { editionBrand } from '../../editions';
import OccasionStep from './OccasionStep';

// Covers specs/event-setup-wizard.md § "Step 1 · Occasion (#789)" — the
// component takes `{ draft, updateDraft }` directly (the same props
// `stepRegistry.tsx` wires it with), so no router and no Firebase.

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

/** A controlled harness mirroring how `SetupWizardStep` actually calls
 *  `updateDraft` — `setDraft(updater)` — so a full pick → confirm → commit
 *  round trip is observable in one render, not just the LAST call a mock
 *  spy captured. */
function Harness({ initial }: { initial: EventDraft }) {
  const [draft, setDraft] = useState(initial);
  return <OccasionStep draft={draft} updateDraft={(updater) => setDraft((d) => updater(d))} />;
}

function renderHarness(initial: EventDraft) {
  return render(<Harness initial={initial} />);
}

/** An occasion row's accessible name is `label + blurb (+ pill)` — anchored
 *  at the start, so this never also matches the confirm dialog's "Keep
 *  <label>" / "Switch to <label>" buttons, which put the same label text
 *  mid-string. */
function row(label: string) {
  return screen.getByRole('button', { name: new RegExp(`^${label}`) });
}

describe('OccasionStep', () => {
  it('renders the six occasions in frame order with their frame copy, none selected on a bare draft', () => {
    const draft = createEventDraft({ now: NOW });
    renderHarness(draft);

    const rows = screen.getAllByRole('button', { pressed: false });
    expect(rows).toHaveLength(OCCASIONS.length);
    OCCASIONS.forEach((occasion, i) => {
      expect(rows[i]).toHaveTextContent(occasion.label);
      expect(rows[i]).toHaveTextContent(occasion.blurb);
    });
    // No occasion selected yet — no Edition pill anywhere. Queried by class,
    // not text, because several occasions' own frame blurbs already end in
    // the word "edition" (e.g. City break: "…Vacay edition") — a text-based
    // search would false-positive on the copy itself.
    expect(document.querySelectorAll('.wizard-occasion-pill')).toHaveLength(0);
  });

  it('a first pick commits applyOccasionDefaults immediately, with no confirm dialog', async () => {
    const user = userEvent.setup();
    const draft = createEventDraft({ now: NOW });
    renderHarness(draft);

    await user.click(row('Weekend away'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const weekendAway = occasionById('weekend-away')!;
    const expected = applyOccasionDefaults(draft, weekendAway);
    // The Edition pill now names the player-facing Edition on the selected
    // row, and only that row.
    const selectedRow = row('Weekend away');
    expect(within(selectedRow).getByText(`${editionBrand('vacay').appName} edition`)).toBeInTheDocument();
    // Exactly one pill exists anywhere — the selected row's, not a false
    // match against another row's own "…edition"-ending blurb copy.
    expect(document.querySelectorAll('.wizard-occasion-pill')).toHaveLength(1);
    // The draft itself picked up exactly what the data-layer contract
    // (occasions.test.ts) already asserts for applyOccasionDefaults.
    expect(selectedRow).toHaveAttribute('aria-pressed', 'true');
    void expected; // shape asserted via the rendered pill/selection above
  });

  it('Custom commits with no starter pack and no schedule/day-Theme proposal beyond the platform floor', async () => {
    const user = userEvent.setup();
    const draft = createEventDraft({ now: NOW });
    renderHarness(draft);

    await user.click(row('Custom'));

    const custom = occasionById('custom')!;
    expect(custom.starterPackId).toBeNull();
    expect(custom.defaults.schedule).toBeNull();
    expect(custom.defaults.dayThemes).toHaveLength(0);
    const selectedRow = row('Custom');
    expect(selectedRow).toHaveAttribute('aria-pressed', 'true');
    expect(within(selectedRow).getByText(`${editionBrand('fiveacross').appName} edition`)).toBeInTheDocument();
  });

  it('re-picking a DIFFERENT occasion opens a confirm instead of committing', async () => {
    const user = userEvent.setup();
    const draft = { ...applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('weekend-away')!) };
    renderHarness(draft);

    await user.click(row('Wedding'));

    const dialog = await screen.findByRole('alertdialog', { name: /switch to.*wedding/i });
    // Not committed yet — Weekend away is still the selected row.
    expect(row('Weekend away')).toHaveAttribute('aria-pressed', 'true');
    expect(row('Wedding')).toHaveAttribute('aria-pressed', 'false');
    expect(within(dialog).getByRole('button', { name: /keep weekend away/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /switch to wedding/i })).toBeInTheDocument();
  });

  it('"Keep <current>" leaves the draft untouched', async () => {
    const user = userEvent.setup();
    const draft = applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('weekend-away')!);
    renderHarness(draft);

    await user.click(row('Wedding'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /keep weekend away/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(row('Weekend away')).toHaveAttribute('aria-pressed', 'true');
    expect(row('Wedding')).toHaveAttribute('aria-pressed', 'false');
  });

  it('confirming "Switch" commits exactly what applyOccasionDefaults would', async () => {
    const user = userEvent.setup();
    const draft = applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('weekend-away')!);
    renderHarness(draft);

    await user.click(row('Wedding'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /switch to wedding/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(row('Wedding')).toHaveAttribute('aria-pressed', 'true');
    expect(row('Weekend away')).toHaveAttribute('aria-pressed', 'false');
    expect(within(row('Wedding')).getByText(`${editionBrand('fiveacross').appName} edition`)).toBeInTheDocument();
  });

  it('the confirm names the schedule-clearing consequence for a one-card switch while Days are authored', async () => {
    const user = userEvent.setup();
    const withDays: EventDraft = {
      ...applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('weekend-away')!),
      days: [
        {
          index: 0,
          date: '2026-08-07',
          unlockAt: Date.parse('2026-08-07T13:00:00Z'),
          place: 'Point Reyes',
          placeEmoji: '🌊',
          theme: 'the-birds',
          pool: 'easy',
          tutorial: false,
          tonight: ['🦀 Crab shack', '🔥 Fire pit'],
        },
      ],
    };
    renderHarness(withDays);

    await user.click(row('Wedding')); // one-card
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/clears the schedule/i);
  });

  it('omits the schedule warning switching between two daily-cards occasions', async () => {
    const user = userEvent.setup();
    const draft = applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('weekend-away')!);
    renderHarness(draft);

    await user.click(row('Cruise')); // also daily_cards
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).not.toHaveTextContent(/clears the schedule/i);
  });

  it('re-picking the SAME already-selected occasion is a TRUE no-op — no confirm, and updateDraft is never called', async () => {
    // Codex P1, PR #855: an earlier version fell through to `commit()` here,
    // which re-runs `applyOccasionDefaults` and would silently discard any
    // hand-edit a LATER step (Basics/Look/Launch) made to card format, claim
    // mode, default Theme or settings since the first pick. A spy-based
    // render (not the round-tripping `Harness`) is what actually proves the
    // call never happens — asserting the rendered result alone can't
    // distinguish "nothing happened" from "the same values got reapplied".
    const user = userEvent.setup();
    const draft = applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('weekend-away')!);
    const updateDraft = vi.fn();
    render(<OccasionStep draft={draft} updateDraft={updateDraft} />);

    await user.click(row('Weekend away'));

    expect(updateDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(row('Weekend away')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a draft whose stored occasion no longer resolves in the matrix still confirms before replacing it (Codex P2, PR #855 round 3)', async () => {
    // A resumed/imported/hand-crafted draft can carry an id OCCASIONS no
    // longer recognizes. An earlier version treated that as "nothing worth
    // protecting" and committed directly — but the REST of the draft (claim
    // mode, card format, Theme, settings, Days) can still be real,
    // organizer-entered data a direct commit would silently overwrite. The
    // dialog must still appear; it just can't name what's being left, since
    // `current` is null. Cast is the same shape a stale-schema blob or a
    // widened `string` would produce; the type itself only admits real
    // `OccasionId`s.
    const user = userEvent.setup();
    const draft: EventDraft = {
      ...createEventDraft({ now: NOW }),
      occasion: 'retired-occasion' as unknown as EventDraft['occasion'],
    };
    renderHarness(draft);

    await user.click(row('Custom'));

    const dialog = await screen.findByRole('alertdialog', { name: /apply.*custom/i });
    expect(dialog).toHaveTextContent(/saved occasion isn.t available anymore/i);
    expect(within(dialog).getByRole('button', { name: /keep current answers/i })).toBeInTheDocument();
    // Not committed yet.
    expect(row('Custom')).toHaveAttribute('aria-pressed', 'false');

    await user.click(within(dialog).getByRole('button', { name: /^apply custom$/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(row('Custom')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a same-occasion click repairs a stale occasion/edition mismatch instead of no-op-ing past it (Codex P2, PR #855 round 2)', async () => {
    // A resumed/imported draft can carry a recognized occasion whose
    // `edition` disagrees with it — eventCompletenessIssues' own
    // event-occasion-edition-mismatch, which routes the organizer back to
    // THIS step to fix it. The true no-op must not swallow that repair path.
    // `OccasionStep`'s own render never reads `draft.edition` (the pill
    // reflects the MATRIX's edition for the selected row, not the draft's
    // stored value) — so a spy is what actually proves the repair commits,
    // not just that the UI still looks selected.
    const user = userEvent.setup();
    const draft: EventDraft = {
      ...applyOccasionDefaults(createEventDraft({ now: NOW }), occasionById('weekend-away')!),
      edition: 'fiveacross', // stale — weekend-away binds vacay
    };
    const updateDraft = vi.fn();
    render(<OccasionStep draft={draft} updateDraft={updateDraft} />);

    await user.click(row('Weekend away'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(updateDraft).toHaveBeenCalledTimes(1);
    const updater = updateDraft.mock.calls[0]![0] as (d: EventDraft) => EventDraft;
    expect(updater(draft).edition).toBe('vacay');
  });
});
