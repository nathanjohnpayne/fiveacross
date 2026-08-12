// The sign-in gate's Event-preview slice (#647, wireframes § Join).
//
// `events/{eventId}` requires `signedIn()`, so the postcard on the SIGN-IN
// screen — Event name, dates, host, today's Day line — cannot read the Event
// doc any more than the wordmark can (the #543 constraint, restated). The only
// pre-auth data surface is `hostnames/{host}`, which is already deliberately
// world-readable by `get`; this module owns the OPTIONAL `preview` slice that
// document may carry, the defensive read of it, and the resolved-state
// singleton the gate renders from.
//
// Dependency-free on purpose, mirroring `canonicalHost.ts`: dozens of
// component tests mock `../firebase` with a narrow stand-in, and the pure
// helpers here are consumed by `eventResolution.ts`, which must stay
// unit-testable without a network.

import type { EventPreview, EventPreviewDay } from './types';
export type { EventPreview, EventPreviewDay } from './types';

/** Defensive caps. The document is Admin-SDK-seeded, so these are guardrails
 *  against a malformed seed (and a tampered localStorage cache entry), not a
 *  threat model: an over-long value drops the FIELD, an over-long or partly
 *  malformed schedule drops WHOLE (see the ordinal note below), and a
 *  nameless slice drops entirely. */
const MAX_TEXT = 200;
const MAX_DAYS = 31;

const asText = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && t.length <= MAX_TEXT ? t : undefined;
};

/** ISO `YYYY-MM-DD`, the one date shape the preview schedule speaks. Anything
 *  else would break the lexicographic "which Day is next" comparison below, so
 *  a malformed date drops its Day rather than mis-ordering the line. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The shape check above is deliberately separate from this calendar check:
 *  JavaScript normalizes values such as 2026-02-31 into March, which would
 *  otherwise let a nonexistent Day win the lexical next-Day lookup. */
const isCalendarDate = (date: string): boolean => {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

/**
 * Read an unknown `preview` value into the contract shape, or `undefined`.
 *
 * Field-by-field and fail-soft, like `fetchHostnameDoc`'s other optional
 * fields: a hostname document seeded before #647 has no key at all, and a
 * partially-valid slice keeps its valid fields. Only a missing/blank
 * `eventName` rejects the whole slice — the card leads with the name, so
 * there is nothing worth drawing without it.
 */
export function coerceEventPreview(v: unknown): EventPreview | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const raw = v as Record<string, unknown>;
  const eventName = asText(raw.eventName);
  if (!eventName) return undefined;
  const preview: EventPreview = { eventName };
  const dateRange = asText(raw.dateRange);
  if (dateRange) preview.dateRange = dateRange;
  const hostedBy = asText(raw.hostedBy);
  if (hostedBy) preview.hostedBy = hostedBy;
  if (Array.isArray(raw.days)) {
    // ALL-OR-NOTHING, unlike the scalar fields (Codex P2 round 1): a Day's
    // ordinal is its array position, so silently skipping one malformed entry
    // would renumber every Day after it and the gate would announce "Day 1"
    // for the second Day of the schedule — incorrect guest-facing copy, not a
    // degraded card. A schedule with any bad entry (or an over-long one, which
    // truncation would likewise mis-shape) is dropped whole; the card then
    // simply omits the Day line, keeping the fail-soft rendering honest.
    const days: EventPreviewDay[] = [];
    let valid = raw.days.length > 0 && raw.days.length <= MAX_DAYS;
    for (const entry of valid ? raw.days : []) {
      if (typeof entry !== 'object' || entry === null) {
        valid = false;
        break;
      }
      const e = entry as Record<string, unknown>;
      const date = asText(e.date);
      const title = asText(e.title);
      if (!date || !ISO_DATE.test(date) || !isCalendarDate(date) || !title) {
        valid = false;
        break;
      }
      const prev = days[days.length - 1];
      if (prev && date <= prev.date) {
        // Strictly increasing, not just non-decreasing: `previewDayLine` uses
        // array position as the Day ordinal, so a duplicate or out-of-order
        // date would let two entries claim the same "next" slot or renumber
        // Days out of sequence — same all-or-nothing failure mode as the
        // per-entry checks above.
        valid = false;
        break;
      }
      const day: EventPreviewDay = { date, title };
      const emoji = asText(e.emoji);
      if (emoji) day.emoji = emoji;
      days.push(day);
    }
    if (valid) preview.days = days;
  }
  return preview;
}

