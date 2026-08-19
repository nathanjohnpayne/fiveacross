import { useState, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { EventDraft } from '../../types';
import { deviceTimezoneSuggestion } from '../../data/eventDraft';
import { isSupportedTimezone } from '../../data/draftValidation';
import { createEventDraft } from '../../data/eventDraft';
import StepBasics, { CHECK_DEBOUNCE_MS, slugify } from './StepBasics';
import type { SlugAvailability } from '../../data/hostnames';

// Covers specs/event-setup-wizard.md § "Step 2 · Basics" (#790): name, dates,
// timezone, the live-checked address (the shared #545 Slug contract, the
// availability helper, and the alternate-Namespace preview), marking mode,
// and audience. No Firebase: `checkSlugAvailability` is the one seam this
// component talks to the network through, and it is mocked whole, matching
// this codebase's convention for a component that only calls a handful of a
// sibling data module's exports (`PromptPool.test.tsx`).

const mocks = vi.hoisted(() => ({
  checkSlugAvailability: vi.fn<(hostname: string) => Promise<SlugAvailability>>(),
}));

// The component asks `checkEventAddressAvailability` for every address a launch
// would claim, but these tests still drive the per-HOSTNAME answer, so the stub
// fans one out over the same helper the real one composes. That keeps each test
// expressing "this address answers X" rather than having to know the shape of
// the multi-host result, and it means a test seeding one answer still exercises
// the canonical/alternate fan-out rather than bypassing it.
vi.mock('../../data/hostnames', () => ({
  checkSlugAvailability: mocks.checkSlugAvailability,
  checkEventAddressAvailability: async (slug: string, alternateApex: string | null) => {
    const hosts = [`${slug}.fiveacross.app`];
    if (alternateApex !== null) hosts.push(`${slug}.${alternateApex}`);
    return Promise.all(
      hosts.map(async (hostname) => ({ hostname, status: await mocks.checkSlugAvailability(hostname) })),
    );
  },
}));

function draftWith(over: Partial<EventDraft> = {}): EventDraft {
  return { ...createEventDraft({ now: Date.now(), draftId: 'draft-1', timezone: 'America/Los_Angeles' }), ...over };
}

/**
 * A minimal harness that mirrors the wizard shell's own `updateDraft`
 * contract (`StepRenderProps`): a real stateful parent, exactly like
 * `SetupWizard`'s `updateDraft` closing over `setDraft`. A hand-rolled
 * `rerender(...)` call from inside `updateDraft` itself does not work here —
 * `StepBasics`'s OWN mount effect can call `updateDraft` synchronously
 * (inside the `act()` that `render()` wraps), before a destructured
 * `rerender` reference would be assigned — so state genuinely has to live in
 * React, not in a closure this test manufactures.
 */
function Harness({ initial, onDraft }: { initial: EventDraft; onDraft: (d: EventDraft) => void }) {
  const [draft, setDraft] = useState(initial);
  // Published from an effect, never during render (CodeRabbit, PR #911).
  // Calling `onDraft` in the render body writes to test-observed state as a
  // side effect of rendering, which React is free to replay or discard — so
  // `getDraft()` could report a draft that was never committed. Under
  // StrictMode's double-render that stops being theoretical.
  useEffect(() => {
    onDraft(draft);
  }, [draft, onDraft]);
  return <StepBasics draft={draft} updateDraft={(updater) => setDraft((d) => updater(d))} />;
}

function renderStep(initial: EventDraft) {
  let current = initial;
  render(<Harness initial={initial} onDraft={(d) => { current = d; }} />);
  return { getDraft: () => current };
}

const addressInput = () => screen.getByLabelText('Event address');

async function settleDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
  });
}

