// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decide,
  resolveHost,
  type NotFoundReason,
  type ResolveConfig,
  type ResolveDeps,
  type RegistryLookupService,
} from './resolve';
import type { ReplicaDesired } from './registry/contracts';
import type { RegistryLookup } from './registry/state';

const CONFIG: ResolveConfig = { lookupTimeoutMs: 2_000 };
const HOST = 'bodega-bay.fiveacross.app';
const SLUG = 'bodega-bay';

/** Every committed-derived envelope names the canonical host it was projected
 *  from (#1133), so the helper takes it — defaulting to the address these
 *  tests look up — rather than letting it be inferred from whichever host the
 *  assertion happens to resolve against. */
function committed(desired: ReplicaDesired, revision = '7', host = HOST): RegistryLookup {
  return { kind: 'committed', schemaVersion: 1, revision, host, desired };
}

const ACTIVE_ROUTE = committed({
  kind: 'route',
  eventId: 'bodega-bay-2026',
  status: 'active',
  slug: SLUG,
  edition: 'fiveacross',
  pathNamespace: null,
});

/** Every seam the resolver has is one method, so the harness is one spy. That
 *  is the whole point of #972: there is no cache to seed, no Firestore to stub
 *  and no envelope to age. */
function harness(answer: RegistryLookup | (() => Promise<RegistryLookup>)) {
  const lookup = vi.fn(typeof answer === 'function' ? answer : async () => answer);
  const registry: RegistryLookupService = { lookup };
  const deps: ResolveDeps = { registry };
  return { deps, lookup };
}

async function refusalFor(
  lookup: RegistryLookup,
  expectedSlug: string | null = SLUG,
): Promise<{ reason: NotFoundReason; revision: string | null }> {
  const { deps } = harness(lookup);
  const resolution = await resolveHost(HOST, expectedSlug, CONFIG, deps);
  expect(resolution.kind).toBe('not-found');
  if (resolution.kind !== 'not-found') throw new Error('expected a fail-closed resolution');
  return { reason: resolution.reason, revision: resolution.revision };
}

async function reasonFor(lookup: RegistryLookup, expectedSlug: string | null = SLUG): Promise<string> {
  return (await refusalFor(lookup, expectedSlug)).reason;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a servable committed projection', () => {
  it('serves an active route and carries its revision through', async () => {
    const { deps, lookup } = harness(ACTIVE_ROUTE);
    const resolution = await resolveHost(HOST, SLUG, CONFIG, deps);

    expect(resolution).toEqual({
      kind: 'serve',
      record: {
        eventId: 'bodega-bay-2026',
        revision: '7',
        pathNamespace: null,
        edition: 'fiveacross',
        root: null,
      },
    });
    // One point lookup for the address that was asked for, and nothing else.
    expect(lookup).toHaveBeenCalledExactlyOnceWith(HOST);
  });

  it('serves the Namespace apex without a Slug cross-check', async () => {
    const { deps } = harness(
      committed(
        {
          kind: 'route',
          eventId: 'bodega-bay-2026',
          status: 'active',
          // The apex projection's slug names the Event's WILDCARD address, not
          // this one, so cross-checking it here would refuse a host that is
          // correct. It must still be PRESENT — the schema requires a non-empty
          // slug on every route, and the apex exemption removes the comparison
          // rather than the requirement.
          slug: 'bodega-bay',
          edition: 'fiveacross',
          // The apex is a path-addressed host class, so its projection carries
          // the matching namespace rather than null.
          pathNamespace: 'fiveacross.app',
        },
        '7',
        'fiveacross.app',
      ),
    );
    await expect(resolveHost('fiveacross.app', null, CONFIG, deps)).resolves.toMatchObject({ kind: 'serve' });
  });

  it.each(['doorway', 'not-found'] as const)(
    'serves a %s root marker: the marker controls the app’s / outcome, not whether the edge may serve',
    async (root) => {
      const { deps } = harness(
        committed(
          { kind: 'root', root, edition: 'fiveacross', pathNamespace: 'fiveacross.app' },
          '7',
          'fiveacross.app',
        ),
      );
      await expect(resolveHost('fiveacross.app', null, CONFIG, deps)).resolves.toEqual({
        kind: 'serve',
        record: {
          eventId: null,
          revision: '7',
          pathNamespace: 'fiveacross.app',
          edition: 'fiveacross',
          root,
        },
      });
    },
  );

  it('serves the guarded r2-root rehearsal class, which carries a first label but no slug', async () => {
    // The synthetic root-test host is the one place a root projection is
    // reached at a LABELLED address. A Slug cross-check against a projection
    // that structurally has no slug would refuse the whole rehearsal class.
    const { deps } = harness(
      committed(
        { kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: null },
        '7',
        'r2-root-abcdefghijklmnopqrst.fiveacross.app',
      ),
    );
    await expect(
      resolveHost(
        'r2-root-abcdefghijklmnopqrst.fiveacross.app',
        'r2-root-abcdefghijklmnopqrst',
        CONFIG,
        deps,
      ),
    ).resolves.toMatchObject({ kind: 'serve', record: { eventId: null, root: 'doorway' } });
  });

  it('does not pin the rehearsal class to an Edition, unlike a real brand root', async () => {
    // The asymmetry is deliberate and worth pinning: a configured root origin
    // brands itself, so `fiveacross.app` may not carry `vacay`. The synthetic
    // class exists to exercise the SHAPE rather than a brand, so it carries
    // whichever Edition the rehearsal manifest chose.
    const { deps } = harness(
      committed(
        { kind: 'root', root: 'doorway', edition: 'vacay', pathNamespace: null },
        '7',
        'r2-root-abcdefghijklmnopqrst.fiveacross.app',
      ),
    );
    await expect(
      resolveHost(
        'r2-root-abcdefghijklmnopqrst.fiveacross.app',
        'r2-root-abcdefghijklmnopqrst',
        CONFIG,
        deps,
      ),
    ).resolves.toMatchObject({ kind: 'serve', record: { edition: 'vacay' } });
  });
});

