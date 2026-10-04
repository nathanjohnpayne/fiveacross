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
 *
 * `send` is the one entry an organizer could plausibly have typed on purpose —
 * four characters, LDH-clean, an ordinary word — so nothing else in
 * `validateSlug` would have refused it. It carries the Resend return-path MX
 * and SPF for `fiveacross.app` (#1102). That makes it unclaimable twice over:
 * an Event dealt there would name a host whose DNS is an SES bounce address,
 * and because a wildcard does not apply to a name that already exists with ANY
 * record type (RFC 4592), those explicit records occlude `*.fiveacross.app` for
 * that label entirely once #529 attaches the wildcard — so the Event would
 * resolve to nothing rather than to the wrong thing.
 */
export const RESERVED_LABELS: readonly string[] = [
  'admin',
  'api',
  'auth',
  'd',
  'play',
  'send',
  'status',
  'www',
];

/**
 * The PATH-SEGMENT floor (`specs/path-addressing-and-root.md` § Reserved
 * paths, #1387): first path segments that are real routes, so a slug can never
 * take them. A slug is simultaneously a subdomain label (regime a) and a path
 * segment (regimes b and c), so it must clear BOTH floors — and this list
 * reserves a word as a label too, exactly as `RESERVED_LABELS` reserves a word
 * as a path segment. Re-derive it from its sources rather than trusting it:
 *
 * - `feed`, `leaderboard`, `more` — the frozen tab table
 *   (`src/components/tabs.ts`); `more` mounts with a splat, so everything
 *   under it is reserved with it. `/` itself is the root, never a segment.
 * - `setup` — the Event-setup wizard's own top-level route (`/setup/*` in
 *   `src/App.tsx`). The owner kept the wizard there rather than moving it
 *   under `/more` and reserved the word instead (#1223, 2026-10-02).
 * - `items`, `admin` — no longer top-level routes (#203/#208 moved both inside
 *   More), but links minted before that move still exist.
 * - `__` — Firebase Hosting's OAuth-helper namespace (`/__/auth/*`).
 * - `unsubscribe` — a Hosting rewrite to the `emailUnsubscribe` Function.
 * - `assets` — Vite's hashed-output directory.
 *
 * Plus one structural rule that is not an entry: a segment containing a `.` is
 * never a slug (`isReservedPathSegment`). That covers every built file without
 * enumerating a build output that churns.
 */
export const RESERVED_PATH_SEGMENTS: readonly string[] = [
  '__',
  'admin',
  'assets',
  'feed',
  'items',
  'leaderboard',
  'more',
  'setup',
  'unsubscribe',
];

/**
 * The ONE reserved list: the sorted union of both floors, and the set every
 * slug consumer reads — the client parse (`parseAddress`), the Worker's
 * namespace guard (`worker/src/host.ts`), the wizard's availability check and
 * launch gate (`validateSlug`), and the three mirrors in separately deployed
 * programs (pinned by `src/slug.test.ts`). Neither floor may shrink the other.
 */
export const RESERVED_SLUGS: readonly string[] = [
  ...new Set([...RESERVED_LABELS, ...RESERVED_PATH_SEGMENTS]),
].sort();

const RESERVED = new Set(RESERVED_SLUGS);

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

/** Whether a label is reserved by EITHER floor (`RESERVED_SLUGS`) — the name
 *  predates the path-segment floor, and the label question and the slug
 *  question are the same question. Exported separately from `validateSlug` so
 *  the wizard can say "that address is reserved" without first having to
 *  establish that it is otherwise well-formed. Exact bytes, like the rest of
 *  the validator: a caller holding a wire label has already lowercased it. */
export function isReservedLabel(label: string): boolean {
  // `r2-*` is the controller-only rehearsal namespace from the registry
  // contract. It is permanently excluded from organizer claims even when the
  // suffix does not happen to be one of the two currently generated shapes.
  return RESERVED.has(label) || label.startsWith('r2-');
}

/**
 * The two CLOSED rehearsal label classes from `specs/event-router-registry.md`
 * § Lookup, cache, and abuse posture: an ordinary synthetic host and the
 * disjoint root-shaped test host.
 *
 * They live here, beside the `r2-` reservation, because the two rules are one
 * decision seen from two sides and separating them is how they drift. An
 * organizer may never claim ANY `r2-` label — `validateSlug` refuses the whole
 * prefix above, deliberately wider than these classes. The edge router must
 * nonetheless ROUTE these exact two shapes, or the guarded rehearsal that
 * produces the only real-Namespace evidence for the cutover has nothing to
 * measure. Anything else beginning `r2-` is refused by both.
 *
 * `[a-z2-7]` is RFC 4648 base32's lowercase alphabet, and the lengths are the
 * spec's: 26 characters for a synthetic Event host, 20 for a root-test host.
 * Both are matched anchored and exactly, so widening the class is an edit here
 * rather than an emergent property of a prefix test.
 */
const REHEARSAL_EVENT_LABEL = /^r2-[a-z2-7]{26}$/;
const REHEARSAL_ROOT_LABEL = /^r2-root-[a-z2-7]{20}$/;

export function isRehearsalEventLabel(label: string): boolean {
  return REHEARSAL_EVENT_LABEL.test(label);
}

export function isRehearsalRootLabel(label: string): boolean {
  return REHEARSAL_ROOT_LABEL.test(label);
}

/** Either closed rehearsal class. Never a claimable Slug — see above. */
export function isRehearsalLabel(label: string): boolean {
  return isRehearsalEventLabel(label) || isRehearsalRootLabel(label);
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

/**
 * Whether a first path segment can never be an Event address: a word from
 * either floor, or any segment containing a `.` (every built file —
 * `sw.js`, `manifest.webmanifest`, `og-*.png` — and `/.well-known/*`).
 *
 * Case-insensitive on purpose, unlike `isReservedLabel`. The browser's path is
 * case-preserving and the router matches routes case-insensitively, so `/Feed`
 * reaches the Feed tab; reserving only the lowercase spelling would hand that
 * route to the slug parser instead. Lowercasing here only ever widens what is
 * refused, never what is accepted.
 *
 * Percent-decoded for the same reason. `location.pathname` keeps percent
 * escapes, but the router decodes each segment before matching, so `/f%65ed`
 * reaches the Feed tab too. Both the raw and the decoded spelling are checked,
 * and a malformed escape falls back to the raw segment, which is what the
 * router matches in that case. Like lowercasing, this only widens the refusal.
 */
export function isReservedPathSegment(segment: string): boolean {
  return isReservedSpelling(segment) || isReservedSpelling(decodePathSegment(segment));
}

function isReservedSpelling(segment: string): boolean {
  return segment.includes('.') || isReservedLabel(segment.toLowerCase());
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `parseAddress`'s whole answer (`specs/path-addressing-and-root.md` § D3). */
export interface ParsedAddress {
  /** The first path segment when it could be an Event slug, else `null`. */
  slug: string | null;
  /** `/<slug>` alongside a candidate slug; `''` whenever `slug` is `null`. */
  basename: string;
}

const NO_ADDRESS: ParsedAddress = { slug: null, basename: '' };

/**
 * D3 step 1: split the first path segment off `pathname` as a CANDIDATE slug.
 * Pure — no I/O, no Firestore, no router.
 *
 * The answer is speculative on every host, and `hostname` deliberately does
 * not change it: whether a host addresses Events by path at all is decided by
 * its routing document's `pathNamespace` (step 2), which a pure parse cannot
 * know. So this never says "this host addresses by path"; it says "this
 * segment could be a slug". Resolution turns that into the EFFECTIVE basename
 * (step 3) and is the only thing that may hand a basename to the router — on a
 * live Event subdomain the candidate here is discarded. The parameter stays in
 * the spec's signature so every caller hands over the whole address.
 *
 * Only the reserved list and the dot rule are refused here. A segment that is
 * otherwise not a valid slug (`/Bodega-Bay`, `/x`) is still a candidate: it
 * resolves to not-found at step 2, which is the contract (`fiveacross.app/nope`
 * renders not-found, never the doorway), whereas refusing it here would turn it
 * into an app route that the catch-all could swallow.
 */
export function parseAddress(hostname: string, pathname: string): ParsedAddress {
  if (!pathname.startsWith('/')) return NO_ADDRESS;
  const end = pathname.indexOf('/', 1);
  const segment = end === -1 ? pathname.slice(1) : pathname.slice(1, end);
  if (segment === '' || isReservedPathSegment(segment)) return NO_ADDRESS;
  return { slug: segment, basename: `/${segment}` };
}
