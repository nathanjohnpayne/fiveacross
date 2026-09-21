// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isRehearsalLabel, isRehearsalRootLabel, validateSlug } from '../../src/slug';
import { NAMESPACES } from '../../worker/src/host';
import { isRegistryHost, replicaPayloadFromEvent, validDesired } from './runtime';

/**
 * The CALL-SITE half of the rehearsal-class parity check (#1135).
 *
 * `src/slug.test.ts` § `rehearsal-class mirrors in separately deployed
 * programs` pins the three `r2-` literals in `runtime.ts` as TEXT: each must
 * equal the pattern composed from the canonical label patterns and the router's
 * Namespace list. That check is closed — every widening and narrowing of a
 * literal changes the string it is compared against, which no finite table of
 * example hosts could ever be — and it is the reason this file does not try to
 * pin the literals again.
 *
 * What it cannot see is the EXPRESSION each literal is evaluated in. The sharp
 * example, from the Codex review that raised #1135:
 *
 * ```ts
 * // isRegistryHost
 * /^(?:r2-[a-z2-7]{26}|r2-root-[a-z2-7]{20})\.(?:…)$/.test(host.toLowerCase())
 * ```
 *
 * That typechecks, leaves the extracted literal byte-identical, passes every
 * assertion in the composed check, and makes the publisher admit uppercase
 * rehearsal hosts that `validateSlug` and the edge router both refuse. The same
 * shape covers any operand rewrite, a negation flipped at the call site, and a
 * branch that stops consulting its regex at all.
 *
 * So this suite reads no source text. It drives a host fixture through the
 * three call sites themselves — `isRegistryHost`, and the `route` and `root`
 * branches of `validDesired`, which is where the other two literals live — and
 * then through `replicaPayloadFromEvent`, the exported entry point that reaches
 * all three, so that "exported for the test" is not a fiction about a function
 * production no longer consults.
 *
 * EVERY expectation is DERIVED, never restated: from `isRehearsalLabel` /
 * `isRehearsalRootLabel` for the two closed rehearsal classes and from
 * `validateSlug` for an ordinary claimable Slug, all imported from the
 * canonical `src/slug.ts` that `runtime.ts` is forbidden to import (its
 * `rootDir: "src"` is what makes the mirror a mirror). Writing the answers out
 * by hand here would produce a third copy of the rule for the other two to
 * drift away from.
 *
 * The two suites are a pair and neither subsumes the other. The composed check
 * covers the two `.mjs` controllers as well, and closes the literal space in a
 * way a fixture cannot. This one closes the call sites in a way source-scanning
 * cannot.
 *
 * MUTATIONS this suite was checked against, all with the literals untouched
 * unless stated. Caught: `.test(host.toLowerCase())` in `isRegistryHost` (4
 * failing tests); `!rootTest` dropped to `rootTest` in the `route` branch (1);
 * `.test(host.toLowerCase())` on `syntheticRoot` (2); `isRegistryHost`'s
 * literal widened to `{2,26}` (4); its whole regex term replaced by `false`
 * (4); `replicaPayloadFromEvent` skipping `validDesired` for `route` rows,
 * both for every host and for `r2-root-*` hosts alone (1 each). Two mutations
 * survive and are EQUIVALENT rather than missed, which is worth knowing before
 * anyone strengthens the fixture to chase them:
 * `(syntheticRoot || rootClass !== undefined)` forced true changes no answer,
 * because the ternary below it consults `syntheticRoot` again and the
 * `rootClass` arm then fails on `edition`; and `.test(host.toLowerCase())` on
 * `rootTest` changes no answer, because `isRegistryHost` has already refused
 * every host whose lowercase form differs from itself before `!rootTest` is
 * reached.
 */