describe('the fail-closed decision table', () => {
  it('reports the two refusals the spec pages on, and only those, through the diagnostic seam', async () => {
    const events: unknown[] = [];
    const withDiagnostics = (lookup: RegistryLookup | (() => Promise<RegistryLookup>)) => {
      const { deps } = harness(lookup);
      return { ...deps, diagnostics: (event: unknown) => events.push(event) };
    };
    await resolveHost(HOST, SLUG, CONFIG, withDiagnostics({ kind: 'malformed' }));
    await resolveHost(HOST, SLUG, CONFIG, withDiagnostics({ kind: 'unavailable' }));
    await resolveHost(HOST, SLUG, CONFIG, { ...withDiagnostics({ kind: 'unknown-host' }), registry: null });
    expect(events).toEqual([
      { event: 'event-router.diagnostic', outcome: 'replica-malformed', host: HOST },
      { event: 'event-router.diagnostic', outcome: 'lookup-unavailable', host: HOST },
      { event: 'event-router.diagnostic', outcome: 'lookup-unavailable', host: HOST },
    ]);

    // Ordinary refusals and serves are silent: an unknown host is expected traffic,
    // and a slug mismatch is about the address, not the router.
    events.length = 0;
    await resolveHost(HOST, SLUG, CONFIG, withDiagnostics({ kind: 'unknown-host' }));
    const route: ReplicaDesired = {
      kind: 'route',
      eventId: 'bodega-bay-2026',
      status: 'active',
      slug: SLUG,
      edition: 'fiveacross',
      pathNamespace: null,
    };
    await resolveHost(HOST, 'someone-else', CONFIG, withDiagnostics(committed(route)));
    await resolveHost(HOST, SLUG, CONFIG, withDiagnostics(committed(route)));
    expect(events).toEqual([]);

    // A listener that throws never turns a closed refusal into an escaping error.
    const { deps } = harness({ kind: 'malformed' });
    await expect(
      resolveHost(HOST, SLUG, CONFIG, {
        ...deps,
        diagnostics: () => {
          throw new Error('sink down');
        },
      }),
    ).resolves.toMatchObject({ kind: 'not-found', reason: 'replica-malformed' });
  });

  it('answers an uninitialized object as an unknown address', async () => {
    await expect(reasonFor({ kind: 'unknown-host' })).resolves.toBe('unknown-host');
  });

  it('refuses unknown-host metadata that is named but undefined', async () => {
    // Codex P2 on #1120: the service binding carries `undefined` values intact,
    // so a version-skewed registry can answer `{ revision: undefined,
    // schemaVersion: undefined }`. Those keys are NAMED, which an uninitialized
    // object never does; reading absence off them would downgrade a malformed
    // tombstone to an ordinary unknown host and suppress the diagnostic.
    await expect(
      reasonFor({ kind: 'unknown-host', revision: undefined, schemaVersion: undefined }),
    ).resolves.toBe('replica-malformed');
    await expect(reasonFor({ kind: 'unknown-host', revision: undefined })).resolves.toBe(
      'replica-malformed',
    );
    await expect(reasonFor({ kind: 'unknown-host', schemaVersion: undefined })).resolves.toBe(
      'replica-malformed',
    );
  });

  it('refuses an array-shaped envelope even when it carries the committed property names', async () => {
    const lookup = Object.assign([] as unknown as Record<string, unknown>, {
      kind: 'committed',
      schemaVersion: 1,
      revision: '7',
      desired: {
        kind: 'route',
        eventId: 'bodega-bay-2026',
        status: 'active',
        slug: SLUG,
        edition: 'fiveacross',
        pathNamespace: null,
      },
    }) as unknown as RegistryLookup;
    await expect(refusalFor(lookup)).resolves.toEqual({ reason: 'replica-malformed', revision: null });
  });

  it('refuses an array-shaped projection even when it carries the route property names', async () => {
    // `typeof [] === 'object'`, and an array with `kind`, `eventId`, `status`,
    // `slug`, `edition` and `pathNamespace` set as properties has exactly the
    // route key set — so only an explicit array check keeps it out.
    const desired = Object.assign([] as unknown as Record<string, unknown>, {
      kind: 'route',
      eventId: 'bodega-bay-2026',
      status: 'active',
      slug: SLUG,
      edition: 'fiveacross',
      pathNamespace: null,
    }) as unknown as ReplicaDesired;
    await expect(refusalFor(committed(desired))).resolves.toEqual({
      reason: 'replica-malformed',
      revision: null,
    });
  });

  it('answers a tombstone as unknown rather than advertising that the address existed', async () => {
    await expect(reasonFor(committed({ kind: 'tombstone' }))).resolves.toBe('unknown-host');
  });

  it.each(['disabled', 'archived'] as const)('refuses a %s route as inactive', async (status) => {
    await expect(
      reasonFor(
        committed({
          kind: 'route',
          eventId: 'bodega-bay-2026',
          status,
          slug: SLUG,
          edition: 'fiveacross',
          pathNamespace: null,
        }),
      ),
    ).resolves.toBe('inactive');
  });

  it('reports a malformed committed state distinctly from an unreachable one', async () => {
    // The two demand opposite operator responses: a malformed replica alerts
    // and will not heal on a retry, an unavailable object usually does.
    await expect(reasonFor({ kind: 'malformed' })).resolves.toBe('replica-malformed');
  });

  it('refuses a route whose denormalised slug names a different first label', async () => {
    await expect(
      reasonFor(
        committed({
          kind: 'route',
          eventId: 'bodega-bay-2026',
          status: 'active',
          slug: 'somewhere-else',
          edition: 'fiveacross',
          pathNamespace: null,
        }),
      ),
    ).resolves.toBe('slug-mismatch');
  });

  it('refuses a route carrying no slug to cross-check against', async () => {
    await expect(
      reasonFor(
        committed({
          kind: 'route',
          eventId: 'bodega-bay-2026',
          status: 'active',
          slug: '' as string,
          edition: 'fiveacross',
          pathNamespace: null,
        }),
      ),
    ).resolves.toBe('slug-missing');
  });

  it('requires a slug on an APEX route too, where there is no first label to compare it with', async () => {
    // The apex exemption removes the COMPARISON, not the requirement. A route
    // that has lost its slug is half-written whatever host it was reached at,
    // and `expectedSlug === null` must not turn that into a serve.
    const { deps } = harness(
      committed(
        {
          kind: 'route',
          eventId: 'bodega-bay-2026',
          status: 'active',
          slug: '' as string,
          edition: 'fiveacross',
          pathNamespace: 'fiveacross.app',
        },
        '7',
        'fiveacross.app',
      ),
    );
    await expect(resolveHost('fiveacross.app', null, CONFIG, deps)).resolves.toEqual({
      kind: 'not-found',
      reason: 'slug-missing' satisfies NotFoundReason,
      revision: null,
    });
  });

  it.each(['admin', 'bad/slash', 'ab', '-edge', 'xn--80ak6aa92e'])(
    'refuses an APEX route whose slug (%s) is present but breaks the Slug contract',
    async (slug) => {
      // On the apex there is no first label to compare against, so the
      // contract itself is the only check left. Non-empty is not the same as
      // valid, and `parseDesired` applies the full contract to this host
      // class — the boundary revalidation has to as well or version skew
      // serves an apex from a projection naming a reserved infrastructure
      // label.
      const { deps } = harness(
        committed(
          {
            kind: 'route',
            eventId: 'bodega-bay-2026',
            status: 'active',
            slug,
            edition: 'fiveacross',
            pathNamespace: 'fiveacross.app',
          },
          '7',
          'fiveacross.app',
        ),
      );
      await expect(resolveHost('fiveacross.app', null, CONFIG, deps)).resolves.toEqual({
        kind: 'not-found',
        reason: 'replica-malformed' satisfies NotFoundReason,
        revision: null,
      });
    },
  );
});

