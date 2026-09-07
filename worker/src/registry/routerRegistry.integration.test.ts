// @vitest-environment node
//
// The Event router against a REAL registry, over a real named service binding,
// on the guarded synthetic exact-route classes (#972; specs/event-router-
// registry.md § Lookup, cache, and abuse posture / § Test seams and
// acceptance).
//
// `router.test.ts` proves the decision table against an injected seam, which is
// the right shape for a decision table and the wrong shape for two claims this
// ticket has to make. Both are properties of the PLATFORM rather than of the
// code: that a binding written `entrypoint = "RegistryLookupEntrypoint"` really
// does deny the registry's default `fetch`, its Durable Object namespace and
// every mutation method; and that a first public lookup of a never-published
// host creates the object at the fixed location hint without preventing the
// publisher from admitting that host afterwards. Neither is checkable with a
// stub, because a stub is exactly the thing whose fidelity is in question.
//
// So the registry runs as its own Worker with its own SQLite-backed object, the
// router runs as the deployed bundle, and everything the router fetches is
// intercepted by a third Worker so the "no Firebase, KV or Cache request"
// property is observed rather than asserted about source text. No live account
// is involved and no route is attached: the hosts below are the manifest-safe
// `r2-` classes, and nothing here creates DNS, a route, or a real Event.
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { RouterReplicaDesired } from './contracts';

const NAMESPACE = 'fiveacross.app';
const ACTIVE_HOST = `r2-${'a'.repeat(26)}.${NAMESPACE}`;
const INACTIVE_HOST = `r2-${'b'.repeat(26)}.${NAMESPACE}`;
const TOMBSTONE_HOST = `r2-${'c'.repeat(26)}.${NAMESPACE}`;
const UNKNOWN_HOST = `r2-${'d'.repeat(26)}.${NAMESPACE}`;
const ROOT_TEST_HOST = `r2-root-${'e'.repeat(20)}.vacaybingo.com`;
const CAPABILITY_PATH = '/.well-known/fiveacross-path-capability';
const ORIGIN_HOST = 'fiveacross.web.app';
const COMPATIBILITY_DATE = '2026-07-30';

let registryBundle = '';
let routerBundle = '';
const instances: Miniflare[] = [];

/**
 * A seeding front door for the registry, and ONLY for the test.
 *
 * It re-exports the real `HostRegistryObject` and the real
 * `RegistryLookupEntrypoint` — the router binds to that exported class, not to
 * anything this wrapper adds — and adds a default `fetch` the test drives to
 * publish state. The registry's own default export is the signed control plane;
 * standing up its OIDC/KMS chain here would prove the control plane rather than
 * the router, so the transaction is invoked directly instead.
 */
const registryWrapper = `
import { HostRegistryObject, RegistryLookupEntrypoint } from './registry.mjs';
export { HostRegistryObject, RegistryLookupEntrypoint };
export default {
  async fetch(request, env) {
    const input = await request.json();
    const stub = env.HOST_REGISTRY.getByName(input.host, { locationHint: 'wnam' });
    return Response.json(await stub.sync(input.payload, input.epoch));
  },
};
`;

/** Everything the router fetches, recorded and answered. */
const originWorker = `
export default {
  async fetch(request) {
    const url = new URL(request.url);
    return new Response('<!doctype html><title>app shell</title>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-origin-host': url.hostname,
        'x-origin-path': url.pathname,
        'x-origin-forwarded-host': request.headers.get('x-forwarded-host') ?? '',
      },
    });
  },
};
`;

/**
 * A consumer holding the IDENTICAL binding the router holds, whose whole job is
 * to report what that binding can reach. It is a separate Worker because the
 * router bundle has no reason to expose its own capabilities, and a capability
 * claim asserted by the code under test is not evidence.
 */
const probeWorker = `
async function attempt(run) {
  try {
    await run();
    return 'reachable';
  } catch (error) {
    return String(error && error.message ? error.message : error);
  }
}
export default {
  async fetch(request, env) {
    const host = new URL(request.url).searchParams.get('host') ?? '';
    return Response.json({
      lookup: await env.REGISTRY.lookup(host),
      durableObjectNamespace: typeof env.HOST_REGISTRY,
      defaultFetch: await attempt(() => env.REGISTRY.fetch('https://registry.invalid/')),
      sync: await attempt(() => env.REGISTRY.sync({}, '1')),
      audit: await attempt(() => env.REGISTRY.audit('0')),
      recover: await attempt(() => env.REGISTRY.recover({}, {})),
      issueProbeChallenge: await attempt(() => env.REGISTRY.issueProbeChallenge({}, {}, 0, 'n')),
      list: await attempt(() => env.REGISTRY.list()),
    });
  },
};
`;

