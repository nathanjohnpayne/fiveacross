// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyHost, NAMESPACES, normalizeHost } from './host';
import { RESERVED_LABELS } from '../../src/slug';

describe('NAMESPACES', () => {
  it('is exactly the canonical apex and the Vacay apex', () => {
    expect([...NAMESPACES]).toEqual(['fiveacross.app', 'vacaybingo.com']);
  });

  it('does not route the retired brand zone', () => {
    // `fiveacrossbingo.com` becomes a 301 redirect to `fiveacross.app` (#630).
    // Routing it here would keep alive an origin whose purpose is to stop
    // existing, so its absence is a decision, not an oversight.
    expect(NAMESPACES).not.toContain('fiveacrossbingo.com');
    expect(classifyHost('bodega-bay.fiveacrossbingo.com')).toMatchObject({
      kind: 'rejected',
      reason: 'out-of-namespace',
    });
  });
});

describe('normalizeHost', () => {
  it.each([
    ['BODEGA-BAY.FiveAcross.App', 'bodega-bay.fiveacross.app'],
    ['bodega-bay.fiveacross.app.', 'bodega-bay.fiveacross.app'],
    ['bodega-bay.fiveacross.app:8787', 'bodega-bay.fiveacross.app'],
    ['  bodega-bay.fiveacross.app  ', 'bodega-bay.fiveacross.app'],
    ['[2606:4700::1]:443', '[2606:4700::1]'],
  ])('normalises %s', (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });
});

describe('classifyHost — the serving cases', () => {
  it.each(['bodega-bay.fiveacross.app', 'bodega-bay.vacaybingo.com'])(
    'classifies %s as an Event address in place, with no canonical preference',
    (host) => {
      expect(classifyHost(host)).toEqual({
        kind: 'event',
        host,
        namespace: host.endsWith('fiveacross.app') ? 'fiveacross.app' : 'vacaybingo.com',
        slug: 'bodega-bay',
      });
    },
  );

  it.each(['fiveacross.app', 'vacaybingo.com'])('classifies the %s apex with no Slug', (host) => {
    expect(classifyHost(host)).toEqual({ kind: 'apex', host, namespace: host, slug: null });
  });

  it('normalises case before classifying', () => {
    expect(classifyHost('Bodega-Bay.FIVEACROSS.app')).toMatchObject({
      kind: 'event',
      slug: 'bodega-bay',
    });
  });
});

describe('classifyHost — the guard', () => {
  it.each([...RESERVED_LABELS].flatMap((label) => NAMESPACES.map((ns) => `${label}.${ns}`)))(
    'refuses %s as a reserved infrastructure label',
    (host) => {
      expect(classifyHost(host)).toEqual({ kind: 'rejected', host, reason: 'reserved-label' });
    },
  );

  it.each([
    'bodega-bay.example.com',
    'fiveacross.app.evil.example',
    'notfiveacross.app',
    'vacaybingo.com.attacker.test',
    'localhost',
    '[2606:4700::1]',
    // The DNS root dot names the same resource, but serializes as a different
    // web origin. Refuse it before the app could mount with unsafe auth state.
    'bodega-bay.fiveacross.app.',
  ])('refuses %s as out of namespace', (host) => {
    expect(classifyHost(host)).toMatchObject({ kind: 'rejected', reason: 'out-of-namespace' });
  });

  it('refuses a nested label rather than treating the leftmost as the Slug', () => {
    // `a.bodega-bay.fiveacross.app` is outside the single-level wildcard
    // certificate anyway; classifying it explicitly stops a future reader from
    // "fixing" it into a Slug match on the last label.
    expect(classifyHost('a.bodega-bay.fiveacross.app')).toMatchObject({
      kind: 'rejected',
      reason: 'nested-label',
    });
  });

  it.each([
    ['ab.fiveacross.app', 'too-short'],
    ['-bodega.fiveacross.app', 'edge-hyphen'],
    ['bodega_bay.fiveacross.app', 'invalid-characters'],
    ['xn--80ak6aa92e.fiveacross.app', 'reserved-tag'],
  ] as const)('refuses %s against the Slug contract (%s)', (host, detail) => {
    expect(classifyHost(host)).toEqual({ kind: 'rejected', host, reason: 'invalid-slug', detail });
  });

  it('refuses the Worker\'s own workers.dev address, which constrains how it can be smoke-tested', () => {
    // Not a defect — a `*.workers.dev` hostname is genuinely outside every
    // Namespace this router guards, and admitting it would be the bug. It is
    // pinned because it has an operational consequence that cost a round of
    // review: a request dispatched TO the workers.dev address carries that
    // hostname in `request.url`, and sending `Host: bodega-bay.fiveacross.app`
    // does not change it. So the deployed-but-unrouted Worker cannot be
    // smoke-tested by curling workers.dev with a Host override, and
    // worker/README.md uses `wrangler dev --remote` for that instead.
    expect(classifyHost('five-across-event-router.nathanpayne.workers.dev')).toMatchObject({
      kind: 'rejected',
      reason: 'out-of-namespace',
    });
  });

  it('guards a suffix boundary rather than a substring', () => {
    // The dot is part of the comparison: `evilfiveacross.app` must not inherit
    // the Namespace by ending with its characters.
    expect(classifyHost('evilfiveacross.app')).toMatchObject({ reason: 'out-of-namespace' });
    expect(classifyHost('x.evilfiveacross.app')).toMatchObject({ reason: 'out-of-namespace' });
  });
});

