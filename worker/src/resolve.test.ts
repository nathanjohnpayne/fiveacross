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

function committed(desired: ReplicaDesired, revision = '7'): RegistryLookup {
  return { kind: 'committed', revision, desired };
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

async function reasonFor(lookup: RegistryLookup, expectedSlug: string | null = SLUG): Promise<string> {
  const { deps } = harness(lookup);
  const resolution = await resolveHost(HOST, expectedSlug, CONFIG, deps);
  expect(resolution.kind).toBe('not-found');
  return resolution.kind === 'not-found' ? resolution.reason : '';
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
      committed({
        kind: 'route',
        eventId: 'bodega-bay-2026',
        status: 'active',
        // The apex document's slug names the Event's WILDCARD address, not this
        // one, so cross-checking it here would refuse a host that is correct.
        slug: 'bodega-bay',
        edition: 'fiveacross',
        pathNamespace: null,
      }),
    );
    await expect(resolveHost('fiveacross.app', null, CONFIG, deps)).resolves.toMatchObject({ kind: 'serve' });
  });

  it.each(['doorway', 'not-found'] as const)(
    'serves a %s root marker: the marker controls the app’s / outcome, not whether the edge may serve',
    async (root) => {
      const { deps } = harness(
        committed({ kind: 'root', root, edition: 'fiveacross', pathNamespace: 'fiveacross.app' }),
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
      committed({ kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: null }),
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
});

describe('the fail-closed decision table', () => {
  it('answers an uninitialized object as an unknown address', async () => {
    await expect(reasonFor({ kind: 'unknown-host' })).resolves.toBe('unknown-host');
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
    ['a null projection', { kind: 'committed', revision: '7', desired: null } as unknown as RegistryLookup],
    ['a lookup arm this Worker does not know', { kind: 'quarantined' } as unknown as RegistryLookup],
    ['a null envelope', null as unknown as RegistryLookup],
    ['an undefined envelope', undefined as unknown as RegistryLookup],
    ['a non-object envelope', 'unknown-host' as unknown as RegistryLookup],
  ])('refuses %s as replica-malformed rather than coercing it', async (_label, lookup) => {
    await expect(reasonFor(lookup)).resolves.toBe('replica-malformed');
  });

  it('classifies an absent envelope rather than throwing on its discriminant', () => {
    // A registry mid-rollout, or an entrypoint that returned nothing at all,
    // hands back `null`. Reading `.kind` off that throws, and the rejection
    // escapes `resolveHost` — which does not catch it, because `decide` runs
    // outside the bounded call — into an unversioned Cloudflare error page
    // instead of the rendered fail-closed response.
    expect(() => decide(null as unknown as RegistryLookup, SLUG)).not.toThrow();
    expect(decide(undefined as unknown as RegistryLookup, SLUG)).toEqual({
      kind: 'not-found',
      reason: 'replica-malformed' satisfies NotFoundReason,
    });
  });

  it('refuses an unrecognised status BEFORE reading it as inactive', () => {
    // An unknown status is a projection this Worker cannot judge, not an
    // inferred disabled — and certainly not an inferred active.
    const resolution = decide(
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
    expect(resolution).toEqual({ kind: 'not-found', reason: 'replica-malformed' satisfies NotFoundReason });
  });
});

describe('a lookup that cannot be completed', () => {
  it('fails closed when the registry binding is absent', async () => {
    const deps: ResolveDeps = { registry: null };
    await expect(resolveHost(HOST, SLUG, CONFIG, deps)).resolves.toEqual({
      kind: 'not-found',
      reason: 'lookup-unavailable',
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
    await expect(pending).resolves.toEqual({ kind: 'not-found', reason: 'lookup-unavailable' });
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