describe('re-validating the projection at the service boundary', () => {
  // The binding crosses two separately deployed Workers, and one field of what
  // comes back is reflected into a response header, so what arrives is a
  // contract rather than a value this module wrote.
  it.each([
    ['a non-canonical revision', { ...ACTIVE_ROUTE, revision: '007' } as RegistryLookup],
    ['a zero revision', { ...ACTIVE_ROUTE, revision: '0' } as RegistryLookup],
    ['a non-numeric revision', { ...ACTIVE_ROUTE, revision: '3; drop' } as RegistryLookup],
    [
      'an unknown Edition',
      committed({
        kind: 'route',
        eventId: 'e',
        status: 'active',
        slug: SLUG,
        edition: 'bodega' as never,
        pathNamespace: null,
      }),
    ],
    [
      'an unknown path namespace',
      committed({
        kind: 'route',
        eventId: 'e',
        status: 'active',
        slug: SLUG,
        edition: 'fiveacross',
        pathNamespace: 'example.com' as never,
      }),
    ],
    [
      'an unrecognised status',
      committed({
        kind: 'route',
        eventId: 'e',
        status: 'live' as never,
        slug: SLUG,
        edition: 'fiveacross',
        pathNamespace: null,
      }),
    ],
    [
      'an empty eventId',
      committed({
        kind: 'route',
        eventId: '',
        status: 'active',
        slug: SLUG,
        edition: 'fiveacross',
        pathNamespace: null,
      }),
    ],
    [
      'an unrecognised root marker',
      committed({ kind: 'root', root: 'landing' as never, edition: 'fiveacross', pathNamespace: null }),
    ],
    ['an unrecognised desired kind', committed({ kind: 'redirect' } as never)],
    [
      'a null projection',
      {
        kind: 'committed',
        schemaVersion: 1,
        revision: '7',
        host: HOST,
        desired: null,
      } as unknown as RegistryLookup,
    ],
    ['a lookup arm this Worker does not know', { kind: 'quarantined' } as unknown as RegistryLookup],
    ['a null envelope', null as unknown as RegistryLookup],
    ['an undefined envelope', undefined as unknown as RegistryLookup],
    ['a non-object envelope', 'unknown-host' as unknown as RegistryLookup],
  ])('refuses %s as replica-malformed rather than coercing it', async (_label, lookup) => {
    await expect(reasonFor(lookup)).resolves.toBe('replica-malformed');
  });

  // Closed-set membership is not the whole rule: `fiveacross.app` is a valid
  // path namespace AND an invalid value for an Event subdomain, and a root
  // shape is valid on an apex and a defect on a wildcard address. A boundary
  // check that ignored the host would accept exactly the combinations that
  // publish a false path capability.
  it.each([
    [
      'a root shape returned for an ordinary Event subdomain',
      HOST,
      committed({ kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: null }),
    ],
    [
      'a non-null path namespace on an Event subdomain',
      HOST,
      committed({
        kind: 'route',
        eventId: 'e',
        status: 'active',
        slug: SLUG,
        edition: 'fiveacross',
        pathNamespace: 'fiveacross.app',
      }),
    ],
    [
      'the WRONG Namespace on the apex that has one',
      'fiveacross.app',
      committed(
        { kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: 'vacaybingo.com' },
        '7',
        'fiveacross.app',
      ),
    ],
    [
      'a null path namespace on the apex that requires one',
      'vacaybingo.com',
      committed(
        { kind: 'root', root: 'doorway', edition: 'vacay', pathNamespace: null },
        '7',
        'vacaybingo.com',
      ),
    ],
    [
      // A configured root origin brands itself, so a root marker whose Edition
      // disagrees with its host would render the wrong product's doorway on a
      // real brand domain.
      'a root marker whose Edition disagrees with its host class',
      'fiveacross.app',
      committed(
        { kind: 'root', root: 'doorway', edition: 'vacay', pathNamespace: 'fiveacross.app' },
        '7',
        'fiveacross.app',
      ),
    ],
    [
      'the mirrored Edition mismatch on the other apex',
      'vacaybingo.com',
      committed(
        { kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: 'vacaybingo.com' },
        '7',
        'vacaybingo.com',
      ),
    ],
    [
      'a non-null path namespace on the synthetic root-test class',
      'r2-root-abcdefghijklmnopqrst.fiveacross.app',
      committed(
        { kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: 'fiveacross.app' },
        '7',
        'r2-root-abcdefghijklmnopqrst.fiveacross.app',
      ),
    ],
    [
      // The class accepts no route on either side of the registry.
      // `parseDesired` refuses one at ingestion; this is the same rule applied
      // to a projection that reached the binding anyway, which is what a
      // separately deployed consumer revalidates for.
      'a ROUTE projection on the synthetic root-test class, whose slug matches its label',
      'r2-root-abcdefghijklmnopqrst.fiveacross.app',
      committed(
        {
          kind: 'route',
          eventId: 'e',
          status: 'active',
          slug: 'r2-root-abcdefghijklmnopqrst',
          edition: 'fiveacross',
          pathNamespace: null,
        },
        '7',
        'r2-root-abcdefghijklmnopqrst.fiveacross.app',
      ),
    ],
  ])('refuses %s', async (_label, host, lookup) => {
    const { deps } = harness(lookup);
    await expect(resolveHost(host, null, CONFIG, deps)).resolves.toEqual({
      kind: 'not-found',
      reason: 'replica-malformed' satisfies NotFoundReason,
      revision: null,
    });
  });

  it('classifies an absent envelope rather than throwing on its discriminant', () => {
    // A registry mid-rollout, or an entrypoint that returned nothing at all,
    // hands back `null`. Reading `.kind` off that throws, and the rejection
    // escapes `resolveHost` — which does not catch it, because `decide` runs
    // outside the bounded call — into an unversioned Cloudflare error page
    // instead of the rendered fail-closed response.
    expect(() => decide(HOST, null as unknown as RegistryLookup, SLUG)).not.toThrow();
    expect(decide(HOST, undefined as unknown as RegistryLookup, SLUG)).toEqual({
      kind: 'not-found',
      reason: 'replica-malformed' satisfies NotFoundReason,
      revision: null,
    });
  });

  it('refuses an unrecognised status BEFORE reading it as inactive', () => {
    // An unknown status is a projection this Worker cannot judge, not an
    // inferred disabled — and certainly not an inferred active.
    const resolution = decide(
      HOST,
      committed({
        kind: 'route',
        eventId: 'e',
        status: 'paused' as never,
        slug: SLUG,
        edition: 'fiveacross',
        pathNamespace: null,
      }),
      SLUG,
    );
    expect(resolution).toEqual({
      kind: 'not-found',
      reason: 'replica-malformed' satisfies NotFoundReason,
      revision: null,
    });
  });
});