describe('rehearsal-class call sites in the registry publisher', () => {
  /**
   * A real root host, and deliberately NOT a wildcard Namespace: no rehearsal
   * host may ever be dealt under it, so every fixture host built on it is a
   * negative. Same near-miss the composed check uses, and the assertion below
   * keeps it foreign.
   */
  const FOREIGN_NAMESPACE = 'gaycruisebingo.com';

  /**
   * The shape parameters of the two classes — marker, exact suffix length, RFC
   * 4648 lowercase base32 — restated here only to BUILD inputs. Nothing is
   * asserted from them: if a class were widened and these were left behind the
   * fixture would get less pointed, never wrong, because every expectation
   * comes from the canonical predicates. Pinning the classes themselves is
   * `src/slug.test.ts`'s job and it does it as text.
   */
  const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
  const EVENT_MARKER = 'r2-';
  const ROOT_MARKER = 'r2-root-';
  const EVENT_SUFFIX_LENGTH = 26;
  const ROOT_SUFFIX_LENGTH = 20;

  const suffix = (length: number): string => BASE32.slice(0, length);

  const EVENT_POSITIVE = `${EVENT_MARKER}${suffix(EVENT_SUFFIX_LENGTH)}`;
  const ROOT_POSITIVE = `${ROOT_MARKER}${suffix(ROOT_SUFFIX_LENGTH)}`;

  /**
   * Accepted labels placing EVERY base32 character at EVERY suffix position,
   * for both classes. These hunt NARROWINGS, which a near-miss cannot reach: a
   * call site that consulted a narrowed copy would 404 a dealt rehearsal Event
   * while every negative below stayed negative.
   */
  const everyPositionAndCharacter = (marker: string, length: number): string[] =>
    Array.from({ length }, (_unused, position) =>
      [...BASE32].map((character) => {
        const body = suffix(length);
        return `${marker}${body.slice(0, position)}${character}${body.slice(position + 1)}`;
      }),
    ).flat();

  /**
   * One character outside lowercase base32, substituted at the END of the
   * suffix and again in the MIDDLE of it. Two positions because a widened
   * character class can be written anywhere in a pattern, and a fixture that
   * only ever spoils the last character cannot tell a class widened in place
   * from one widened at the edge. `_`, `~`, `+` and `%` ride along with the
   * four base32 exclusions and the case and hyphen cases because `[a-z2-7_]`
   * is a plausible slip that digits alone would miss.
   */
  const OUTSIDE_BASE32 = ['A', '0', '1', '8', '9', '_', '-', '+', '~', '%'];

  const nearMisses = (marker: string, length: number): string[] => {
    const label = `${marker}${suffix(length)}`;
    return [
      // A suffix one character short and one character long, which is what
      // separates an exact `{n}` from a `{n-1,n}` or a bare `+`.
      `${marker}${suffix(length - 1)}`,
      `${marker}${suffix(length + 1)}`,
      // Uppercase throughout — the witness for the `.test(host.toLowerCase())`
      // mutation this whole suite exists for.
      `${marker}${suffix(length).toUpperCase()}`,
      ...OUTSIDE_BASE32.flatMap((character) => [
        `${label.slice(0, -1)}${character}`,
        `${label.slice(0, -4)}${character}${label.slice(-3)}`,
      ]),
    ];
  };

  const LABELS = [
    ...everyPositionAndCharacter(EVENT_MARKER, EVENT_SUFFIX_LENGTH),
    ...everyPositionAndCharacter(ROOT_MARKER, ROOT_SUFFIX_LENGTH),
    ...nearMisses(EVENT_MARKER, EVENT_SUFFIX_LENGTH),
    ...nearMisses(ROOT_MARKER, ROOT_SUFFIX_LENGTH),
    // The boundary BETWEEN the classes, which every label above sits on one
    // side of: making `root-` optional admits the first as a root host, and
    // letting the root suffix take an Event's length admits the second.
    `${EVENT_MARKER}${suffix(ROOT_SUFFIX_LENGTH)}`,
    `${ROOT_MARKER}${suffix(EVENT_SUFFIX_LENGTH)}`,
    // The markers with no suffix at all.
    'r2',
    'r2-',
    'r2-root-',
    // Not every fixture label is an `r2-` one. `isRegistryHost` also admits an
    // ordinary claimable Slug, and refuses a reserved infrastructure label —
    // both derived from `validateSlug` below, so a call site that stopped
    // consulting its slug branch reddens here too.
    'bodega-bay',
    'admin',
  ];

  /** Hosts that are not a plain `<label>.<Namespace>` pair, pinning both
   *  anchors: a copy that lost `^` admits a prefixed host, one that lost `$`
   *  admits a suffixed one, and both classify every well-formed host correctly. */
  const UNANCHORED = [
    `not-${EVENT_POSITIVE}.${NAMESPACES[0]}`,
    `${EVENT_POSITIVE}.${NAMESPACES[0]}.example.com`,
    `${ROOT_POSITIVE}.${NAMESPACES[1]}.example.com`,
  ];

  /** `m` rebinds `^` and `$` to LINE boundaries. Not hypothetical here: a host
   *  arrives as a Firestore document id or a CloudEvent payload field, so the
   *  string comes from outside the program. */
  const MULTILINE = [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
    NAMESPACES.flatMap((namespace) => [
      `attacker\n${label}.${namespace}`,
      `${label}.${namespace}\nattacker`,
    ]),
  );

  /** One dot spoiled: the separator before the Namespace, then the dot INSIDE
   *  it. What a `\.` relaxed to a bare `.` costs — every other host here
   *  carries its dots exactly where a mirror expects them, so a wildcarded
   *  separator changes no other answer and would ship silently. */
  const SEPARATOR_SPOILED = [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
    NAMESPACES.flatMap((namespace) => [
      `${label}X${namespace}`,
      `${label}.${namespace.replace('.', 'X')}`,
    ]),
  );

  /** A trailing root dot names the same host in DNS, which is exactly why a
   *  copy might grow a `\.?$` to be accommodating — and why it must not. */
  const TRAILING_ROOT_DOT = [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
    NAMESPACES.map((namespace) => `${label}.${namespace}.`),
  );

  /** Padding at the front, the back, and the separator. `^\s*r2-` is an anchor
   *  widening no other host here can see: a prefixed near-miss uses a letter
   *  and a multiline one puts text before a newline, so neither reaches a
   *  bare leading space. U+00A0, U+200B and NUL ride along because a
   *  hand-rolled whitespace class tends to disagree with `\s` about these. */
  const PADDING = [' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\u200b', '\0'];

  const PADDED = PADDING.flatMap((pad) =>
    [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
      NAMESPACES.flatMap((namespace) => [
        `${pad}${label}.${namespace}`,
        `${label}.${namespace}${pad}`,
        `${label}${pad}.${namespace}`,
      ]),
    ),
  );

  const HOSTS = [
    ...LABELS.flatMap((label) => [
      ...NAMESPACES.map((namespace) => `${label}.${namespace}`),
      `${label}.${FOREIGN_NAMESPACE}`,
    ]),
    // Every label again as a BARE host. A call site whose `\.<Namespace>`
    // suffix went optional would answer yes to a label that names no host.
    ...LABELS,
    ...UNANCHORED,
    ...MULTILINE,
    ...SEPARATOR_SPOILED,
    ...TRAILING_ROOT_DOT,
    ...PADDED,
  ];

  /**
   * Split a host into its first label and the rest, the way every literal in
   * `runtime.ts` does: each is anchored over the WHOLE host and its label
   * component excludes `.`, so a host with a nested label is out of Namespace
   * rather than being read as a shorter one.
   */
  const parts = (host: string): { label: string; namespace: string } | null => {
    const split = host.indexOf('.');
    if (split === -1) return null;
    return { label: host.slice(0, split), namespace: host.slice(split + 1) };
  };

  /** What `isRegistryHost` must say, derived from the canonical rules. */
  const canonicalRegistryHost = (host: string): boolean => {
    const split = parts(host);
    if (split === null || !NAMESPACES.includes(split.namespace)) return false;
    return isRehearsalLabel(split.label) || validateSlug(split.label).ok;
  };

  /** What the `rootTest` / `syntheticRoot` literals must say. */
  const canonicalRootTestHost = (host: string): boolean => {
    const split = parts(host);
    if (split === null || !NAMESPACES.includes(split.namespace)) return false;
    return isRehearsalRootLabel(split.label);
  };

  /**
   * A well-formed desired row per kind, built so that every condition in
   * `validDesired` EXCEPT the rehearsal-class one already holds — the shape,
   * the Edition, the path Namespace, the status. What is left varying is
   * exactly the literal under test, so a failure names a class decision rather
   * than a malformed fixture.
   *
   * The `route` row uses the non-root-host branch (`slug` equal to the first
   * label, `pathNamespace` null), which is the branch every host here takes:
   * none of them is one of the six operator root hosts in `ROOT_HOSTS`. That
   * table is a different mirror — the Edition and path-Namespace projection,
   * untouched by any rehearsal-class edit — and is out of scope for #1135.
   */
  const tombstoneRow = (): Record<string, unknown> => ({ kind: 'tombstone' });

  const routeRow = (host: string): Record<string, unknown> => ({
    kind: 'route',
    eventId: 'evt-1135',
    status: 'active',
    slug: host.split('.')[0],
    edition: 'fiveacross',
    pathNamespace: null,
  });

  const rootRow = (): Record<string, unknown> => ({
    kind: 'root',
    root: 'doorway',
    edition: 'fiveacross',
    pathNamespace: null,
  });

  /** The publisher's exported entry point, as a predicate. It reaches all three
   *  literals through `validDesired`, so this is the assertion that the call
   *  sites are on the live path rather than merely exported. */
  const entryPointAccepts = (host: string, desired: Record<string, unknown>): boolean => {
    try {
      replicaPayloadFromEvent(host, {
        schemaVersion: 1,
        revision: '1',
        host,
        desired,
        updatedAt: '2026-09-11T00:00:00Z',
      });
      return true;
    } catch {
      return false;
    }
  };

  it('tables only rehearsal-shaped and ordinary-Slug hosts', () => {
    // `canonicalRegistryHost` derives its answer from the rehearsal classes and
    // `validateSlug` alone, so it would be WRONG about one of the six operator
    // root hosts — those are admitted by a literal list in `isRegistryHost`,
    // not by either rule. None is reachable from the builders above; this keeps
    // it that way as the fixture grows.
    for (const host of HOSTS) {
      expect(host.includes('r2') || host.startsWith('bodega-bay') || host.startsWith('admin'), host)
        .toBe(true);
    }
  });

  it('exercises both classes on both Namespaces, and mostly on near-misses', () => {
    // Without this the suite could pass vacuously: a fixture no call site
    // admits agrees with a canonical rule that admits nothing either, and a
    // mistyped suffix length is exactly how you get one.
    expect(NAMESPACES).not.toContain(FOREIGN_NAMESPACE);
    for (const namespace of NAMESPACES) {
      const under = HOSTS.filter((host) => host.endsWith(`.${namespace}`));
      expect(under.filter((host) => canonicalRootTestHost(host)).length).toBeGreaterThan(0);
      expect(
        under.filter((host) => canonicalRegistryHost(host) && !canonicalRootTestHost(host)).length,
      ).toBeGreaterThan(0);
    }
    expect(HOSTS.filter((host) => !canonicalRegistryHost(host)).length).toBeGreaterThan(0);
  });

  it('tables every shape #1135 asks for', () => {
    // The acceptance list, asserted as PRESENCE rather than trusted to the
    // builders above: canonical positives, wrong lengths either way, uppercase,
    // all four base32 exclusions, a hyphen inside a root suffix, a spoiled
    // separator, a bare label, a newline-bearing host, and a third Namespace.
    const present = (host: string): void => expect(HOSTS, host).toContain(host);
    present(`${EVENT_POSITIVE}.${NAMESPACES[0]}`);
    present(`${ROOT_POSITIVE}.${NAMESPACES[1]}`);
    present(`${EVENT_MARKER}${suffix(EVENT_SUFFIX_LENGTH - 1)}.${NAMESPACES[0]}`);
    present(`${EVENT_MARKER}${suffix(EVENT_SUFFIX_LENGTH + 1)}.${NAMESPACES[0]}`);
    present(`${EVENT_MARKER}${suffix(EVENT_SUFFIX_LENGTH).toUpperCase()}.${NAMESPACES[0]}`);
    present(`${ROOT_MARKER}${suffix(ROOT_SUFFIX_LENGTH).toUpperCase()}.${NAMESPACES[0]}`);
    for (const digit of ['0', '1', '8', '9']) {
      present(`${EVENT_POSITIVE.slice(0, -1)}${digit}.${NAMESPACES[0]}`);
    }
    present(`${ROOT_POSITIVE.slice(0, -1)}-.${NAMESPACES[0]}`);
    present(`${EVENT_POSITIVE}X${NAMESPACES[0]}`);
    present(EVENT_POSITIVE);
    present(`attacker\n${EVENT_POSITIVE}.${NAMESPACES[0]}`);
    present(`${EVENT_POSITIVE}.${FOREIGN_NAMESPACE}`);
  });

  it('isRegistryHost agrees with the canonical rules on every tabled host', () => {
    for (const host of HOSTS) {
      expect(isRegistryHost(host), host).toBe(canonicalRegistryHost(host));
    }
  });

  it('validDesired admits a tombstone exactly on a registry host', () => {
    for (const host of HOSTS) {
      expect(validDesired(host, tombstoneRow()), host).toBe(canonicalRegistryHost(host));
    }
  });

  it('validDesired keeps a route row off a root-test host', () => {
    for (const host of HOSTS) {
      expect(validDesired(host, routeRow(host)), host).toBe(
        canonicalRegistryHost(host) && !canonicalRootTestHost(host),
      );
    }
  });

  it('validDesired admits a root row exactly on a root-test host', () => {
    for (const host of HOSTS) {
      expect(validDesired(host, rootRow()), host).toBe(canonicalRootTestHost(host));
    }
  });

  it('replicaPayloadFromEvent carries every tabled host to the same answer', () => {
    // The exported entry point, unchanged by #1135, reaching all three literals
    // through `validDesired`. A host uppercase or trailing-dotted enough to
    // trip the entry point's own guards is already a canonical negative, so the
    // predicates coincide over this fixture.
    //
    // All THREE kinds go through it, not just the two that end in a single
    // literal. `tombstone` reaches `isRegistryHost` and `root` reaches
    // `syntheticRoot`, but neither touches the `route` branch's `rootTest` —
    // the one literal here that is consulted NEGATED. Without the `route` row
    // below, an entry point that stopped consulting `validDesired` for route
    // rows specifically would admit an ordinary Event row on an `r2-root-*`
    // host while this suite and the publisher's own runtime suite both stayed
    // green.
    for (const host of HOSTS) {
      expect(entryPointAccepts(host, tombstoneRow()), host).toBe(canonicalRegistryHost(host));
      expect(entryPointAccepts(host, routeRow(host)), host).toBe(
        canonicalRegistryHost(host) && !canonicalRootTestHost(host),
      );
      expect(entryPointAccepts(host, rootRow()), host).toBe(canonicalRootTestHost(host));
    }
  });

  /**
   * The mutation #1135 was opened for, asserted directly.
   *
   * Rewriting `isRegistryHost`'s call site to `.test(host.toLowerCase())`
   * leaves the regex literal byte-identical, so `src/slug.test.ts` stays green
   * and the publisher starts admitting these. It would key a registry row under
   * a host string nothing else in the system produces: `validateSlug` refuses
   * the whole `r2-` prefix to an organizer, and the edge router lowercases
   * before it classifies, so no uppercase host ever reaches a lookup.
   */
  it('refuses an uppercase rehearsal host at every call site', () => {
    const uppercase = [EVENT_POSITIVE, ROOT_POSITIVE].flatMap((label) =>
      NAMESPACES.map((namespace) => `${label.toUpperCase()}.${namespace}`),
    );
    for (const host of uppercase) {
      expect(isRegistryHost(host), host).toBe(false);
      expect(validDesired(host, tombstoneRow()), host).toBe(false);
      expect(validDesired(host, routeRow(host)), host).toBe(false);
      expect(validDesired(host, rootRow()), host).toBe(false);
      expect(entryPointAccepts(host, tombstoneRow()), host).toBe(false);
    }
  });
});

