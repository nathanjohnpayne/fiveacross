import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAMESPACES } from '../worker/src/host';
import {
  isRehearsalEventLabel,
  isRehearsalLabel,
  isRehearsalRootLabel,
  isReservedLabel,
  normalizeSlug,
  RESERVED_LABELS,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  validateSlug,
} from './slug';

describe('reserved infrastructure labels', () => {
  // Pinned verbatim, and exhaustively. This list is a cross-project contract
  // (#529, #545, and the wizard's address step #790); a silent addition or
  // removal here changes what an organizer may claim AND what the edge router
  // will serve, so it should never move without a test moving with it.
  it('is exactly the eight infrastructure labels, sorted', () => {
    expect([...RESERVED_LABELS]).toEqual([
      'admin',
      'api',
      'auth',
      'd',
      'play',
      'send',
      'status',
      'www',
    ]);
  });

  it('includes the PostHog ingest proxy label the PRD omitted', () => {
    expect(isReservedLabel('d')).toBe(true);
  });

  it('includes the Resend return-path label, which carries MX and outranks the wildcard', () => {
    // `send` is the one reserved label an organizer could plausibly have typed:
    // four characters, LDH-clean, and an ordinary English word, so nothing
    // else in `validateSlug` would have refused it. It carries the Resend
    // return-path MX and SPF for `fiveacross.app` (#1102), which makes it
    // doubly unclaimable — an Event dealt there would name a host whose DNS is
    // an SES bounce address, and because a wildcard does not apply to a name
    // that already exists with ANY record type (RFC 4592), the explicit records
    // occlude `*.fiveacross.app` for that label entirely once #529 attaches it.
    expect(isReservedLabel('send')).toBe(true);
  });

  it.each([...RESERVED_LABELS])('refuses %s as a Slug', (label) => {
    expect(validateSlug(label)).toEqual({ ok: false, reason: 'reserved-label' });
  });

  it('rejects a reserved label AS reserved, not incidentally as too short', () => {
    // `d` is one character, so a length-first ordering would refuse it with the
    // wrong reason — and would start ADMITTING it the day SLUG_MIN_LENGTH
    // dropped to 1. The guarantee has to be the reserved list, not arithmetic.
    const check = validateSlug('d');
    expect(check).toEqual({ ok: false, reason: 'reserved-label' });
    expect(check).not.toEqual({ ok: false, reason: 'too-short' });
  });

  it('does not reserve labels that merely contain a reserved one', () => {
    expect(validateSlug('admiral')).toEqual({ ok: true, slug: 'admiral' });
    expect(validateSlug('api-summit')).toEqual({ ok: true, slug: 'api-summit' });
  });

  it.each(['r2-abcdefghijklmnopqrstuvwxyz', 'r2-root-abcdefghijklmnopqrst'])(
    'reserves the controller-only rehearsal class %s from ordinary claims',
    (label) => {
      expect(validateSlug(label)).toEqual({ ok: false, reason: 'reserved-label' });
    },
  );
});

/**
 * The rehearsal classes are recognised HERE, beside the reservation that makes
 * them unclaimable, because they are one decision with two sides: an organizer
 * may claim no `r2-` label at all, and the edge router must route exactly two
 * closed shapes of them (#972). Splitting the two rules across modules is how
 * one of them widens without the other noticing.
 */
describe('the closed rehearsal label classes', () => {
  it.each([
    ['r2-abcdefghijklmnopqrstuvwxyz', true, false],
    ['r2-2345672345672345672345672a', true, false],
    ['r2-root-abcdefghijklmnopqrst', false, true],
    ['r2-root-2345672345672345672a', false, true],
  ] as const)('recognises %s', (label, event, root) => {
    expect(isRehearsalEventLabel(label)).toBe(event);
    expect(isRehearsalRootLabel(label)).toBe(root);
    expect(isRehearsalLabel(label)).toBe(true);
    // Recognised as a rehearsal class AND still unclaimable. Both, always.
    expect(isReservedLabel(label)).toBe(true);
    expect(validateSlug(label)).toEqual({ ok: false, reason: 'reserved-label' });
  });

  it.each([
    'r2-short',
    'r2-abcdefghijklmnopqrstuvwxy', // 25
    'r2-abcdefghijklmnopqrstuvwxyza', // 27
    'r2-ABCDEFGHIJKLMNOPQRSTUVWXYZ', // base32 is lowercase here
    'r2-abcdefghijklmnopqrstuvwxy1', // 1 and 8/9 are outside RFC 4648 base32
    'r2-root-abcdefghijklmnopqrs', // 19
    'r2-root-abcdefghijklmnopqrstu', // 21
    'r2-root-abcdefghijklmnopqr-t',
    'bodega-bay',
    'r2',
  ])('does not recognise %s as a rehearsal class', (label) => {
    expect(isRehearsalLabel(label)).toBe(false);
  });

  it('leaves every other reserved label outside the rehearsal classes', () => {
    for (const label of RESERVED_LABELS) {
      expect(isRehearsalLabel(label), label).toBe(false);
    }
  });
});

/**
 * Two separately deployed programs keep their OWN copy of the reserved set
 * because neither can import this module. `router-publisher` pins
 * `rootDir: "src"` in its tsconfig, so reaching outside it would change the
 * emitted artifact shape of a deployed Cloud Function; the registry recovery
 * controller is plain `.mjs` with no build step. Both are MIRRORS, not
 * independent policies.
 *
 * A mirror without a parity test is how mirrors drift — the same reasoning
 * `dailyEmailTheme.ts` records for its Theme-token table — and this one drifted
 * exactly that way: `send` was added here (#1102) and both copies silently kept
 * the former seven, which the root suite could not catch because its `include`
 * covers `src/`, `scripts/` and `worker/` but NOT `router-publisher/`. The
 * publisher would then have accepted and signed a `send` replica row that the
 * registry rejects downstream, and `deployment.json` enables retries, so one
 * malformed row becomes repeated failed publications rather than a clean
 * rejection at the boundary.
 *
 * This parses the literal out of each file rather than importing it, which is
 * the only option for a CommonJS-targeted service and an unbuilt `.mjs` — and
 * is the point: it fails on the SOURCE a deploy actually ships.
 */