describe('the exact key set the ENVELOPE itself may carry', () => {
  // One level up from the projection, and the same rule for the same reason. An
  // envelope carrying a field its arm does not define is a registry
  // contradicting itself — `{kind: 'unknown-host', …, desired}` says "nothing
  // here" and hands over a projection in the same breath — and an arm that
  // validated only the fields it happens to read would publish that revision as
  // canonical recovery evidence off a record this Worker never agreed with.
  it.each([
    [
      'a tombstone-shaped unknown-host that also carries a projection',
      {
        kind: 'unknown-host',
        revision: '12',
        schemaVersion: 1,
        host: HOST,
        desired: {
          kind: 'route',
          eventId: 'e',
          status: 'active',
          slug: SLUG,
          edition: 'fiveacross',
          pathNamespace: null,
        },
      },
    ],
    ['an unavailable arm carrying a revision', { kind: 'unavailable', revision: '12' }],
    [
      // `host` is a key the committed arms define, so an arm that has no
      // record to bind may not carry one either.
      'an unavailable arm carrying a canonical host',
      { kind: 'unavailable', host: HOST },
    ],
    ['a malformed arm carrying a projection', { kind: 'malformed', desired: { kind: 'tombstone' } }],
    [
      'a committed arm carrying a field the envelope does not define',
      {
        kind: 'committed',
        schemaVersion: 1,
        revision: '7',
        host: HOST,
        desired: { kind: 'tombstone' },
        digest: 'c0ffee',
      },
    ],
    ['an uninitialized unknown-host carrying a stray field', { kind: 'unknown-host', cached: true }],
  ])('refuses %s as replica-malformed', async (_label, lookup) => {
    await expect(refusalFor(lookup as unknown as RegistryLookup)).resolves.toEqual({
      reason: 'replica-malformed',
      revision: null,
    });
  });

  it.each([
    ['constructor'],
    ['toString'],
    ['__proto__'],
    ['hasOwnProperty'],
  ])('refuses `kind: %s` rather than reading the key set off Object.prototype', async (kind) => {
    // The envelope table is an ordinary object literal, so it inherits every
    // member of `Object.prototype`. Indexed with one of their names, an
    // `in`-style lookup returns an inherited member that is not an array of
    // key names, and `allowed.includes` throws on it — and the throw does not
    // stay inside the module: `decide` runs OUTSIDE `resolveHost`'s catch,
    // which brackets the bounded service call only, so a registry answering
    // with one of these strings would hand the request to Cloudflare as an
    // unversioned error page instead of the fail-closed refusal this table
    // promises for every arm it does not recognise (Codex P2 on #1120).
    await expect(refusalFor({ kind } as unknown as RegistryLookup)).resolves.toEqual({
      reason: 'replica-malformed',
      revision: null,
    });
  });

  it('refuses a non-string discriminant for the same reason', async () => {
    // Not a discriminant this envelope defines, and indexing the table with it
    // would coerce it to a string that might name an inherited member.
    for (const kind of [0, null, undefined, { toString: () => 'committed' }]) {
      await expect(refusalFor({ kind } as unknown as RegistryLookup)).resolves.toEqual({
        reason: 'replica-malformed',
        revision: null,
      });
    }
  });

  it('still accepts every arm written exactly, including the optional pair', async () => {
    // The `unknown-host` arm's two fields are OPTIONAL, so the rule is the keys
    // ALLOWED rather than the keys required — a bare `{kind}` and a full
    // tombstone envelope are both exact.
    await expect(refusalFor({ kind: 'unknown-host' })).resolves.toEqual({
      reason: 'unknown-host',
      revision: null,
    });
    await expect(
      refusalFor({ kind: 'unknown-host', schemaVersion: 1, revision: '12', host: HOST }),
    ).resolves.toEqual({
      reason: 'unknown-host',
      revision: '12',
    });
    await expect(refusalFor({ kind: 'unavailable' })).resolves.toEqual({
      reason: 'lookup-unavailable',
      revision: null,
    });
    const { deps } = harness(ACTIVE_ROUTE);
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toMatchObject({ kind: 'serve' });
  });
});