/**
 * The `updatedAt` half of the source/edge agreement (#971, CodeRabbit round).
 *
 * `replicaPayloadFromEvent` is the second reader of a stored ledger's
 * `updatedAt`, after `normalizeTimestamp` in
 * `scripts/event-router-registry/hostname-projection.mjs`, and the two are
 * required to answer one text for one instant: the source digests its answer
 * into `documentDigest`, so a publisher that echoed the stored spelling would
 * put a body on the wire that an audit could not match against the row it was
 * published from. Only the canonical `toISOString()` form is published.
 */
describe('the publisher timestamp canonicalizer', () => {
  const HOST = 'bodega-bay.fiveacross.app';
  const payloadFor = (updatedAt: unknown): Record<string, unknown> => ({
    schemaVersion: 1,
    revision: '1',
    host: HOST,
    desired: {
      kind: 'route',
      eventId: 'bodega-bay-2026',
      status: 'active',
      slug: 'bodega-bay',
      edition: 'fiveacross',
      pathNamespace: null,
    },
    updatedAt,
  });

  it.each([
    ['a Z spelling', '2026-09-20T12:00:00Z'],
    ['a zero-offset spelling', '2026-09-20T12:00:00+00:00'],
    ['a shifted-offset spelling', '2026-09-20T14:00:00+02:00'],
    ['a sub-millisecond spelling', '2026-09-20T12:00:00.000123Z'],
    ['a Firestore Timestamp', { toDate: () => new Date('2026-09-20T12:00:00.000Z') }],
  ])('publishes %s as the one canonical instant', (_why, updatedAt: unknown) => {
    expect(replicaPayloadFromEvent(HOST, payloadFor(updatedAt)).updatedAt).toBe(
      '2026-09-20T12:00:00.000Z',
    );
  });

  it.each([
    ['an offsetless string a machine would read as local time', '2026-09-20T12:00:00'],
    ['a text Date.parse accepts but RFC 3339 does not', 'Sep 20 2026 12:00:00 GMT+0000'],
    ['a date with no time of day', '2026-09-20'],
    ['an RFC 3339 shape that names no instant', '2026-13-40T25:00:00Z'],
    ['an empty string', ''],
    // The `Date.UTC` year bound the source draws too: this field is a publish
    // instant, so a first-century year is corruption and refusing it fails
    // closed. Both layers must move together or they disagree about which
    // texts are admissible.
    ['a year before 0100, which is not a publish instant', '0099-12-31T23:59:59Z'],
    // The offset is applied AFTER the written components are judged, so the
    // emitted text is validated too: these two canonicalise outside the
    // range the source and the worker accept.
    ['an offset that carries the first supported year below the bound', '0100-01-01T00:00:00+01:00'],
    ['an offset that carries the last supported year into the expanded form', '9999-12-31T23:59:59-01:00'],
  ])('refuses %s', (_why, updatedAt) => {
    expect(() => replicaPayloadFromEvent(HOST, payloadFor(updatedAt))).toThrow(
      'invalid router replica event',
    );
  });

  // `Date.parse` ROLLS an impossible day forward instead of refusing it, so
  // without the calendar check the publisher would put an instant on the wire
  // that no ledger ever named: `2026-02-30T12:00:00Z` parses to March 2.
  it.each([
    ['a day past the end of February', '2026-02-30T12:00:00Z'],
    ['a thirty-first of April', '2026-04-31T12:00:00Z'],
    ['a leap day in a year that has none', '2025-02-29T12:00:00Z'],
    ['a zeroth day', '2026-09-00T12:00:00Z'],
    ['a day past the end of a month under an offset', '2026-02-30T12:00:00+02:00'],
  ])('refuses %s rather than rolling it forward', (_why, updatedAt) => {
    expect(() => replicaPayloadFromEvent(HOST, payloadFor(updatedAt))).toThrow(
      'invalid router replica event',
    );
  });

  it('publishes the leap day of a year that has one', () => {
    expect(replicaPayloadFromEvent(HOST, payloadFor('2028-02-29T12:00:00Z')).updatedAt).toBe(
      '2028-02-29T12:00:00.000Z',
    );
  });

  // The Timestamp branch goes through the same predicate, so the two
  // encodings accept the same instants here as they do on the source side.
  it('refuses a Firestore Timestamp for a year the string branch refuses', () => {
    const before0100 = new Date(0);
    before0100.setUTCFullYear(99, 11, 31);
    before0100.setUTCHours(23, 59, 59, 0);
    expect(() => replicaPayloadFromEvent(HOST, payloadFor({ toDate: () => before0100 }))).toThrow(
      'invalid router replica event',
    );
  });
});