describe('reserved-label mirrors in separately deployed programs', () => {
  const parseSet = (path: string, constName: string): string[] => {
    // Resolved from the Vitest root (the repo root) rather than from
    // `import.meta.url`, which the jsdom transform does not reliably provide.
    const src = readFileSync(resolve(process.cwd(), path), 'utf-8');
    const start = src.indexOf(constName);
    if (start === -1) throw new Error(`${constName} not found in ${path}`);
    const open = src.indexOf('[', start);
    const close = src.indexOf(']', open);
    if (open === -1 || close === -1) throw new Error(`${constName} literal unparsable in ${path}`);
    return [...src.slice(open, close).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  };

  const expected = [...RESERVED_LABELS].sort();

  it('router-publisher/src/runtime.ts mirrors RESERVED_LABELS exactly', () => {
    expect(parseSet('router-publisher/src/runtime.ts', 'RESERVED_EVENT_SLUGS').sort()).toEqual(
      expected,
    );
  });

  it('scripts/event-router-registry/recovery-controller.mjs mirrors RESERVED_LABELS exactly', () => {
    expect(
      parseSet('scripts/event-router-registry/recovery-controller.mjs', 'RESERVED_SLUGS').sort(),
    ).toEqual(expected);
  });
});

/**
 * The SECOND mirror class in those same two programs, and a different SHAPE of
 * mirror from the reserved-label one above. The reserved set is a list, so its
 * parity check can be textual: parse the literal, sort, compare. The rehearsal
 * classes are not a list — they are regexes, and worse, they are regexes over a
 * different subject. `src/slug.ts` classifies a LABEL; every copy below
 * classifies a whole HOST, because that is what a Firestore document id and a
 * CloudEvent payload actually carry. A textual comparison between
 * `/^r2-[a-z2-7]{26}$/` and
 * `/^r2-[a-z2-7]{26}\.(fiveacross\.app|vacaybingo\.com)$/` can only ever be a
 * substring test, which would keep passing through exactly the edits that
 * matter — a `{26}` widened to `{2,26}`, an anchor dropped, a `\.` separator
 * relaxed to a wildcard `.`, an `i` flag acquired, `[a-z2-7]` relaxed to
 * `[a-z0-9]` in one copy and not the other.
 *
 * So the block checks two things, and needs both.
 *
 * The CLOSED check composes: the canonical pattern is pinned as text, the
 * Namespace list is imported from the router, and each mirror must equal the
 * host pattern those two compose to. Composition is what makes a textual check
 * legitimate here — the different-subject problem above is exactly the problem
 * composing solves — and equality is closed under every widening and narrowing
 * at once, which no table of example hosts can be.
 *
 * The BEHAVIOURAL check runs each rebuilt literal over one shared fixture of
 * hosts beside the canonical predicate it must agree with, with expectations
 * DERIVED from `isRehearsalEventLabel` / `isRehearsalRootLabel` rather than
 * written twice. It says what the composition MEANS, it names an offending host
 * when something breaks instead of handing over a diff of two regex sources,
 * and it catches an implementation that stopped consulting its pattern at all.
 *
 * The fixture came first and could not finish the job. Seven review rounds each
 * found another coordinate it sampled — the base32 exclusions, the edit
 * alphabet, insertion position, narrowings as well as widenings, uppercase
 * inside a fixed component, several positions varying at once, lengths further
 * from the exact one, a second foreign Namespace. Every one was real, and
 * closing one never closed the next, because a host is a string and no finite
 * table of them pins an infinite space. That is the argument for the composed
 * check, and the reason the fixture is kept for meaning rather than for proof.
 *
 * The three literals in `router-publisher/src/runtime.ts` are deliberately not
 * all the same shape, and the table records which is which: `isRegistryHost`
 * admits EITHER class, while the `route` and `root` branches of `validDesired`
 * each test for the root class alone — the first to exclude root-shaped hosts
 * from ordinary Event routes, the second to admit them. Pinning all three to
 * "either" would have hidden a route row dealt at a root-test host.
 *
 * Each file's literal COUNT is pinned too, and pinned TO the number of
 * behavioural rows for that file. None of the three in
 * `router-publisher/src/runtime.ts` is an exported constant — one is an inline
 * expression and two are function-local `const`s — so there is no symbol a
 * later edit would have to touch, and a fourth literal added beside them would
 * otherwise be a mirror no test has ever seen. Counting alone would not fix
 * that: a bare count reddens on the fourth literal and goes green again the
 * moment someone raises the number, with the new mirror still uncompared.
 *
 * KNOWN LIMIT, and it is inherent rather than an oversight. This compares the
 * LITERAL, not its use. A mirror whose regex is untouched but whose call site
 * changes around it — `.test(host.toLowerCase())` is the sharp example, which
 * would make the publisher admit uppercase rehearsal hosts — passes every
 * assertion here. Closing that needs the fixture driven through the call sites
 * themselves, which is a different test against a different surface.
 *
 * For `router-publisher/src/runtime.ts` that test now exists (#1135):
 * `router-publisher/src/runtime.test.ts` drives a host fixture through
 * `isRegistryHost`, both class-testing branches of `validDesired`, and the
 * exported `replicaPayloadFromEvent` entry point that reaches all three, with
 * every expectation derived from the same canonical predicates this block
 * imports. The two suites are a pair and neither subsumes the other: that one
 * cannot close the literal space, because a host is a string and no finite
 * table of them pins an infinite space, and this one cannot see an expression.
 * The two `.mjs` mirrors keep the limit as stated — their controller suites are
 * their own — so a green run here is still not a claim about call sites.
 */
describe('rehearsal-class mirrors in separately deployed programs', () => {
  /**
   * The Namespace half of each host regex has no counterpart in `src/slug.ts`
   * on purpose — which Namespaces exist is a router concern, not a Slug one —
   * so it comes from the router's own `NAMESPACES`, imported above rather than
   * restated. Restating it would put a third copy of the pair beside the
   * mirrors this block exists to keep honest: adding a Namespace to the router
   * and to the mirrors would leave the local copy behind, and both the fixture
   * and `canonical()` would go on agreeing about the old pair while every
   * mirror drifted. `src/editions.test.ts` reaches for the same export.
   *
   * `gaycruisebingo.com` rides along as the near-miss: a real root host, but
   * not a wildcard Namespace, so no rehearsal host may ever be dealt under it.
   */
  const FOREIGN_NAMESPACE = 'gaycruisebingo.com';

  type RehearsalClass = 'event' | 'root' | 'either';

  interface MirrorSite {
    /** Repo-relative path of the file the mirror lives in. */
    readonly path: string;
    /** Source text immediately preceding the literal, naming the call site. */
    readonly anchor: string;
    /** The class this particular regex is supposed to admit. */
    readonly admits: RehearsalClass;
    /** What the call site is FOR, so a failure names the behaviour it broke. */
    readonly purpose: string;
  }

  const read = (path: string): string =>
    // Resolved from the Vitest root, for the reason the block above records.
    readFileSync(resolve(process.cwd(), path), 'utf-8');

  /**
   * Comments are not code, and this scans source TEXT. Left in, a mirror could
   * be replaced by a widened `new RegExp('…')` with the old literal parked in a
   * commented-out line above it, and the comment would satisfy both the count
   * and the behavioural comparison while the executable consumer had drifted.
   * Stripped first, so only real code is ever scanned.
   *
   * A `//` inside a string would take the rest of its line with it. That is
   * survivable in a way the reverse is not: losing a literal fails the count,
   * which is loud, while keeping a commented one passes, which is silent.
   */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');

  /**
   * Matches a regex literal that starts anchored and mentions `r2-`, capturing
   * its pattern and its FLAGS separately. The `[^\n/]` classes are what make it
   * safe to do this with a regex at all: none of these literals contains a
   * slash or spans a line, so the scan cannot run past its own closing
   * delimiter into the rest of the file.
   *
   * Only in an EXECUTABLE position: bound to a name, or invoked directly. A
   * literal sitting in neither is not a mirror this program consults, and
   * counting it would let a real consumer drift behind a decorative twin.
   *
   * Deliberately does NOT require the trailing `$`. Requiring it would make a
   * copy whose end anchor was dropped invisible to the scan, which then binds
   * the NEXT literal in the file and reports the failure against the wrong
   * call site. Matching it in place lets the behavioural assertion name it.
   *
   * The flags matter as much as the pattern. A mirror that acquired `i` would
   * start admitting uppercase rehearsal hosts in production while a
   * flags-discarding reconstruction stayed case-sensitive here, so the suite
   * would pass through exactly the drift it exists to catch.
   */
  const LITERAL = String.raw`/(\^[^\n/]*r2-[^\n/]*)/([dgimsuvy]*)`;
  const HOST_REGEX_LITERAL = new RegExp(`=\\s*${LITERAL}|${LITERAL}\\s*\\.test\\(`);

  /**
   * `g` and `y` advance `lastIndex` between `test` calls. On a module-level
   * constant reused across hosts — which is what every mirror here is — that
   * makes the answer depend on call order, in the mirror as much as in this
   * comparison. Refused rather than reproduced.
   */
  const STATEFUL_FLAGS = /[gy]/;

  /**
   * How far past an anchor its literal may sit. Bounded so that deleting a
   * mirror throws here instead of silently binding the anchor to some later
   * regex; 512 comfortably clears the widest real gap, which is the ~260
   * characters between `isRegistryHost` and its literal.
   */
  const ANCHOR_WINDOW = 512;

  const countHostRegexes = (source: string): number =>
    [...stripComments(source).matchAll(new RegExp(HOST_REGEX_LITERAL, 'g'))].length;

  const hostRegexAfter = (source: string, anchor: string): RegExp => {
    const code = stripComments(source);
    const from = code.indexOf(anchor);
    if (from === -1) throw new Error(`anchor not found: ${anchor}`);
    const found = HOST_REGEX_LITERAL.exec(code.slice(from, from + ANCHOR_WINDOW));
    if (found === null) throw new Error(`no rehearsal host regex after: ${anchor}`);
    // Two alternatives, one pair of groups each: bound to a name, or invoked.
    const pattern = found[1] ?? found[3];
    const flags = found[2] ?? found[4];
    if (STATEFUL_FLAGS.test(flags)) {
      throw new Error(`mirror regex after ${anchor} carries a stateful flag: /${flags}`);
    }
    return new RegExp(pattern, flags);
  };

  const MIRROR_FILES: readonly (readonly [path: string, literals: number])[] = [
    ['router-publisher/src/runtime.ts', 3],
    ['scripts/event-router-registry/recovery-controller.mjs', 2],
    ['scripts/event-router-registry/rehearsal-controller.mjs', 2],
  ];

  const SITES: readonly MirrorSite[] = [
    {
      path: 'router-publisher/src/runtime.ts',
      anchor: 'function isRegistryHost',
      admits: 'either',
      purpose: 'admits both rehearsal classes as registry hosts',
    },
    {
      path: 'router-publisher/src/runtime.ts',
      anchor: 'const rootTest =',
      admits: 'root',
      purpose: 'keeps a route row off a root-test host',
    },
    {
      path: 'router-publisher/src/runtime.ts',
      anchor: 'const syntheticRoot =',
      admits: 'root',
      purpose: 'admits a root row on a root-test host',
    },
    {
      path: 'scripts/event-router-registry/recovery-controller.mjs',
      anchor: 'const SYNTHETIC_EVENT =',
      admits: 'event',
      purpose: 'recognises a synthetic Event host in recovery evidence',
    },
    {
      path: 'scripts/event-router-registry/recovery-controller.mjs',
      anchor: 'const SYNTHETIC_ROOT =',
      admits: 'root',
      purpose: 'recognises a root-test host in recovery evidence',
    },
    {
      path: 'scripts/event-router-registry/rehearsal-controller.mjs',
      anchor: 'const SYNTHETIC_EVENT =',
      admits: 'event',
      purpose: 'recognises a synthetic Event host in a rehearsal reservation',
    },
    {
      path: 'scripts/event-router-registry/rehearsal-controller.mjs',
      anchor: 'const SYNTHETIC_ROOT =',
      admits: 'root',
      purpose: 'recognises a root-test host in a rehearsal reservation',
    },
  ];

  /**
   * Canonical positives first, then the near-misses that a loosened copy would
   * start admitting: wrong suffix length either way, uppercase, the base32
   * exclusions — ALL FOUR of `0`, `1`, `8` and `9`, since lowercase RFC 4648
   * base32 omits every one of them and a widening to `[a-z02-7]` is as real as
   * a widening to `[a-z0-9]` — and a hyphen inside a root suffix, which is the
   * one that separates `[a-z2-7]{20}` from a lazier `[a-z0-9-]{20}`.
   */
  const LABELS = [
    'r2-abcdefghijklmnopqrstuvwxyz',
    'r2-234567abcdefghijklmnopqrst',
    'r2-root-abcdefghijklmnopqrst',
    'r2-root-234567abcdefghijklmn',
    'r2-abcdefghijklmnopqrstuvwxy',
    'r2-abcdefghijklmnopqrstuvwxyza',
    'r2-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'r2-abcdefghijklmnopqrstuvwxy0',
    'r2-abcdefghijklmnopqrstuvwxy1',
    'r2-abcdefghijklmnopqrstuvwx89',
    'r2-root-abcdefghijklmnopqrs',
    'r2-root-abcdefghijklmnopqrstu',
    'r2-root-abcdefghijklmnopqr-t',
    'r2-root-ABCDEFGHIJKLMNOPQRST',
    'r2-root-abcdefghijklmnopqrs0',
    'r2-root-abcdefghijklmnopqrs1',
    'r2-root-abcdefghijklmnopqrst-',
    // The boundary BETWEEN the two classes, which every other label sits on one
    // side of. Making `root-` optional admits the first as a root host; letting
    // the root suffix take an Event's length admits the second. Both are
    // rejected by the canonical predicates, and neither has any other fixture.
    'r2-abcdefghijklmnopqrst',
    'r2-root-abcdefghijklmnopqrstuvwxyz',
    'r2',
    'r2-',
    'r2-root-',
    'bodega-bay',
  ] as const;

  /** The two canonical positives, one per class, reused by the fixtures below. */
  const [EVENT_POSITIVE, ROOT_POSITIVE] = [
    'r2-abcdefghijklmnopqrstuvwxyz',
    'r2-root-abcdefghijklmnopqrst',
  ];

  const BASE32 = /^[a-z2-7]*$/;
  const EVENT_MARKER = 'r2-';
  const ROOT_MARKER = 'r2-root-';
  const EVENT_SUFFIX_LENGTH = 26;
  const ROOT_SUFFIX_LENGTH = 20;

  const isEventShaped = (label: string): boolean =>
    label.startsWith(EVENT_MARKER) &&
    label.length === EVENT_MARKER.length + EVENT_SUFFIX_LENGTH &&
    BASE32.test(label.slice(EVENT_MARKER.length));

  const isRootShaped = (label: string): boolean =>
    label.startsWith(ROOT_MARKER) &&
    label.length === ROOT_MARKER.length + ROOT_SUFFIX_LENGTH &&
    BASE32.test(label.slice(ROOT_MARKER.length));

  /** A base32 suffix of exactly `length` characters. */
  const suffix = (length: number): string =>
    'abcdefghijklmnopqrstuvwxyz234567'.slice(0, length);

  /**
   * Accepted labels placing EVERY valid base32 character at EVERY suffix
   * position, for both classes.
   *
   * Every other fixture in this block hunts widenings. These hunt NARROWINGS,
   * which are the same defect seen from the other side and which no near-miss
   * can reach: the positive corpus had two Event suffixes, beginning `a` and
   * `2`, so a mirror narrowed to `^r2-[a2][a-z2-7]{25}` accepted both and
   * rejected every other canonical host while the suite stayed green. A dealt
   * rehearsal Event would 404 and the fixture would have said nothing.
   */
  const BASE32_ALPHABET = [...'abcdefghijklmnopqrstuvwxyz234567'];

  const everyPositionAndCharacter = (marker: string, length: number): string[] =>
    Array.from({ length }, (_unused, position) =>
      BASE32_ALPHABET.map((character) => {
        const body = suffix(length);
        return `${marker}${body.slice(0, position)}${character}${body.slice(position + 1)}`;
      }),
    ).flat();

  const EXHAUSTIVE_POSITIVES = [
    ...everyPositionAndCharacter(EVENT_MARKER, EVENT_SUFFIX_LENGTH),
    ...everyPositionAndCharacter(ROOT_MARKER, ROOT_SUFFIX_LENGTH),
  ];

  /**
   * Hosts that are not a plain `<label>.<Namespace>` pair. They exist to pin
   * the two anchors, which the cross product below cannot reach: a copy that
   * lost its `^` admits a prefixed host, and one that lost its `$` admits a
   * suffixed one, and both still classify every well-formed host correctly.
   */
  const UNANCHORED_NEAR_MISSES = [
    'not-r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
    'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app.example.com',
    'r2-root-abcdefghijklmnopqrst.vacaybingo.com.example.com',
  ];

  /**
   * One character outside lowercase RFC 4648 base32, substituted at the END of
   * the suffix and again in the MIDDLE of it, for both classes.
   *
   * Position is the reason for two of each: a widened character class can be
   * written anywhere in the pattern, and a fixture that only ever spoils the
   * last character cannot tell a class widened in place from one widened at
   * the edge. The set is deliberately not just digits and case — `_` is the
   * one that showed this was thin, since `[a-z2-7_]` is a plausible slip and
   * nothing here would have caught it.
   */
  const OUTSIDE_BASE32 = ['A', '0', '1', '8', '9', '_', '-', '+', '~', '%'];

  const ALPHABET_NEAR_MISSES = OUTSIDE_BASE32.flatMap((character) =>
    [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) => [
      `${label.slice(0, -1)}${character}`,
      `${label.slice(0, -4)}${character}${label.slice(-3)}`,
    ]),
  );

  /**
   * The fully-qualified form of each canonical positive. A trailing root dot
   * names the SAME host in DNS, which is exactly why a mirror might grow a
   * `\.?$` to be accommodating — and why it must not: `canonical()` rejects it,
   * the router rejects it explicitly (`hasTrailingRootDot` in
   * `worker/src/host.ts`), and a mirror that accepted it would key a registry
   * row under a host string nothing else in the system produces.
   *
   * The existing suffix near-misses could not see this. `.example.com` is a
   * longer suffix; a bare `.` is a shorter one, and only the second survives
   * an end anchor that was made optional rather than dropped.
   */
  const TRAILING_ROOT_DOT_NEAR_MISSES = [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
    NAMESPACES.map((namespace) => `${label}.${namespace}.`),
  );

  /**
   * Every one-character edit of `text`: each deletion, each substitution, and
   * an insertion at each position.
   *
   * Hand-picked near-misses kept missing by one. A first pass at the Namespace
   * cases covered a character short at either end, one substituted at the end
   * and one appended — and `fiveacrossx?\.app` still passed, because an
   * insertion in the MIDDLE was not among them. Enumerating the whole
   * single-edit neighbourhood closes the class instead of the instance, and is
   * shorter than the list of cases it replaces.
   */
  /** Every character an LDH hostname label or Namespace can carry, plus `.`. */
  const HOSTNAME_ALPHABET = [...'abcdefghijklmnopqrstuvwxyz0123456789-.'];

  const singleCharacterEdits = (text: string): string[] => {
    // The whole hostname alphabet, not a sample of it and not the component's
    // own characters. Two narrower alphabets were tried and each missed by one:
    // a fixed foreign `x` could not produce `fiveacrosss.app` for a mirror
    // widened to `fiveacrosss?\.app`, and adding the component's own characters
    // still could not produce `fiveacrossq.app` for `fiveacrossq?\.app`,
    // because `q` appears nowhere in `fiveacross.app`. Any character an LDH
    // hostname can carry is a character a mirror can be widened to admit.
    const alphabet = HOSTNAME_ALPHABET;
    const edits: string[] = [];
    for (let index = 0; index < text.length; index += 1) {
      edits.push(text.slice(0, index) + text.slice(index + 1));
      for (const character of alphabet) {
        edits.push(`${text.slice(0, index)}${character}${text.slice(index + 1)}`);
      }
    }
    for (let index = 0; index <= text.length; index += 1) {
      for (const character of alphabet) {
        edits.push(`${text.slice(0, index)}${character}${text.slice(index)}`);
      }
    }
    return [...new Set(edits)].filter((edit) => edit !== text);
  };

  /**
   * The Namespace half, which decides WHICH Namespace a rehearsal host was
   * dealt under. The table otherwise holds each Namespace exactly, plus one
   * unrelated domain, and that cannot tell an exact match from a loosened one.
   */
  const NAMESPACE_NEAR_MISSES = NAMESPACES.flatMap(singleCharacterEdits).filter(
    (candidate) => !NAMESPACES.includes(candidate),
  );

  /**
   * The two fixed markers, `r2-` and `r2-root-`, edited the same way. They are
   * literal text in every mirror exactly as the Namespaces are, and a loosened
   * marker is how one class starts answering for the other.
   */
  const MARKER_NEAR_MISSES = [
    ...singleCharacterEdits('r2-').map((marker) => `${marker}${EVENT_POSITIVE.slice(3)}`),
    ...singleCharacterEdits('r2-root-').map((marker) => `${marker}${ROOT_POSITIVE.slice(8)}`),
  ];

  /**
   * The same two anchors again, defeated a different way. `m` rebinds `^` and
   * `$` to LINE boundaries, so a mirror that acquired it would admit a host
   * with a well-formed line buried in it while every single-line fixture above
   * kept agreeing. That is not a hypothetical input class here: these mirrors
   * validate a Firestore document id and a CloudEvent payload field, so the
   * string arrives from outside.
   *
   * Checked behaviourally rather than by refusing `m` the way `g` and `y` are
   * refused, because `g` breaks the comparison itself while `m` only changes
   * the answer — and the answer is what this block compares.
   */
  const MULTILINE_NEAR_MISSES = [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
    NAMESPACES.flatMap((namespace) => [
      `attacker\n${label}.${namespace}`,
      `${label}.${namespace}\nattacker`,
    ]),
  );

  /**
   * The canonical positives padded with whitespace and control characters, at
   * the front, at the back, and at the separator.
   *
   * `^\s*r2-` is an anchor widening that neither anchor fixture above can see.
   * The prefixed near-miss uses a letter and the multiline ones put text before
   * a newline, so `\s*` matches neither — but it matches a bare leading space,
   * and a host arrives here as an externally supplied string: a reservation
   * host, a Firestore document id, a CloudEvent payload field. A mirror that
   * tolerated padding would admit a host the canonical predicate rejects and
   * that nothing else in the system produces.
   *
   * `\u00a0`, `\u200b` and `\0` ride along because a trimmer written against
   * ASCII whitespace, or an anchor widened to a hand-rolled class, tends to
   * disagree with `\s` about exactly these.
   */
  const PADDING = [' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\u200b', '\0'];

  const PADDED_NEAR_MISSES = PADDING.flatMap((pad) =>
    [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
      NAMESPACES.flatMap((namespace) => [
        `${pad}${label}.${namespace}`,
        `${label}.${namespace}${pad}`,
        `${label}${pad}.${namespace}`,
      ]),
    ),
  );

  /**
   * Canonical positives with one dot spoiled: first the separator before the
   * Namespace, then the dot INSIDE it. Both classes, both Namespaces.
   *
   * These are what a `\.` relaxed to a bare `.` costs. Every host in the cross
   * product below carries its dots exactly where a mirror expects them, so a
   * wildcarded separator changes no answer there and the drift ships silently —
   * on the very regexes that ARE the host-validation boundary in the publisher
   * and in both controllers.
   */
  const SEPARATOR_NEAR_MISSES = [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
    NAMESPACES.flatMap((namespace) => [
      `${label}X${namespace}`,
      `${label}.${namespace.replace('.', 'X')}`,
    ]),
  );

  const HOSTS = [
    ...LABELS.flatMap((label) => [
      ...NAMESPACES.map((namespace) => `${label}.${namespace}`),
      `${label}.${FOREIGN_NAMESPACE}`,
    ]),
    // Every label again as a BARE host, with no Namespace at all. A mirror that
    // made its `\.<Namespace>` suffix optional would answer yes to a label that
    // names no host, and nothing above would have noticed — every other fixture
    // carries a dot. These are also the only inputs that reach the dotless
    // guard in `canonical()`.
    ...LABELS,
    ...ALPHABET_NEAR_MISSES.flatMap((label) =>
      NAMESPACES.map((namespace) => `${label}.${namespace}`),
    ),
    ...UNANCHORED_NEAR_MISSES,
    ...MULTILINE_NEAR_MISSES,
    ...SEPARATOR_NEAR_MISSES,
    ...TRAILING_ROOT_DOT_NEAR_MISSES,
    ...[EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
      NAMESPACE_NEAR_MISSES.map((namespace) => `${label}.${namespace}`),
    ),
    ...MARKER_NEAR_MISSES.flatMap((label) =>
      NAMESPACES.map((namespace) => `${label}.${namespace}`),
    ),
    ...PADDED_NEAR_MISSES,
    ...EXHAUSTIVE_POSITIVES.flatMap((label) =>
      NAMESPACES.map((namespace) => `${label}.${namespace}`),
    ),
  ];

  /** What the canonical predicates say about a host, for a given class. */
  const canonical = (admits: RehearsalClass, host: string): boolean => {
    const split = host.indexOf('.');
    // A bare label is not a host, and must never be read as one: a negative
    // index here would silently shorten the label and change its class.
    if (split === -1) return false;
    const label = host.slice(0, split);
    const namespace = host.slice(split + 1);
    if (!NAMESPACES.includes(namespace)) return false;
    if (admits === 'event') return isRehearsalEventLabel(label);
    if (admits === 'root') return isRehearsalRootLabel(label);
    return isRehearsalLabel(label);
  };

  it.each(MIRROR_FILES)('%s carries exactly %d tabled host-level regexes', (path, literals) => {
    expect(countHostRegexes(read(path))).toBe(literals);
    // The count alone would not be a coverage guarantee. A fourth literal
    // reddens the line above, and raising 3 to 4 turns it green again with the
    // new mirror still untested — so the count and the number of behavioural
    // rows for this file have to move together, and each row has to name a
    // DISTINCT anchor or several of them bind the same literal.
    const rows = SITES.filter((site) => site.path === path);
    expect(rows).toHaveLength(literals);
    expect(new Set(rows.map((site) => site.anchor)).size).toBe(literals);
  });

  it('tables no mirror outside the counted files', () => {
    const counted = new Set(MIRROR_FILES.map(([path]) => path));
    for (const site of SITES) expect(counted.has(site.path), site.path).toBe(true);
  });

  /**
   * The composed pattern each mirror must BE, built from the pinned canonical
   * body and the imported Namespace list.
   *
   * This is the check that closes the block, and it exists because the fixture
   * could not. Seven rounds of review each found another coordinate of the
   * input space the host table sampled — the base32 exclusions, the edit
   * alphabet, insertion position, narrowings, uppercase inside a fixed
   * component, several positions varying at once, lengths further from the
   * exact one, a second foreign Namespace. Each was real, and closing one never
   * closed the next, because a host is a string and a finite table of them
   * cannot pin an infinite space.
   *
   * The original argument against a textual check was that the canonical
   * pattern classifies a LABEL and every mirror classifies a HOST, so relating
   * them textually could only be a substring test. That was true while the two
   * halves were separate. It stops being true once the canonical pattern is
   * pinned as text and the Namespace list is imported: the host pattern can
   * then be COMPOSED exactly, and composition is not a substring test. Equality
   * against it is closed under every mutation the fixture chased one at a time.
   *
   * The behavioural table below stays, and is still worth its keep. It says
   * what the composition MEANS, it names an offending host when something
   * breaks rather than a diff of two regex sources, and it catches an
   * implementation that stopped consulting its pattern at all.
   */
  const escapeForRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** `(?:` and `(` are the same group here. Nothing in these patterns captures. */
  const normalizeGroups = (source: string): string => source.replaceAll('(?:', '(');

  const composedSource = (admits: RehearsalClass): string => {
    const body = (binding: string): string =>
      hostRegexAfter(read(CANONICAL_SOURCE), binding).source.replace(/^\^/, '').replace(/\$$/, '');
    const event = body(CANONICAL_PATTERNS[0][0]);
    const root = body(CANONICAL_PATTERNS[1][0]);
    const label = admits === 'event' ? event : admits === 'root' ? root : `(${event}|${root})`;
    return `^${label}\\.(${NAMESPACES.map(escapeForRegex).join('|')})$`;
  };

  it.each(SITES)('$path $purpose — composed exactly', ({ path, anchor, admits }) => {
    const mirror = hostRegexAfter(read(path), anchor);
    expect(normalizeGroups(mirror.source)).toBe(composedSource(admits));
    expect(mirror.flags).toBe('');
  });

  it.each(SITES)('$path $purpose', ({ path, anchor, admits }) => {
    const mirror = hostRegexAfter(read(path), anchor);
    for (const host of HOSTS) {
      expect(mirror.test(host), `${host} against ${mirror.source}`).toBe(canonical(admits, host));
    }
  });

  it('exercises both classes on both Namespaces, and mostly on near-misses', () => {
    // Without this the whole block could pass vacuously: a fixture of hosts
    // that no regex matches agrees with a canonical predicate that matches
    // nothing either, and a mistyped suffix length is exactly how you get one.
    // The foreign Namespace has to stay foreign. If the router ever adopted it,
    // every near-miss built on it would quietly become a positive, and the
    // failures would land on the site rows rather than naming the cause.
    expect(NAMESPACES).not.toContain(FOREIGN_NAMESPACE);
    for (const namespace of NAMESPACES) {
      const under = HOSTS.filter((host) => host.endsWith(`.${namespace}`));
      expect(under.filter((host) => canonical('event', host)).length).toBeGreaterThan(0);
      expect(under.filter((host) => canonical('root', host)).length).toBeGreaterThan(0);
    }
    const positives = HOSTS.filter((host) => canonical('either', host));
    expect(HOSTS.length - positives.length).toBeGreaterThan(positives.length);
  });

  /**
   * What the two classes ARE, restated independently of the regexes in
   * `src/slug.ts` that implement them: the marker, the exact suffix length, and
   * the RFC 4648 lowercase base32 alphabet.
   *
   * Deliberately a second statement of the same rule, for the reason
   * `describe('reserved infrastructure labels')` above pins `RESERVED_LABELS`
   * verbatim and exhaustively. Every other assertion in this block asks whether
   * the mirrors AGREE with the canonical predicates, which is silent about the
   * canonical predicates themselves: widen `REHEARSAL_EVENT_LABEL` to
   * `^r2-(?:x-)?[a-z2-7]{26}$` and `r2-x-…` becomes canonical while all seven
   * mirrors keep rejecting it — a real parity break that leaves every
   * expectation here unchanged, because no fixture ever probes a shape I did
   * not already think of.
   *
   * So the shape is pinned. Widening a class is then a two-file edit, and this
   * fixture has to be told about the new shape before the mirrors can be
   * measured against it.
   */

  /**
   * The canonical patterns themselves, lifted out of `src/slug.ts` by the same
   * scanner the mirrors go through, and pinned to their exact text.
   *
   * The first attempt at this pin sampled: a handful of segments a widened
   * class might insert after the marker. That is the same mistake the fixture
   * kept making elsewhere — `(?:preview-)?` was not among the five sampled
   * segments and sailed through. A sample of an infinite space cannot pin it.
   *
   * So the pattern is pinned as TEXT, which is closed: any widening at all
   * changes these strings. That is not the textual comparison this block argues
   * against — that argument is about comparing two regexes over DIFFERENT
   * subjects, where a substring test is all you get. Asserting one regex is
   * exactly what it is supposed to be is a different act, and it is what
   * `describe('reserved infrastructure labels')` does to `RESERVED_LABELS`.
   *
   * The behavioural checks below then say what that text MEANS, and catch an
   * implementation that stopped consulting the pattern at all.
   */
  const CANONICAL_SOURCE = 'src/slug.ts';
  const CANONICAL_PATTERNS: readonly (readonly [binding: string, source: string])[] = [
    ['const REHEARSAL_EVENT_LABEL =', String.raw`^r2-[a-z2-7]{26}$`],
    ['const REHEARSAL_ROOT_LABEL =', String.raw`^r2-root-[a-z2-7]{20}$`],
  ];

  it.each(CANONICAL_PATTERNS)('%s is pinned to its exact pattern', (binding, source) => {
    const canonicalRegex = hostRegexAfter(read(CANONICAL_SOURCE), binding);
    expect(canonicalRegex.source).toBe(source);
    expect(canonicalRegex.flags).toBe('');
  });

  it('keeps the exported predicates answering for the pinned patterns', () => {
    // The pin above is text; this is what the text has to MEAN. An
    // implementation that stopped consulting its pattern would pass the first
    // and fail here.
    const pinnedEvent = hostRegexAfter(read(CANONICAL_SOURCE), CANONICAL_PATTERNS[0][0]);
    const pinnedRoot = hostRegexAfter(read(CANONICAL_SOURCE), CANONICAL_PATTERNS[1][0]);
    for (const label of CANONICAL_PROBES) {
      expect(isRehearsalEventLabel(label), `event: ${label}`).toBe(pinnedEvent.test(label));
      expect(isRehearsalRootLabel(label), `root: ${label}`).toBe(pinnedRoot.test(label));
    }
  });

  /**
   * Shapes a widened canonical class would plausibly start accepting, none of
   * which any mirror accepts. An inserted segment after either marker, a
   * borrowed marker, and every suffix length within three of each exact one.
   */
  const CANONICAL_PROBES = [
    ...LABELS,
    ...MARKER_NEAR_MISSES,
    ...['x', 'r2', 'root', 'test', 'v2'].flatMap((segment) => [
      `${EVENT_MARKER}${segment}-${suffix(EVENT_SUFFIX_LENGTH)}`,
      `${ROOT_MARKER}${segment}-${suffix(ROOT_SUFFIX_LENGTH)}`,
      `${EVENT_MARKER}${segment}-${suffix(ROOT_SUFFIX_LENGTH)}`,
    ]),
    ...[-3, -2, -1, 0, 1, 2, 3].flatMap((delta) => [
      `${EVENT_MARKER}${suffix(EVENT_SUFFIX_LENGTH + delta)}`,
      `${ROOT_MARKER}${suffix(ROOT_SUFFIX_LENGTH + delta)}`,
      `${EVENT_MARKER}${suffix(ROOT_SUFFIX_LENGTH + delta)}`,
      `${ROOT_MARKER}${suffix(EVENT_SUFFIX_LENGTH + delta)}`,
    ]),
  ];

  it('pins the canonical classes to their documented shape', () => {
    for (const label of CANONICAL_PROBES) {
      expect(isRehearsalEventLabel(label), `event: ${label}`).toBe(isEventShaped(label));
      expect(isRehearsalRootLabel(label), `root: ${label}`).toBe(isRootShaped(label));
      expect(isRehearsalLabel(label), `either: ${label}`).toBe(
        isEventShaped(label) || isRootShaped(label),
      );
    }
    // The probe set has to contain both accepted shapes, or the pin is vacuous.
    expect(CANONICAL_PROBES.filter(isEventShaped).length).toBeGreaterThan(0);
    expect(CANONICAL_PROBES.filter(isRootShaped).length).toBeGreaterThan(0);
  });

  it('keeps the two classes disjoint, so no host is both', () => {
    // The `either` expectation above is a union, and a union hides an overlap.
    for (const label of LABELS) {
      expect(isRehearsalEventLabel(label) && isRehearsalRootLabel(label), label).toBe(false);
    }
  });
});