describe('the exact key set a `desired` arm may carry', () => {
  // The registry refuses every one of these on the way IN (`parseDesired`
  // compares the key set, not just the values), so a committed projection
  // carrying an undefined field is a defect however it got there — and this
  // boundary exists for defects the registry did not catch. It is not tidiness:
  // these arms publish a revision, and § Audit and recovery makes the public
  // `{reason, revision}` pair the evidence `clear-lock` compares against
  // committed state, so accepting a shape the registry itself would have
  // rejected would offer it to the recovery machine as canonical.
  it.each([
    // The example that motivates the rule: a tombstone whose extra field is a
    // route field. Read arm-first it is a perfectly ordinary tombstone, and it
    // would publish `unknown-host` with its revision.
    ['a tombstone carrying an eventId', HOST, SLUG, { kind: 'tombstone', eventId: 'event-1' }],
    ['a tombstone carrying a slug', HOST, SLUG, { kind: 'tombstone', slug: SLUG }],
    [
      'a route carrying a field this schema does not define',
      HOST,
      SLUG,
      {
        kind: 'route',
        eventId: 'bodega-bay-2026',
        status: 'active',
        slug: SLUG,
        edition: 'fiveacross',
        pathNamespace: null,
        adultContent: true,
      },
    ],
    [
      'a route missing one of its own',
      HOST,
      SLUG,
      { kind: 'route', eventId: 'bodega-bay-2026', status: 'active', slug: SLUG, edition: 'fiveacross' },
    ],
    [
      'a root carrying a slug it has no first label for',
      'fiveacross.app',
      null,
      {
        kind: 'root',
        root: 'doorway',
        edition: 'fiveacross',
        pathNamespace: 'fiveacross.app',
        slug: 'bodega-bay',
      },
    ],
  ] as const)('refuses %s', async (_label, host, expectedSlug, desired) => {
    const { deps } = harness({
      kind: 'committed',
      schemaVersion: 1,
      revision: '7',
      host,
      desired: desired as unknown as ReplicaDesired,
    });
    const resolution = await resolveHost(host, expectedSlug, CONFIG, deps);
    // Fail closed, with no revision — this is the router answering ABOUT a
    // record it cannot use, not FROM one it read for the address.
    expect(resolution).toEqual({ kind: 'not-found', reason: 'replica-malformed', revision: null });
  });

  it.each([['constructor'], ['toString'], ['__proto__'], ['hasOwnProperty']])(
    'refuses a desired `kind: %s` rather than reading its key set off Object.prototype',
    async (kind) => {
      // `DESIRED_KEYS` is the same shape of object literal as the envelope
      // table one level up, and inherits `Object.prototype` the same way. The
      // consequence here is quieter than the envelope's — `hasExactKeys`
      // reads `.length` and numeric indices rather than calling a method, so
      // an inherited member makes it decide a projection's key set from
      // `Object.prototype` instead of throwing — and the answer it happens to
      // reach today is already `replica-malformed`. These cases therefore PIN
      // that answer rather than reproduce a crash: the own-property lookup is
      // what makes it the answer by rule instead of by arithmetic accident
      // (Codex P2 on #1120).
      const { deps } = harness({
        kind: 'committed',
        schemaVersion: 1,
        revision: '7',
        host: HOST,
        desired: { kind } as unknown as ReplicaDesired,
      });
      await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toEqual({
        kind: 'not-found',
        reason: 'replica-malformed',
        revision: null,
      });
    },
  );

  it('still serves the exact shapes, so the rule is a key set and not a refusal of everything', async () => {
    const { deps } = harness(ACTIVE_ROUTE);
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toMatchObject({ kind: 'serve' });

    const root = harness(
      committed(
        {
          kind: 'root',
          root: 'doorway',
          edition: 'fiveacross',
          pathNamespace: 'fiveacross.app',
        },
        '7',
        'fiveacross.app',
      ),
    );
    await expect(resolveHost('fiveacross.app', null, CONFIG, root.deps)).resolves.toMatchObject({
      kind: 'serve',
    });

    await expect(refusalFor(committed({ kind: 'tombstone' }, '12'))).resolves.toEqual({
      reason: 'unknown-host',
      revision: '12',
    });
  });
});