/** Today as event-preview ISO, in the DEVICE's timezone. The preview schedule
 *  carries no timezone (it is display copy, not the unlock schedule), and a
 *  guest reading the gate is standing at the event, so device-local is the
 *  honest approximation — worst case the Day line advances a few hours early
 *  or late, on a screen that only ever previews. */
function localIsoDate(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The live "Day N" fragment ("🐦 Day 1: The Birds Have Entered the Chat"), or
 * `null` when the schedule offers nothing to say.
 *
 * ALWAYS computed from the seeded schedule, never a stored string — the
 * wireframe frame itself proves why: its literal Day-1 copy predates the #637
 * title trim, so a baked line would have shipped a stale title on day one.
 * Picks the first Day on or after today (the gate previews what is coming:
 * tonight-before-Day-1 shows Day 1); after the last Day there is nothing left
 * to preview, so the fragment drops rather than pointing at a finished Day.
 */
export function previewDayLine(
  days: EventPreviewDay[] | undefined,
  now: number = Date.now(),
): string | null {
  if (!days?.length) return null;
  const today = localIsoDate(now);
  const index = days.findIndex((d) => d.date >= today);
  if (index === -1) return null;
  const day = days[index]!;
  return `${day.emoji ? `${day.emoji} ` : ''}Day ${index + 1}: ${day.title}`;
}

/**
 * The postcard's middle line: "Aug 7–9 · hosted by Kim · 🐦 Day 1: …".
 * Whichever fragments exist, joined the way the wireframe joins them; `null`
 * when none do, so the card can skip the line entirely.
 */
export function previewMetaLine(preview: EventPreview, now: number = Date.now()): string | null {
  const parts = [
    preview.dateRange,
    preview.hostedBy ? `hosted by ${preview.hostedBy}` : undefined,
    previewDayLine(preview.days, now) ?? undefined,
  ].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(' · ') : null;
}

/** `null` until `applyResolvedEventPreview` runs. On a hostname-resolved build
 *  the resolver installs it before mount; on an ENV-PINNED build — which reads
 *  no routing document at resolution time, the production defect this store
 *  went reactive for — it arrives LATER, from the cached envelope at bootstrap
 *  and then from `watchAdultContent`'s live snapshot of the same document. */
let currentPreview: EventPreview | null = null;

const listeners = new Set<() => void>();

/** Subscribe to preview changes — the `useSyncExternalStore` seam that lets
 *  the gate re-render when the slice arrives AFTER first paint (the env-pinned
 *  path). Mirrors `subscribeAdultContent`: one store, resolved before React
 *  exists, read from non-component code, so it cannot live in a provider. */
export function subscribeEventPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Install the resolved preview. Called at startup by
 *  `bootstrapEventResolution`, and again by `watchAdultContent` on every live
 *  snapshot of the routing document — which is what makes the card reachable
 *  on env-pinned builds at all, since their resolution never reads one.
 *
 *  Deep-equality gated: the watcher re-coerces a fresh object per snapshot, so
 *  without the check every heartbeat would swap the reference and re-render
 *  the gate for identical content. Both producers build the object through
 *  `coerceEventPreview`, so the key order is canonical and JSON equality is
 *  exact. */
export function applyResolvedEventPreview(preview: EventPreview | null | undefined): void {
  const next = preview ?? null;
  if (JSON.stringify(next) === JSON.stringify(currentPreview)) return;
  currentPreview = next;
  for (const listener of [...listeners]) listener();
}

/** The resolved preview the sign-in postcard renders, or `null` for no card.
 *  Read at render time, never captured at import time — same rule as
 *  `activeEdition`, same reason: resolution runs before mount, but a
 *  module-level constant would freeze the pre-resolution state. Stable
 *  reference between changes (see the equality gate above), as
 *  `useSyncExternalStore`'s getSnapshot contract requires. */
export function activeEventPreview(): EventPreview | null {
  return currentPreview;
}