beforeEach(() => {
  mocks.checkSlugAvailability.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('slugify — the name → address starting point', () => {
  it('lowercases, folds non-alphanumerics to single hyphens, and trims edges', () => {
    expect(slugify('Weekend in Point Reyes')).toBe('weekend-in-point-reyes');
    expect(slugify('  --Point   Reyes!! ')).toBe('point-reyes');
  });

  it('caps at the Slug length ceiling without leaving a trailing hyphen', () => {
    const long = 'a'.repeat(70) + ' b';
    expect(slugify(long).length).toBeLessThanOrEqual(63);
    expect(slugify(long).endsWith('-')).toBe(false);
  });
});

describe('name, dates, timezone', () => {
  it('writes the name field straight through updateDraft', () => {
    const { getDraft } = renderStep(draftWith());
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Weekend in Point Reyes' } });
    expect(getDraft().name).toBe('Weekend in Point Reyes');
  });

  it('writes both date fields independently', () => {
    const { getDraft } = renderStep(draftWith());
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-07' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-09' } });
    expect(getDraft().startsOn).toBe('2026-08-07');
    expect(getDraft().endsOn).toBe('2026-08-09');
  });

  it('flags a timezone the read-side contract would silently rewrite', () => {
    renderStep(draftWith({ timezone: 'UTC' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/not a recognized/i);
  });

  it('shows no hint for a timezone the read-side contract accepts as-is', () => {
    renderStep(draftWith({ timezone: 'America/Los_Angeles' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('"Use this device\'s zone" writes a suggestion the validator ACCEPTS, not merely whatever the device reports', () => {
    // Two assertions, and the second is the one that matters (CodeRabbit
    // Major, PR #911). An earlier fix here compared the written value against
    // `deviceTimezoneSuggestion()` and stopped there — which passes on a UTC
    // host precisely BECAUSE the button wrote the invalid value 'UTC'. A test
    // that goes green exactly when the feature is broken is worse than none.
    if (!isSupportedTimezone(deviceTimezoneSuggestion())) return; // covered by the sibling test below
    const { getDraft } = renderStep(draftWith({ timezone: 'Pacific/Auckland' }));
    fireEvent.click(screen.getByRole('button', { name: "Use this device's zone" }));
    expect(getDraft().timezone).toBe(deviceTimezoneSuggestion());
    expect(isSupportedTimezone(getDraft().timezone)).toBe(true);
  });

  it('withdraws the device-zone button entirely when the device reports a zone the contract refuses', () => {
    // The UTC-host case, which is every CI runner and plenty of servers. The
    // control used to be offered there and wrote 'UTC', which
    // `isSupportedTimezone` rejects — a button whose purpose is to FIX the
    // field putting it into an error state.
    if (isSupportedTimezone(deviceTimezoneSuggestion())) return; // covered by the sibling test above
    renderStep(draftWith({ timezone: 'Pacific/Auckland' }));
    expect(screen.queryByRole('button', { name: "Use this device's zone" })).not.toBeInTheDocument();
    expect(screen.getByText(/isn't specific enough/i)).toBeInTheDocument();
  });});

describe('address — auto-generation and "editable once"', () => {
  it('auto-generates the address from the name while untouched', () => {
    renderStep(draftWith({ name: 'Weekend in Point Reyes' }));
    expect(addressInput()).toHaveValue('weekend-in-point-reyes');
  });

  it('keeps regenerating as the name changes, until the organizer edits the address directly', () => {
    renderStep(draftWith());
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Point Reyes' } });
    expect(addressInput()).toHaveValue('point-reyes');

    fireEvent.change(addressInput(), { target: { value: 'my-own-address' } });
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Something Else Entirely' } });
    // The manual edit stuck; the later name change did not overwrite it.
    expect(addressInput()).toHaveValue('my-own-address');
  });
});

describe('address — live format + availability checking (#785 acceptance)', () => {
  it('rejects a reserved label client-side, WITHOUT a network read', async () => {
    renderStep(draftWith());
    fireEvent.change(addressInput(), { target: { value: 'admin' } });
    await settleDebounce();
    expect(screen.getByTestId('address-availability-status')).toHaveTextContent(/reserved/i);
    expect(mocks.checkSlugAvailability).not.toHaveBeenCalled();
  });

  it('rejects a malformed candidate client-side, without a network read', async () => {
    renderStep(draftWith());
    fireEvent.change(addressInput(), { target: { value: 'Bodega Bay!' } });
    await settleDebounce();
    expect(screen.getByTestId('address-availability-status')).toHaveTextContent(/lowercase/i);
    expect(mocks.checkSlugAvailability).not.toHaveBeenCalled();
  });

  it('checks a well-formed candidate against <slug>.fiveacross.app and commits it once confirmed available', async () => {
    mocks.checkSlugAvailability.mockResolvedValue('available');
    const { getDraft } = renderStep(draftWith());
    fireEvent.change(addressInput(), { target: { value: 'point-reyes' } });

    // Fails closed WHILE the check is in flight.
    expect(getDraft().slugCandidate).toBe('');

    await settleDebounce();
    expect(mocks.checkSlugAvailability).toHaveBeenCalledWith('point-reyes.fiveacross.app');
    expect(screen.getByTestId('address-availability-status')).toHaveTextContent(/available/i);
    expect(getDraft().slugCandidate).toBe('point-reyes');
  });

  it('fails closed on "taken" — the field shows taken and the candidate is not committed', async () => {
    mocks.checkSlugAvailability.mockResolvedValue('taken');
    const { getDraft } = renderStep(draftWith());
    fireEvent.change(addressInput(), { target: { value: 'bodega-bay' } });
    await settleDebounce();
    expect(screen.getByTestId('address-availability-status')).toHaveTextContent(/already taken/i);
    expect(getDraft().slugCandidate).toBe('');
  });

  it('fails closed on a failed check, same as "taken"', async () => {
    mocks.checkSlugAvailability.mockResolvedValue('check-failed');
    const { getDraft } = renderStep(draftWith());
    fireEvent.change(addressInput(), { target: { value: 'point-reyes' } });
    await settleDebounce();
    expect(screen.getByTestId('address-availability-status')).toHaveTextContent(/couldn't check/i);
    expect(getDraft().slugCandidate).toBe('');
  });

  it('drops a superseded response — only the LATEST candidate\'s check may ever commit', async () => {
    let resolveFirst!: (v: SlugAvailability) => void;
    mocks.checkSlugAvailability.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    const { getDraft } = renderStep(draftWith());

    fireEvent.change(addressInput(), { target: { value: 'first-candidate' } });
    await settleDebounce(); // fires the first (still-pending) network call

    mocks.checkSlugAvailability.mockResolvedValue('available');
    fireEvent.change(addressInput(), { target: { value: 'second-candidate' } });
    await settleDebounce(); // the second candidate resolves and commits

    expect(getDraft().slugCandidate).toBe('second-candidate');

    // The stale first response arrives late — it must NOT stomp the newer commit.
    await act(async () => {
      resolveFirst('available');
      await Promise.resolve();
    });
    expect(getDraft().slugCandidate).toBe('second-candidate');
  });

  it('trusts an already-committed candidate optimistically on mount, then re-verifies in the background', async () => {
    mocks.checkSlugAvailability.mockResolvedValue('available');
    const { getDraft } = renderStep(draftWith({ slugCandidate: 'point-reyes' }));
    // Immediately available — a revisit of a step the organizer already
    // completed must not block Continue on a network round trip for a
    // value already confirmed once (a seeded/resumed "complete" draft has
    // to read as complete on arrival, not after ~400ms + a network read).
    expect(screen.getByTestId('address-availability-status')).toHaveTextContent(/available/i);
    expect(getDraft().slugCandidate).toBe('point-reyes');

    // The background re-check still runs, against the real Namespace host.
    await settleDebounce();
    expect(mocks.checkSlugAvailability).toHaveBeenCalledWith('point-reyes.fiveacross.app');
    expect(getDraft().slugCandidate).toBe('point-reyes');
  });

  it('downgrades an optimistically-trusted candidate the moment a background re-check learns it is gone', async () => {
    mocks.checkSlugAvailability.mockResolvedValue('taken');
    const { getDraft } = renderStep(draftWith({ slugCandidate: 'point-reyes' }));
    expect(screen.getByTestId('address-availability-status')).toHaveTextContent(/available/i);

    await settleDebounce();
    expect(screen.getByTestId('address-availability-status')).toHaveTextContent(/already taken/i);
    expect(getDraft().slugCandidate).toBe('');
  });
});

describe('address — both hostnames preview, canonical first', () => {
  it('shows only the canonical host for an Edition with no alternate Namespace', async () => {
    renderStep(draftWith({ edition: 'fiveacross', name: 'Wedding of Sam and Lee' }));
    expect(screen.getByText(/wedding-of-sam-and-lee\.fiveacross\.app · canonical/)).toBeInTheDocument();
    expect(screen.queryByText(/Edition alternate/)).not.toBeInTheDocument();
  });

  it('shows canonical THEN the Edition alternate for vacay', async () => {
    renderStep(draftWith({ edition: 'vacay', name: 'Point Reyes' }));
    const hosts = screen.getAllByText(/fiveacross\.app|vacaybingo\.com/);
    expect(hosts[0]).toHaveTextContent('point-reyes.fiveacross.app · canonical');
    expect(hosts[1]).toHaveTextContent('point-reyes.vacaybingo.com · Edition alternate');
  });
});

describe('marking mode', () => {
  it('defaults to Honor selected, and switching writes claimMode', () => {
    const { getDraft } = renderStep(draftWith());
    expect(screen.getByRole('button', { name: 'Honor' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Proof-to-mark' }));
    expect(getDraft().claimMode).toBe('proof_required');
    expect(screen.getByRole('button', { name: 'Proof-to-mark' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Admin-confirmed' }));
    expect(getDraft().claimMode).toBe('admin_confirmed');
  });
});

describe('audience', () => {
  it('defaults to All ages, and 18+ persists settings.forceAdult: true', () => {
    const { getDraft } = renderStep(draftWith());
    expect(screen.getByRole('button', { name: 'All ages' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '18+ (sets forceAdult)' }));
    expect(getDraft().settings.forceAdult).toBe(true);
    expect(screen.getByRole('button', { name: '18+ (sets forceAdult)' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'All ages' }));
    expect(getDraft().settings.forceAdult).toBe(false);
  });
});