describe('the projection schema version, refused before the projection is read', () => {
  // The registry is a SEPARATELY DEPLOYED Worker, so its schema can move ahead
  // of this router's. `desired` is a closed union whose discriminants an
  // additive v2 would keep, so a projection written under a schema this build
  // has never seen arrives looking exactly like a v1 route — and would be
  // served under v1 rules — unless the version itself is carried and checked.
  // `specs/event-router-registry.md` § Failure semantics gives that state the
  // same closed answer as malformed state: rendered not-found,
  // `replica-malformed`, alert, and no second source of truth.
  const ROUTE: ReplicaDesired = {
    kind: 'route',
    eventId: 'bodega-bay-2026',
    status: 'active',
    slug: SLUG,
    edition: 'fiveacross',
    pathNamespace: null,
  };

  it('serves a version this build understands, exactly as before', async () => {
    const { deps } = harness({
      kind: 'committed',
      schemaVersion: 1,
      revision: '7',
      host: HOST,
      desired: ROUTE,
    });
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toEqual({
      kind: 'serve',
      record: {
        eventId: 'bodega-bay-2026',
        revision: '7',
        pathNamespace: null,
        edition: 'fiveacross',
        root: null,
      },
    });
  });

  it.each([
    ['a version this build does not know', 2],
    ['a version below the supported one', 0],
    ['a non-integer version', 1.5],
    ['a version encoded as a string', '1'],
    ['a null version', null],
    ['no version at all', undefined],
  ])('refuses %s on an ACTIVE route rather than serving it', async (_label, schemaVersion) => {
    const lookup = { kind: 'committed', revision: '7', host: HOST, desired: ROUTE } as Record<
      string,
      unknown
    >;
    if (schemaVersion !== undefined) lookup.schemaVersion = schemaVersion;
    await expect(refusalFor(lookup as unknown as RegistryLookup)).resolves.toEqual({
      reason: 'replica-malformed',
      revision: null,
    });
  });

  it('refuses an unsupported version before it reads `desired` at all', async () => {
    // The ordering is the fix, not a detail. A projection whose `desired` is
    // outright nonsense and a projection that is a perfectly well-formed v2
    // route must produce the SAME answer, because the router cannot judge
    // either under rules it does not have. If the shape checks ran first, the
    // well-formed v2 route would pass every one of them and be served.
    for (const desired of [ROUTE, { kind: 'route', eventId: 42 } as unknown as ReplicaDesired]) {
      await expect(
        refusalFor({ kind: 'committed', schemaVersion: 2, revision: '7', host: HOST, desired }),
      ).resolves.toEqual({ reason: 'replica-malformed', revision: null });
    }
  });

  it('refuses an unsupported version on a root marker, which serves without a Slug check', async () => {
    // A root marker has no Slug to cross-check, so the version gate is the only
    // thing standing between an unreadable v2 record and a served doorway.
    await expect(
      refusalFor(
        {
          kind: 'committed',
          schemaVersion: 2,
          revision: '7',
          host: HOST,
          desired: { kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: 'fiveacross.app' },
        },
        null,
      ),
    ).resolves.toEqual({ reason: 'replica-malformed', revision: null });
  });

  it('refuses an unsupported version on the tombstone arm rather than publishing its revision', async () => {
    // A tombstone reads as `unknown-host` WITH the revision it was deleted at,
    // and that revision is evidence: § Audit and recovery has `clear-lock`
    // compare three public `{reason, revision}` observations against committed
    // state. Quoting one out of a record written under a schema this build
    // cannot read would attribute a revision the router never actually
    // understood, so the version gates that arm too.
    for (const lookup of [
      { kind: 'unknown-host', schemaVersion: 2, revision: '12', host: HOST },
      { kind: 'unknown-host', revision: '12', host: HOST },
    ] as RegistryLookup[]) {
      await expect(refusalFor(lookup)).resolves.toEqual({
        reason: 'replica-malformed',
        revision: null,
      });
    }
  });

  it('still answers a versionless UNINITIALIZED object as a plain unknown address', async () => {
    // No committed record means no version to stamp and none to check. This is
    // the ordinary unknown-address case and must not be dragged into
    // `replica-malformed` by the gate above.
    await expect(refusalFor({ kind: 'unknown-host' })).resolves.toEqual({
      reason: 'unknown-host',
      revision: null,
    });
  });

  it.each([
    ['a supported version with no revision', { kind: 'unknown-host', schemaVersion: 1, host: HOST }],
    ['an unsupported version with no revision', { kind: 'unknown-host', schemaVersion: 2, host: HOST }],
    ['a revision with no version', { kind: 'unknown-host', revision: '12', host: HOST }],
    ['a canonical host with neither', { kind: 'unknown-host', host: HOST }],
    ['a version and revision with no canonical host', { kind: 'unknown-host', schemaVersion: 1, revision: '12' }],
  ] as RegistryLookup[][])(
    'refuses %s, because the three are stamped from one record and travel together',
    async (_label, lookup) => {
      // Only ALL-absent is the ordinary unknown address. Any one of them alone
      // is a half-written envelope — something committed existed to stamp it —
      // and reading "no record here" off it would infer an absence from a
      // defect. An unsupported-version tombstone that lost its revision has
      // to raise the alert, not pass as an unknown host; and a registry too
      // old to stamp the canonical host cannot have its tombstone revision
      // accepted unbound (#1133).
      await expect(refusalFor(lookup)).resolves.toEqual({
        reason: 'replica-malformed',
        revision: null,
      });
    },
  );
});

