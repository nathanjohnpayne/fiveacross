// The Slug contract (#545, CONTEXT.md § Slug): "the first hostname label
// identifying an Event — a lowercase DNS-safe friendly address, globally unique
// across Namespaces, and explicitly NOT an authorization secret."
//
// ONE list, two consumers, and that is the whole reason this module exists.
// The edge Worker (`worker/src/host.ts`) uses it as a namespace GUARD — the
// answer to "may this hostname reach the router at all?" — and the Event-setup
// wizard's address step (#790) uses it as INPUT VALIDATION, the answer to "may
// an organizer claim this address?". Those two questions must never be
// answered by two lists: a label the wizard lets an organizer claim but the
// router refuses is an Event that provisions successfully and then 404s
// forever, and a label the router admits but the wizard forbids is a reserved
// infrastructure name an operator can never take back.
//
// Deliberately dependency-free, and deliberately rooted under `src/` rather
// than under `worker/`, mirroring `src/domainTypes.d.ts`: the separately-rooted
// Functions project already reaches in here for the shared domain contract
// (`functions/src/dailyEmailContent.ts` imports `../../src/domainTypes`), so
// this is the established shape for "one declaration, several separately-rooted
// compilers". The Worker imports it the same way.

/**
 * Infrastructure labels that must never be dealt to an Event, on any Namespace
 * (#529, #545). Each one has — or is reserved to have — an exact DNS record
 * that outranks the wildcard, so in a correctly provisioned zone these never
 * reach the router at all. This list is the second line: a missing or
 * mis-ordered exact record must not silently turn `admin.fiveacross.app` into a
 * dealable Event address.
 *
 * `d` is the PostHog ingest proxy and is the one a reader is most likely to
 * think is a typo — it was missing from the PRD's list and had to be recovered
 * from the live zone (#529). It is also the reason the reserved check runs
 * BEFORE the length check in `validateSlug`: at one character it would be
 * refused as `too-short` anyway, and a guarantee that holds only by accident of
 * an unrelated constant is not a guarantee. Shortening `SLUG_MIN_LENGTH` must
 * not quietly open the ingest proxy's label to an organizer.
 */
export const RESERVED_LABELS: readonly string[] = [
  'admin',
  'api',
  'auth',
  'd',
  'play',
  'status',
  'www',
];

const RESERVED = new Set(RESERVED_LABELS);

/**
 * Three, not one. DNS is happy with a single character, so this floor is a
 * product decision rather than a protocol one: it keeps the one- and
 * two-character label space free for future infrastructure names (`d` already
 * lives there) instead of letting the first organizer to reach for a short
 * address take one permanently. Raising it is safe; lowering it walks into the
 * reserved set and must be done by adding to `RESERVED_LABELS`, not by
 * shrinking this.
 */
export const SLUG_MIN_LENGTH = 3;

/** The DNS label ceiling (RFC 1035 § 2.3.4). Not a product choice. */
export const SLUG_MAX_LENGTH = 63;

/** Why a candidate was refused. Distinct values because the wizard shows
 *  different copy for each, and the router logs a different reason header. */
export type SlugRejection =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'invalid-characters'
  | 'edge-hyphen'
  | 'reserved-tag'
  | 'reserved-label';

export type SlugCheck = { ok: true; slug: string } | { ok: false; reason: SlugRejection };

/** Lowercase letters, digits and hyphens — the LDH label rule, minus the
 *  uppercase half, because a Slug is stored and compared lowercase. */
const LDH = /^[a-z0-9-]+$/;

/**
 * Fold an organizer's typing into candidate form: trim surrounding whitespace,
 * lowercase, and nothing else.
 *
 * Split from `validateSlug` on purpose, and the split is the security property.
 * The validator is STRICT — it refuses `Bodega-Bay` as `invalid-characters` —
 * so a caller holding a hostname label that arrived over the wire can hand it
 * straight in and get a yes/no about that exact byte sequence. Normalization is
 * a typing affordance for a form, and a form is the only place it belongs; a
 * validator that silently normalized would make the router's guard lenient
 * about a case distinction the router is supposed to have already resolved.
 */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

/** Whether a label is reserved infrastructure. Exported separately from
 *  `validateSlug` so the wizard can say "that address is reserved" without
 *  first having to establish that it is otherwise well-formed. */
export function isReservedLabel(label: string): boolean {
  return RESERVED.has(label);
}

/**
 * Whether `candidate` is a dealable Event Slug, exactly as written.
 *
 * Order is chosen for the message a wizard shows, not for brevity: a person who
 * typed `ab` should be told it is too short rather than being handed a
 * character-class complaint, and a person who typed `admin` should be told it
 * is reserved rather than being told nothing at all. The one ordering
 * constraint that is a correctness property rather than a copy preference is
 * the reserved check preceding the length checks — see `RESERVED_LABELS`.
 */
export function validateSlug(candidate: string): SlugCheck {
  if (candidate.length === 0) return { ok: false, reason: 'empty' };
  if (isReservedLabel(candidate)) return { ok: false, reason: 'reserved-label' };
  if (candidate.length < SLUG_MIN_LENGTH) return { ok: false, reason: 'too-short' };
  if (candidate.length > SLUG_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  if (!LDH.test(candidate)) return { ok: false, reason: 'invalid-characters' };
  if (candidate.startsWith('-') || candidate.endsWith('-')) {
    return { ok: false, reason: 'edge-hyphen' };
  }
  // Two hyphens in the third and fourth positions is the RFC 5891 § 4.2.3.1
  // reserved-LDH form, of which `xn--` (IDNA punycode) is the deployed member.
  // Refused wholesale rather than just `xn--`: the whole `??--` space is
  // reserved precisely so future tags can be added, and an Event addressed at
  // an unassigned one would become unreachable the day that tag ships. It also
  // closes the homograph door — `xn--80ak6aa92e` renders as `apple` in a
  // browser's address bar.
  if (candidate.length >= 4 && candidate[2] === '-' && candidate[3] === '-') {
    return { ok: false, reason: 'reserved-tag' };
  }
  return { ok: true, slug: candidate };
}