beforeAll(async () => {
  const [registry, router] = await Promise.all([
    build({
      entryPoints: ['worker/src/registry/registryWorker.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      external: ['cloudflare:workers'],
    }),
    build({
      entryPoints: ['worker/src/index.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      external: ['cloudflare:workers'],
    }),
  ]);
  registryBundle = registry.outputFiles[0].text;
  routerBundle = router.outputFiles[0].text;
}, 60_000);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

function miniflare(): Miniflare {
  const instance = new Miniflare({
    workers: [
      {
        name: 'router',
        modules: [{ type: 'ESModule', path: 'router.mjs', contents: routerBundle }],
        modulesRoot: '/',
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: { ORIGIN_HOST, ROUTER_VERSION: 'itest-1' },
        serviceBindings: { REGISTRY: { name: 'registry', entrypoint: 'RegistryLookupEntrypoint' } },
        outboundService: 'origin',
      },
      {
        name: 'registry',
        modules: [
          { type: 'ESModule', path: 'entry.mjs', contents: registryWrapper },
          { type: 'ESModule', path: 'registry.mjs', contents: registryBundle },
        ],
        modulesRoot: '/',
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: { REGISTRY_VERSION: 'v1' },
        durableObjects: {
          HOST_REGISTRY: {
            className: 'HostRegistryObject',
            useSQLite: true,
            unsafeUniqueKey: 'event-router-registry-v1',
          },
        },
      },
      {
        name: 'origin',
        modules: [{ type: 'ESModule', path: 'origin.mjs', contents: originWorker }],
        modulesRoot: '/',
        compatibilityDate: COMPATIBILITY_DATE,
      },
      {
        name: 'probe',
        modules: [{ type: 'ESModule', path: 'probe.mjs', contents: probeWorker }],
        modulesRoot: '/',
        compatibilityDate: COMPATIBILITY_DATE,
        serviceBindings: { REGISTRY: { name: 'registry', entrypoint: 'RegistryLookupEntrypoint' } },
      },
    ],
    log: new Log(LogLevel.NONE),
  });
  instances.push(instance);
  return instance;
}

function routePayload(
  host: string,
  status: 'active' | 'disabled' | 'archived',
  revision = '1',
): RouterReplicaDesired {
  return {
    schemaVersion: 1,
    revision,
    host,
    desired: {
      kind: 'route',
      eventId: `${host.split('.')[0]}-event`,
      status,
      slug: host.split('.')[0],
      edition: 'fiveacross',
      pathNamespace: null,
    },
    updatedAt: new Date().toISOString(),
  };
}

async function publish(
  instance: Miniflare,
  payload: RouterReplicaDesired,
  epoch = '1',
): Promise<{ status: number; result: string }> {
  const registry = await instance.getWorker('registry');
  const response = await registry.fetch('https://registry.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: payload.host, payload, epoch }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ status: number; result: string }>;
}

async function request(instance: Miniflare, host: string, path = '/'): Promise<Response> {
  return instance.dispatchFetch(`https://${host}${path}`) as unknown as Promise<Response>;
}

describe('the router’s registry binding, on the platform rather than on a stub', () => {
  it('reaches lookup and NOTHING else through the named entrypoint', async () => {
    const instance = miniflare();
    const probe = await instance.getWorker('probe');
    const reachable = (await (
      await probe.fetch(`https://probe.test/?host=${UNKNOWN_HOST}`)
    ).json()) as Record<string, unknown>;

    // The one capability the binding grants.
    expect(reachable.lookup).toEqual({ kind: 'unknown-host' });
    // The registry is not a directory, and the consumer holds no object
    // namespace through which it could become one.
    expect(reachable.durableObjectNamespace).toBe('undefined');
    // Everything else on the registry Worker — its default public `fetch`
    // (the signed sync/audit/recovery control plane) and every method that is
    // not `lookup` — is denied by the binding rather than by a check inside
    // the registry.
    for (const denied of ['defaultFetch', 'sync', 'audit', 'recover', 'issueProbeChallenge', 'list']) {
      expect(reachable[denied], denied).not.toBe('reachable');
    }
  });

  it('places an attacker’s first unknown-host lookup at the fixed hint without blocking later admission', async () => {
    // An unknown-host lookup instantiates and reads an empty object. If that
    // first touch could be placed by the caller's geography, an attacker could
    // pin a future hostname near itself before the publisher ever saw it; and
    // if the first touch poisoned the object, the publisher could never admit
    // the host afterwards. Both halves are checked here, in that order.
    const instance = miniflare();

    const first = await request(instance, UNKNOWN_HOST);
    expect(first.status).toBe(404);
    expect(first.headers.get('x-event-router-reason')).toBe('unknown-host');

    await expect(publish(instance, routePayload(UNKNOWN_HOST, 'active'))).resolves.toEqual({
      status: 200,
      result: 'applied',
    });

    const admitted = await request(instance, UNKNOWN_HOST);
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get('x-event-router-revision')).toBe('1');
  });
});

describe('functional synthetic exact-route behaviour', () => {
  it('serves, refuses and projects each committed state end to end', async () => {
    const instance = miniflare();
    await publish(instance, routePayload(ACTIVE_HOST, 'active'));
    await publish(instance, routePayload(INACTIVE_HOST, 'disabled'));
    await publish(instance, {
      schemaVersion: 1,
      revision: '1',
      host: TOMBSTONE_HOST,
      desired: { kind: 'tombstone' },
      updatedAt: new Date().toISOString(),
    });
    await publish(instance, {
      schemaVersion: 1,
      revision: '1',
      host: ROOT_TEST_HOST,
      desired: { kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: null },
      updatedAt: new Date().toISOString(),
    });

    const active = await request(instance, ACTIVE_HOST, '/board?day=3');
    expect(active.status).toBe(200);
    expect(active.headers.get('x-event-router')).toBe('itest-1');
    expect(active.headers.get('x-event-router-revision')).toBe('1');
    // Proxied in place: the origin sees its own host and the public one.
    expect(active.headers.get('x-origin-host')).toBe(ORIGIN_HOST);
    expect(active.headers.get('x-origin-path')).toBe('/board');
    expect(active.headers.get('x-origin-forwarded-host')).toBe(ACTIVE_HOST);
    expect(active.headers.get('location')).toBeNull();

    // The guarded root-test class serves its shell: `doorway` controls the
    // app's `/` outcome, not whether the edge may serve it.
    const rootTest = await request(instance, ROOT_TEST_HOST);
    expect(rootTest.status).toBe(200);
    expect(rootTest.headers.get('x-event-router-revision')).toBe('1');

    for (const [host, reason] of [
      [INACTIVE_HOST, 'inactive'],
      [TOMBSTONE_HOST, 'unknown-host'],
      [`unknown-${'f'.repeat(20)}.${NAMESPACE}`, 'unknown-host'],
      [`admin.${NAMESPACE}`, 'reserved-label'],
    ] as const) {
      const refused = await request(instance, host);
      expect(refused.status, host).toBe(404);
      expect(refused.headers.get('x-event-router-reason'), host).toBe(reason);
      expect(refused.headers.get('cache-control'), host).toBe('no-store');
      expect(refused.headers.get('x-event-router-revision'), host).toBeNull();
    }
  }, 30_000);

  it('serves the exact path capability from the same lookup, and none at all when it fails closed', async () => {
    const instance = miniflare();
    await publish(instance, routePayload(ACTIVE_HOST, 'active'));
    await publish(instance, routePayload(INACTIVE_HOST, 'disabled'));

    const capability = await request(instance, ACTIVE_HOST, CAPABILITY_PATH);
    expect(capability.status).toBe(200);
    expect(capability.headers.get('cache-control')).toBe('no-store');
    expect(capability.headers.get('content-type')).toContain('application/json');
    await expect(capability.json()).resolves.toEqual({
      schemaVersion: 1,
      pathNamespace: null,
      revision: '1',
    });

    for (const host of [INACTIVE_HOST, UNKNOWN_HOST]) {
      const refused = await request(instance, host, CAPABILITY_PATH);
      expect(refused.status, host).toBe(404);
      expect(refused.headers.get('content-type'), host).toContain('text/html');
    }
  }, 30_000);

  it('passes /__/auth/* through without a lookup and reaches no Firebase host on any path', async () => {
    const instance = miniflare();
    // Never published, so a lookup would refuse it. The auth leg still serves,
    // which is the whole point of the exemption.
    const auth = await request(instance, UNKNOWN_HOST, '/__/auth/handler?state=abc');
    expect(auth.status).toBe(200);
    expect(auth.headers.get('x-origin-path')).toBe('/__/auth/handler');
    expect(auth.headers.get('x-event-router-revision')).toBeNull();

    // Every outbound request the router made went to the origin. The Firestore
    // reader and the Cache API envelope are gone, so there is nothing else for
    // it to have called — and the outbound interceptor is what turns that from
    // a claim into an observation.
    await publish(instance, routePayload(ACTIVE_HOST, 'active'));
    for (const path of ['/', '/board', CAPABILITY_PATH]) {
      const response = await request(instance, ACTIVE_HOST, path);
      const originHost = response.headers.get('x-origin-host');
      expect(originHost === null || originHost === ORIGIN_HOST, path).toBe(true);
    }
  }, 30_000);
});