describe('the canonical host every committed-derived envelope is bound to', () => {
  // #1133, deferred from #1120. The registry and the router are separately
  // deployed Workers, so what comes back is a contract this module did not
  // write — and until the envelope carried the hostname the record was
  // projected FROM, the only thing tying a committed record to the address it
  // was fetched for was the denormalised `slug`, which is the host's FIRST
  // LABEL. `bodega-bay.fiveacross.app` and `bodega-bay.vacaybingo.com` share
  // theirs. A registry that answered a lookup of one with the other's
  // projection therefore passed every check the router had, and the router
  // served the sibling's status and Edition, or published its revision as this
  // address's recovery evidence.
  const SIBLING = 'bodega-bay.vacaybingo.com';
  const route = (status: 'active' | 'disabled' | 'archived'): ReplicaDesired => ({
    kind: 'route',
    eventId: 'bodega-bay-2026',
    status,
    slug: SLUG,
    edition: 'fiveacross',
    pathNamespace: null,
  });

  it.each([
    // Each of these would have produced a DIFFERENT outcome had the binding
    // not been checked: a serve, an `inactive` carrying revision 12, and an
    // `unknown-host` carrying revision 12. All three are the sibling Namespace
    // answering for an address it does not own.
    ['an active route that would otherwise have served', committed(route('active'), '12', SIBLING)],
    ['a disabled route that would otherwise have published its revision', committed(route('disabled'), '12', SIBLING)],
    ['an archived route', committed(route('archived'), '12', SIBLING)],
    ['a committed tombstone', committed({ kind: 'tombstone' }, '12', SIBLING)],
    [
      'the tombstone-shaped unknown-host arm',
      { kind: 'unknown-host', schemaVersion: 1, revision: '12', host: SIBLING } as RegistryLookup,
    ],
  ])('refuses %s as a malformed replica, with no revision', async (_label, lookup) => {
    await expect(refusalFor(lookup)).resolves.toEqual({
      reason: 'replica-malformed',
      revision: null,
    });
  });

  it('reports the sibling-host envelope through the diagnostic seam', async () => {
    // § Failure semantics pages on `replica-malformed`, and a registry
    // answering for the wrong address is exactly the standing data fact that
    // row exists for: it will not heal on a retry and it takes one host down.
    const events: unknown[] = [];
    const { deps } = harness(committed(route('active'), '12', SIBLING));
    await resolveHost(HOST, SLUG, CONFIG, {
      ...deps,
      diagnostics: (event) => events.push(event),
    });
    expect(events).toEqual([
      { event: 'event-router.diagnostic', outcome: 'replica-malformed', host: HOST },
    ]);
  });

  it.each([
    ['a difference of case', 'Bodega-Bay.fiveacross.app'],
    ['a trailing root dot', 'bodega-bay.fiveacross.app.'],
    ['a longer name that merely ends with this one', 'www.bodega-bay.fiveacross.app'],
    ['a name this one merely ends with', 'fiveacross.app'],
  ])('compares byte for byte and refuses %s', async (_label, host) => {
    // Both sides are already canonical — the registry stores `hostnameKey`
    // and its entrypoint refuses a raw host that is not its own
    // normalisation — so anything this comparison would have had to normalise
    // is a defect on one side. Normalising it here would be the router
    // quietly repairing a projection it cannot vouch for, and the trailing
    // dot in particular names a DISTINCT browser origin that the guard
    // already refuses before any lookup.
    await expect(refusalFor(committed(route('active'), '12', host))).resolves.toEqual({
      reason: 'replica-malformed',
      revision: null,
    });
  });

  it.each([
    [
      'a committed projection from a registry too old to stamp one',
      { kind: 'committed', schemaVersion: 1, revision: '12', desired: route('active') },
    ],
    [
      'a tombstone-shaped unknown-host from the same registry',
      { kind: 'unknown-host', schemaVersion: 1, revision: '12' },
    ],
    ['a committed projection naming the field as undefined', { kind: 'committed', schemaVersion: 1, revision: '12', host: undefined, desired: route('active') }],
  ])('fails closed on %s rather than reading it unbound', async (_label, lookup) => {
    // The field is REQUIRED on every committed-derived arm, which is what
    // makes an older registry fail closed instead of having its projection
    // read under the pre-#1133 rules. A projection whose binding cannot be
    // checked is exactly as unusable as one whose binding is wrong.
    await expect(refusalFor(lookup as unknown as RegistryLookup)).resolves.toEqual({
      reason: 'replica-malformed',
      revision: null,
    });
  });

  it('refuses the binding BEFORE it interprets status, Edition or revision', () => {
    // The ordering is the property, not a detail. A sibling-host envelope
    // whose projection is otherwise perfect must produce the SAME answer as
    // one whose projection is nonsense — including on the two arms that
    // publish a revision, because a revision quoted off another host's record
    // would reach `x-event-router-revision` and, through the
    // `canonical-after-unblock` probe, the evidence `clear-lock` compares
    // against committed state.
    for (const lookup of [
      committed(route('disabled'), '12', SIBLING),
      committed({ kind: 'tombstone' }, '12', SIBLING),
      committed({ kind: 'route', eventId: 42 } as unknown as ReplicaDesired, '12', SIBLING),
      { kind: 'committed', schemaVersion: 2, revision: '12', host: SIBLING, desired: route('active') },
    ] as RegistryLookup[]) {
      expect(decide(HOST, lookup, SLUG)).toEqual({
        kind: 'not-found',
        reason: 'replica-malformed' satisfies NotFoundReason,
        revision: null,
      });
    }
  });

  it('still serves, and still publishes a revision, when the binding is exact', async () => {
    // The positive control: the rule is an equality check, not a refusal of
    // everything that now carries a hostname.
    const { deps } = harness(committed(route('active'), '12'));
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toMatchObject({
      kind: 'serve',
      record: { eventId: 'bodega-bay-2026', revision: '12' },
    });
    await expect(refusalFor(committed(route('disabled'), '12'))).resolves.toEqual({
      reason: 'inactive',
      revision: '12',
    });
    await expect(
      refusalFor({ kind: 'unknown-host', schemaVersion: 1, revision: '12', host: HOST }),
    ).resolves.toEqual({ reason: 'unknown-host', revision: '12' });
  });

  it('still answers an uninitialized object, which was projected from nothing', async () => {
    // The ordinary unknown address names no host because it has no committed
    // record to have been projected from — so the requirement is on
    // committed-derived arms, not on the envelope as such.
    await expect(refusalFor({ kind: 'unknown-host' })).resolves.toEqual({
      reason: 'unknown-host',
      revision: null,
    });
  });
});

describe('a lookup that cannot be completed', () => {
  it('fails closed when the registry binding is absent', async () => {
    const deps: ResolveDeps = { registry: null };
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toEqual({
      kind: 'not-found',
      reason: 'lookup-unavailable',
      revision: null,
    });
  });

  it('fails closed when the object reports itself unavailable', async () => {
    await expect(reasonFor({ kind: 'unavailable' })).resolves.toBe('lookup-unavailable');
  });

  it('fails closed when the service call rejects, rather than letting the rejection escape', async () => {
    const { deps } = harness(async () => {
      throw new Error('registry binding is not bound to a running service');
    });
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toEqual({
      kind: 'not-found',
      reason: 'lookup-unavailable',
      revision: null,
    });
  });

  it('bounds a hung lookup at the configured timeout instead of waiting for it', async () => {
    vi.useFakeTimers();
    // Never settles. Unbounded, this request would sit behind a stalled
    // dependency for as long as the platform allowed.
    const { deps } = harness(() => new Promise<never>(() => {}));

    const pending = resolveHost(HOST, SLUG, { lookupTimeoutMs: 2_000 }, deps);
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      kind: 'not-found',
      reason: 'lookup-unavailable',
      revision: null,
    });
  });

  it('clears the timer once a lookup answers, so a fast call leaves nothing pending', async () => {
    vi.useFakeTimers();
    const { deps } = harness(ACTIVE_ROUTE);
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toMatchObject({ kind: 'serve' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds no negative, stale or second-source fallback behind the failure', async () => {
    // The whole point of the removal: two answers to "is this address in
    // service?" that can disagree is worse than one answer that fails closed.
    const { deps, lookup } = harness({ kind: 'unavailable' });
    await resolveHost(HOST, SLUG, CONFIG, deps);
    await resolveHost(HOST, SLUG, CONFIG, deps);
    // Nothing was remembered between the two, so the second request asked
    // again rather than serving a cached refusal or a cached positive.
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(Object.keys(deps)).toEqual(['registry']);
  });
});