/**
 * The one deliberate hole in the `r2-` reservation, and its edges.
 *
 * The registry contract needs the router to ROUTE the two closed rehearsal
 * classes — they are the only real-Namespace surface the cutover evidence can
 * be measured on — while `validateSlug` keeps the whole `r2-` prefix
 * permanently unclaimable by an organizer. Addressable is not servable: a
 * rehearsal host with no committed registry projection still fails closed as
 * `unknown-host` one layer up, and only the guarded controller can create one.
 */
describe('classifyHost — the closed rehearsal classes (#972)', () => {
  const eventLabel = `r2-${'a'.repeat(26)}`;
  const rootLabel = `r2-root-${'b'.repeat(20)}`;

  it.each(NAMESPACES.flatMap((ns) => [eventLabel, rootLabel].map((label) => [label, ns] as const)))(
    'classifies %s.%s as an addressable Event-shaped host',
    (label, namespace) => {
      expect(classifyHost(`${label}.${namespace}`)).toEqual({
        kind: 'event',
        host: `${label}.${namespace}`,
        namespace,
        slug: label,
      });
    },
  );

  it.each([
    // Every one of these begins `r2-` and is outside both closed classes, so
    // the reservation still applies to it in full.
    'r2-short.fiveacross.app',
    `r2-${'a'.repeat(25)}.fiveacross.app`,
    `r2-${'a'.repeat(27)}.fiveacross.app`,
    // `1`, `8` and `9` are outside RFC 4648's base32 alphabet.
    `r2-${'a1'.repeat(13)}.fiveacross.app`,
    `r2-root-${'b'.repeat(19)}.fiveacross.app`,
    `r2-root-${'b'.repeat(21)}.fiveacross.app`,
    'r2-rehearsal.vacaybingo.com',
  ])('still refuses %s as reserved', (host) => {
    expect(classifyHost(host)).toEqual({ kind: 'rejected', host, reason: 'reserved-label' });
  });

  it('does not extend the exception to another zone', () => {
    expect(classifyHost(`${eventLabel}.example.com`)).toMatchObject({
      kind: 'rejected',
      reason: 'out-of-namespace',
    });
  });

  it('normalises case before deciding, like every other host', () => {
    // DNS is case-insensitive and `normalizeHost` runs first, so an uppercase
    // rehearsal host is the SAME host rather than a near-miss outside the
    // class. The lowercase-only rule is about the label a controller may
    // generate, and `src/slug.test.ts` pins it there.
    expect(classifyHost(`R2-${'A'.repeat(26)}.FIVEACROSS.APP`)).toMatchObject({
      kind: 'event',
      slug: eventLabel,
    });
  });
});
