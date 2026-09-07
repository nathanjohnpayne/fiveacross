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
 * So this compares BEHAVIOUR. Each regex literal is lifted out of the source
 * text, rebuilt with `new RegExp`, and run over one shared fixture of hosts
 * alongside the canonical predicate it is supposed to agree with. The
 * expectations are DERIVED from `isRehearsalEventLabel` / `isRehearsalRootLabel`
 * rather than written down twice, so the canonical module stays the only place
 * either class is defined.
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
 * assertion here. Closing that needs the fixtures driven through each deployed
 * entry point instead, which is a different test against a different surface;
 * `router-publisher` has no suite of its own to put it in yet. Tracked in #1135;
 * do not read a green run here as a claim about call sites.
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