describe('the revision a refusal was decided from', () => {
  // `specs/event-router-registry.md` § Failure semantics and § Audit and
  // recovery make this pair, not the reason alone, the public contract: a
  // `canonical-after-unblock` probe observes `{reason, revision}` together for
  // `null`, `inactive` AND `unknown-host`, and `clear-lock` consumes three
  // attestations whose revision equals committed state. A refusal that dropped
  // the revision on the two states a recovery most often ends in would leave
  // those hosts unable to clear a lock, and therefore unable to accept another
  // publisher update, for as long as the state persisted.
  it.each(['disabled', 'archived'] as const)(
    'carries the committed revision on a %s route, because recovery has to observe it',
    async (status) => {
      await expect(
        refusalFor(
          committed(
            {
              kind: 'route',
              eventId: 'bodega-bay-2026',
              status,
              slug: SLUG,
              edition: 'fiveacross',
              pathNamespace: null,
            },
            '12',
          ),
        ),
      ).resolves.toEqual({ reason: 'inactive', revision: '12' });
    },
  );

  it('carries the committed revision on a tombstone, while still reading as unknown', async () => {
    // The object reports a tombstone through its `unknown-host` arm, keeping
    // the revision and dropping the projection. The address stays
    // indistinguishable from an unknown one in its REASON; what it does not
    // hide is a revision the threat model already calls public metadata.
    await expect(
      refusalFor({ kind: 'unknown-host', schemaVersion: 1, revision: '12', host: HOST }),
    ).resolves.toEqual({
      reason: 'unknown-host',
      revision: '12',
    });
  });

  it('carries it on a committed tombstone too, so the boundary agrees with the object', async () => {
    // Defense in depth for version skew: a registry that handed back the
    // committed tombstone instead of collapsing it must produce the identical
    // public answer, reason and revision alike.
    await expect(refusalFor(committed({ kind: 'tombstone' }, '12'))).resolves.toEqual({
      reason: 'unknown-host',
      revision: '12',
    });
  });

  it('carries NO revision for an uninitialized object, which has none', async () => {
    await expect(refusalFor({ kind: 'unknown-host' })).resolves.toEqual({
      reason: 'unknown-host',
      revision: null,
    });
  });

  it('refuses a non-canonical revision on the unknown-host arm as malformed', async () => {
    // The shape rule belongs to the projection rather than to the arm: a
    // revision that reaches this module is canonical or the state is
    // malformed, and a tombstone is not exempt from it.
    await expect(
      refusalFor({ kind: 'unknown-host', schemaVersion: 1, revision: '007', host: HOST }),
    ).resolves.toEqual({
      reason: 'replica-malformed',
      revision: null,
    });
  });

  it.each([
    [
      'a slug-mismatched route, whose record is not this address’s to quote',
      committed(
        {
          kind: 'route',
          eventId: 'bodega-bay-2026',
          status: 'active',
          slug: 'somewhere-else',
          edition: 'fiveacross',
          pathNamespace: null,
        },
        '12',
      ),
      'slug-mismatch',
    ],
    [
      'a slug-less route',
      committed(
        {
          kind: 'route',
          eventId: 'bodega-bay-2026',
          status: 'active',
          slug: '' as string,
          edition: 'fiveacross',
          pathNamespace: null,
        },
        '12',
      ),
      'slug-missing',
    ],
    ['a malformed committed state', { kind: 'malformed' } as RegistryLookup, 'replica-malformed'],
    ['an unavailable object', { kind: 'unavailable' } as RegistryLookup, 'lookup-unavailable'],
  ] as const)('carries NO revision for %s', async (_label, lookup, reason) => {
    // None of these is a state the recovery contract models, and in each the
    // router is answering ABOUT a record it cannot use rather than FROM one it
    // read for this address. Stamping a revision would claim the edge is
    // serving from a projection it has just declared inadmissible.
    await expect(refusalFor(lookup)).resolves.toEqual({ reason, revision: null });
  });

  it.each([
    [
      'a disabled route whose slug names a different address',
      'somewhere-else',
      'slug-mismatch' as const,
    ],
    ['a disabled route carrying no slug at all', '', 'slug-missing' as const],
  ])('judges %s by its shape before its state, and quotes no revision', async (_label, slug, reason) => {
    // The ordering is load-bearing now that `inactive` publishes a revision. A
    // half-written route, or one belonging to another host, is not a record
    // THIS address may quote: answering `inactive` with its revision would
    // contradict the slug rules above and hand the recovery machine a
    // cross-host projection as this host's canonical evidence.
    await expect(
      refusalFor(
        committed(
          {
            kind: 'route',
            eventId: 'bodega-bay-2026',
            status: 'disabled',
            slug,
            edition: 'fiveacross',
            pathNamespace: null,
          },
          '12',
        ),
      ),
    ).resolves.toEqual({ reason, revision: null });
  });

  it('judges a disabled route with no eventId as malformed rather than inactive', async () => {
    // Same rule as the unrecognised-`status` arm: the projection violates its
    // own schema, so its state is not the router's to report and its revision
    // is not the router's to publish.
    await expect(
      refusalFor(
        committed(
          {
            kind: 'route',
            eventId: '',
            status: 'archived',
            slug: SLUG,
            edition: 'fiveacross',
            pathNamespace: null,
          },
          '12',
        ),
      ),
    ).resolves.toEqual({ reason: 'replica-malformed', revision: null });
  });

  it('carries NO revision when the binding is absent', async () => {
    const deps: ResolveDeps = { registry: null };
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toEqual({
      kind: 'not-found',
      reason: 'lookup-unavailable',
      revision: null,
    });
  });
});
