// Edition identity for the PRE-AUTH shell (#543, ADR 0009).
//
// An Edition is a branded product line — Gay Cruise Bingo, Vacay Bingo — under
// which Events are run (CONTEXT.md § Edition). This module owns the copy the
// app must be able to show BEFORE it knows anything else about the Event.
//
// Why a code table and not Firestore: the sign-in gate has to be branded, and
// `events/{eventId}` requires `signedIn()`, so the Event doc cannot reach the
// screen that gets you signed in. `hostnames/{host}.edition` is the only
// Edition signal available that early, and it is an identifier, not copy.
// Editions are few and their wordmark is product copy rather than per-Event
// data, so resolving that identifier against a table here beats widening the
// routing document and reseeding every time a line of marketing copy changes.

export interface EditionBrand {
  /** The wordmark on the signed-out gate. */
  wordmark: string;
  /** One line under it: what this is and when. Signed-out state only. */
  tagline: string;
  /** The offline reassurance at the foot of the gate. Edition-specific because
   *  the reason you might lose signal is. */
  offlineNote: string;
}

export const DEFAULT_EDITION = 'gcb';

const BRANDS: Record<string, EditionBrand> = {
  gcb: {
    wordmark: 'GAY CRUISE BINGO',
    tagline: 'Trieste → Barcelona · July 2026. Sign in, get your card, mark it if you see it.',
    offlineNote: 'Lost signal at sea? The printed cards and PDF still work.',
  },
  vacay: {
    wordmark: 'VACAY BINGO',
    tagline: 'Sign in, get your card, mark it if you see it.',
    offlineNote: 'Patchy signal? Your card keeps working offline — marks sync when you reconnect.',
  },
};

/**
 * The resolved Edition for this session.
 *
 * Seeded from `VITE_EDITION` so a single-Edition build is correct with no
 * network resolution at all, then overwritten by `bootstrapEventResolution`
 * with whatever `hostnames/{host}` said. Read through the accessors below, never
 * captured at import time — a module-level constant would freeze whatever was
 * true before resolution ran.
 */
let currentEdition: string = import.meta.env.VITE_EDITION || DEFAULT_EDITION;

export function activeEdition(): string {
  return currentEdition;
}

/** Install the resolved Edition. A falsy or unknown value resets to the legacy
 *  Edition: an unrecognised Edition should degrade to the shipped experience,
 *  never to an unbranded screen. */
export function setActiveEdition(edition: string | null | undefined): void {
  currentEdition = edition && BRANDS[edition] ? edition : DEFAULT_EDITION;
}

/** Brand copy for the active Edition (or an explicit one, for tests). */
export function editionBrand(edition: string = currentEdition): EditionBrand {
  return BRANDS[edition] ?? BRANDS[DEFAULT_EDITION];
}