describe('validateSlug', () => {
  it.each(['bodega-bay', 'med-2026', 'x7z', 'a-b-c', '2026', 'a'.repeat(SLUG_MAX_LENGTH)])(
    'accepts %s',
    (candidate) => {
      expect(validateSlug(candidate)).toEqual({ ok: true, slug: candidate });
    },
  );

  it.each([
    ['', 'empty'],
    ['ab', 'too-short'],
    ['a'.repeat(SLUG_MAX_LENGTH + 1), 'too-long'],
    ['Bodega-Bay', 'invalid-characters'],
    ['bodega bay', 'invalid-characters'],
    ['bodega_bay', 'invalid-characters'],
    ['bodega.bay', 'invalid-characters'],
    ['bodega/bay', 'invalid-characters'],
    ['bodega​bay', 'invalid-characters'],
    ['bodegabaÿ', 'invalid-characters'],
    ['-bodega', 'edge-hyphen'],
    ['bodega-', 'edge-hyphen'],
    ['xn--80ak6aa92e', 'reserved-tag'],
    ['ab--cd', 'reserved-tag'],
  ] as const)('refuses %s as %s', (candidate, reason) => {
    expect(validateSlug(candidate)).toEqual({ ok: false, reason });
  });

  it('accepts a hyphen pair anywhere other than the reserved third-fourth position', () => {
    expect(validateSlug('bodega--bay')).toEqual({ ok: true, slug: 'bodega--bay' });
  });

  it('is strict about case rather than normalising, so a wire label is judged as written', () => {
    // The router hands this function bytes that arrived over the network. If
    // the validator normalised, the router's guard would become lenient about a
    // distinction it is supposed to have already resolved.
    expect(validateSlug('BODEGA-BAY').ok).toBe(false);
    expect(validateSlug(normalizeSlug('BODEGA-BAY'))).toEqual({ ok: true, slug: 'bodega-bay' });
  });

  it('rejects a candidate one character below the floor and accepts it at the floor', () => {
    expect(validateSlug('a'.repeat(SLUG_MIN_LENGTH - 1))).toEqual({ ok: false, reason: 'too-short' });
    expect(validateSlug('a'.repeat(SLUG_MIN_LENGTH)).ok).toBe(true);
  });
});

describe('normalizeSlug', () => {
  it('trims and lowercases and does nothing else', () => {
    expect(normalizeSlug('  Bodega-Bay \n')).toBe('bodega-bay');
    // Notably it does NOT repair an invalid candidate — normalisation is a
    // typing affordance, not a sanitiser.
    expect(normalizeSlug('Bodega Bay')).toBe('bodega bay');
    expect(validateSlug(normalizeSlug('Bodega Bay')).ok).toBe(false);
  });
});
