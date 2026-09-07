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
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { projectionDigest, type RouterReplicaDesired } from './contracts';
import type { ProbeObservation, ProbePrincipal } from './probe';
import type { RecoveryRequest, SourceAudit, WafEvidence } from './recovery';

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
    const op = input.op ?? 'sync';
    if (op === 'sync') return Response.json(await stub.sync(input.payload, input.epoch));
    if (op === 'challenge') {
      return Response.json(await stub.issueProbeChallenge(input.request, input.principal, input.now, input.nonce));
    }
    if (op === 'attest') {
      return Response.json(await stub.attestProbe(input.observation, input.principal, input.now, input.id));
    }
    if (op === 'recover') return Response.json(await stub.recover(input.request, input.context));
    if (op === 'audit') return Response.json(await stub.audit(input.after ?? '0'));
    return Response.json({ error: 'unknown operation' }, { status: 400 });
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

async function control<T>(instance: Miniflare, input: Record<string, unknown>): Promise<T> {
  const registry = await instance.getWorker('registry');
  const response = await registry.fetch('https://registry.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function publish(
  instance: Miniflare,
  payload: RouterReplicaDesired,
  epoch = '1',
): Promise<{ status: number; result: string }> {
  return control(instance, { op: 'sync', host: payload.host, payload, epoch });
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

    // The revision column is the recovery contract's, not a nicety: a
    // `canonical-after-unblock` probe observes `{reason, revision}` together
    // for `inactive` and `unknown-host` alike, so the two refusals decided
    // from a committed record publish the revision they were refused from
    // while the refusals with no record to attribute publish none.
    for (const [host, reason, revision] of [
      [INACTIVE_HOST, 'inactive', '1'],
      [TOMBSTONE_HOST, 'unknown-host', '1'],
      [`unknown-${'f'.repeat(20)}.${NAMESPACE}`, 'unknown-host', null],
      [`admin.${NAMESPACE}`, 'reserved-label', null],
    ] as const) {
      const refused = await request(instance, host);
      expect(refused.status, host).toBe(404);
      expect(refused.headers.get('x-event-router-reason'), host).toBe(reason);
      expect(refused.headers.get('cache-control'), host).toBe('no-store');
      expect(refused.headers.get('x-event-router-revision'), host).toBe(revision);
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

// --- The recovery round trip: router response -> probe attestation -> lock ---
//
// `specs/event-router-registry.md` § Audit and recovery closes the loop between
// what this router PUBLISHES and what the registry will ACCEPT as proof: a
// `canonical-after-unblock` observation carries `{reason, revision}` together,
// and `clear-lock` consumes three of them "whose host/result/revision equal
// committed state". So the public response is not merely a diagnostic — it is
// the evidence, and a refusal that dropped its revision would leave a
// tombstoned or disabled host permanently locked, and therefore unable to
// accept another publisher update, for as long as the state persisted.
//
// Nothing below asserts a header shape and calls it done. The observations are
// built from the real router responses, fed through the real
// `attestProbe`/`recover` transactions on the real object, and the lock is
// read back as cleared through the registry's own audit page.

const ZONE_ID = '1'.repeat(32);
const RULESET_ID = '2'.repeat(32);
const RULE_ID = '3'.repeat(32);
const RULE_REF = 'registry-recovery';
const LOCK_ID = 'lock-1';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function principals(phase: string): [ProbePrincipal, ProbePrincipal, ProbePrincipal] {
  return [0, 1, 2].map((index) => ({
    subject: `${phase}-runner-${index}`,
    keyVersion: `probe-key/${phase}/${index}`,
    keyFingerprint: sha256(`${phase}-key-${index}`),
    region: ['us-west1', 'us-east1', 'europe-west1'][index],
  })) as [ProbePrincipal, ProbePrincipal, ProbePrincipal];
}

type ProviderRequest = WafEvidence['providerRequests'][number];

function providerRequest(
  host: string,
  index: number,
  nonce: string,
  status: number,
  at: number,
  blocked: boolean,
): ProviderRequest {
  const query = `nonce=${nonce}`;
  return {
    rayId: `ray-${blocked ? 'blocked' : 'canonical'}-${nonce}`,
    eventAt: new Date(at).toISOString(),
    verifiedAt: new Date(at + 1_000).toISOString(),
    edgeColoCode: ['SJC', 'IAD', 'LHR'][index],
    host,
    path: '/',
    query,
    queryDigest: sha256(query),
    edgeResponseStatus: status,
    httpLogResponseDigest: sha256(`http-${String(blocked)}-${nonce}`),
    firewall: blocked
      ? {
          action: 'block' as const,
          source: 'firewallcustom' as const,
          ruleId: RULE_ID,
          ref: RULE_REF,
          matchIndex: 0 as const,
          logResponseDigest: sha256(`firewall-${nonce}`),
        }
      : null,
  };
}

async function sourceAuditFor(payload: RouterReplicaDesired, at: number): Promise<SourceAudit> {
  return {
    revision: payload.revision,
    digest: await projectionDigest(payload),
    observedAt: new Date(at).toISOString(),
    canonicalProjection: {
      sourceDocumentDigest: sha256(`source-${payload.host}-${payload.revision}`),
      host: payload.host,
      desired: payload.desired,
    },
    ledgerPayload: payload,
    ledgerDocumentDigest: sha256(`ledger-${payload.host}-${payload.revision}`),
    attestorSub: 'source-attestor',
    attestorKeyVersion: 'source-key/1',
    attestorKeyFingerprint: sha256('source-attestor-key'),
    attestationIssuedAt: new Date(at).toISOString(),
    attestationSignature: 'signed-source',
  };
}

function recoveryContext(now: number, lockId: string): Record<string, unknown> {
  return {
    now,
    operatorSub: 'recovery-operator',
    operatorKeyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/recovery/cryptoKeyVersions/1',
    operatorKeyFingerprint: sha256('recovery-operator-key'),
    operatorSignature: 'signed-recovery-request',
    operatorSignatureScheme: 'v1',
    operatorSignedRole: 'recovery',
    operatorSignedMethod: 'POST',
    operatorSignedPath: '/__internal/hostname-replicas/v1/recover',
    operatorIssuedAt: String(now),
    requestBodyDigest: sha256(`recovery-body-${lockId}-${String(now)}`),
    lockId,
    expectedWafZone: { namespace: 'fiveacross.app', zoneId: ZONE_ID, rulesetId: RULESET_ID },
  };
}

type RecoveryResult = { ok: true; sequence: string; action: string } | { ok: false; error: string };
type ChallengeResult = { ok: true; challenge: { probeNonce: string } } | { ok: false; error: string };
type AttestResult = { ok: true; attestation: { id: string } } | { ok: false; error: string };

/** What the PUBLIC router answered, read off the response rather than assumed. */
type RouterObservation = {
  status: number;
  reason: null | 'inactive' | 'unknown-host';
  revision: string;
  servesOrigin: boolean;
  originRequestId: string | null;
};

async function observeRouter(
  instance: Miniflare,
  host: string,
  nonce: string,
): Promise<RouterObservation> {
  const response = await request(instance, host, `/?nonce=${encodeURIComponent(nonce)}`);
  const reason = response.headers.get('x-event-router-reason');
  const originRequestId = response.headers.get('x-origin-host');
  return {
    status: response.status,
    reason: reason === null ? null : (reason as 'inactive' | 'unknown-host'),
    // A MISSING header reads as the empty string on purpose. That is what a
    // probe runner would record, and recording it faithfully is what makes the
    // registry's own refusal — rather than a hand-written assertion — the thing
    // that catches a router which stopped publishing the revision.
    revision: response.headers.get('x-event-router-revision') ?? '',
    servesOrigin: originRequestId !== null,
    originRequestId,
  };
}

function canonicalObservation(
  host: string,
  nonce: string,
  at: number,
  observed: RouterObservation,
): ProbeObservation {
  return {
    phase: 'canonical-after-unblock',
    probeNonce: nonce,
    observedAt: new Date(at).toISOString(),
    rayId: `ray-canonical-${nonce}`,
    host,
    requestPath: `/?nonce=${nonce}`,
    expectedStatus: observed.status,
    observedStatus: observed.status,
    expectedReason: observed.reason,
    observedReason: observed.reason,
    expectedRevision: observed.revision,
    observedRevision: observed.revision,
    expectedServesOrigin: observed.servesOrigin,
    observedServesOrigin: observed.servesOrigin,
    originRequestId: observed.servesOrigin ? observed.originRequestId : null,
  };
}

/** What a held recovery lock lets a `canonical-after-unblock` challenge name. */
type HeldRecoveryLock = { digest: string; lockId: string; recoverySequence: string };

/**
 * Step 1 of § Audit and recovery — contain and acquire — on three blocked
 * attestations and the provider records that match them.
 *
 * Extracted so it can be reached without the clear that follows it, because a
 * `canonical-after-unblock` challenge is only issuable WHILE THE LOCK IS HELD:
 * the registry checks the lock id, the recovery sequence and the unblock time
 * before it will mint one. Every test that needs a real canonical challenge
 * therefore comes through here rather than borrowing a `blocked-before-worker`
 * challenge — a mismatched phase is rejected before any of the fields the test
 * meant to exercise are compared, which makes the test pass for a reason that
 * has nothing to do with what it claims to check.
 *
 * The WAF and its provider logs are the one part that cannot be observed here:
 * a `blocked-before-worker` request never reaches the Worker by definition, so
 * that phase is synthesised. Everything after the unblock is real.
 */
async function acquireRecoveryLock(
  instance: Miniflare,
  payload: RouterReplicaDesired,
  base: number,
): Promise<HeldRecoveryLock> {
  const host = payload.host;
  const digest = await projectionDigest(payload);
  const blockNonce = `block-${host}`;
  const blockDigest = sha256(JSON.stringify({ recoveryBlock: blockNonce }));

  // 1. Contain and acquire, on three blocked attestations.
  const blockedIds: [string, string, string] = [`b1-${host}`, `b2-${host}`, `b3-${host}`];
  const blockedProviders: ProviderRequest[] = [];
  for (const [index, principal] of principals('blocked').entries()) {
    const nonce = `blocked-${String(index)}-${host}`;
    await expect(
      control<ChallengeResult>(instance, {
        op: 'challenge',
        host,
        request: { host, phase: 'blocked-before-worker', expectedStateDigest: digest },
        principal,
        now: base,
        nonce,
      }),
    ).resolves.toMatchObject({ ok: true });
    blockedProviders.push(providerRequest(host, index, nonce, 403, base + 1_000, true));
    const observation: ProbeObservation = {
      phase: 'blocked-before-worker',
      probeNonce: nonce,
      observedAt: new Date(base + 1_000).toISOString(),
      rayId: `ray-blocked-${nonce}`,
      host,
      requestPath: `/?nonce=${nonce}`,
      expectedStatus: 403,
      observedStatus: 403,
      expectedBlockBodyDigest: blockDigest,
      observedBlockBodyDigest: blockDigest,
    };
    await expect(
      control<AttestResult>(instance, {
        op: 'attest',
        host,
        observation,
        principal,
        now: base + 2_000,
        id: blockedIds[index],
      }),
    ).resolves.toMatchObject({ ok: true });
  }

  const wafEvidence: WafEvidence = {
    zoneId: ZONE_ID,
    rulesetId: RULESET_ID,
    ruleId: RULE_ID,
    host,
    verifiedAt: new Date(base + 2_500).toISOString(),
    blockNonce,
    providerRule: {
      enabled: true,
      action: 'block',
      expression: `http.host eq "${host}"`,
      ref: RULE_REF,
      customResponseBodyDigest: blockDigest,
      responseDigest: sha256(`waf-response-${host}`),
    },
    probeAttestationIds: blockedIds,
    providerRequests: blockedProviders as WafEvidence['providerRequests'],
  };
  const acquire: RecoveryRequest = {
    schemaVersion: 1,
    host,
    expectedCommitted: { revision: payload.revision, digest },
    sourceAudit: await sourceAuditFor(payload, base + 3_000),
    action: { kind: 'acquire-lock', wafEvidence },
    incidentUrl: 'https://example.com/incidents/972',
    reason: 'publisher integrity incident',
  };
  await expect(
    control<RecoveryResult>(instance, {
      op: 'recover',
      host,
      request: acquire,
      context: recoveryContext(base + 3_000, LOCK_ID),
    }),
  ).resolves.toEqual({ ok: true, sequence: '1', action: 'acquire-lock' });
  return { digest, lockId: LOCK_ID, recoverySequence: '1' };
}

/**
 * Contain, acquire, unblock, prove, clear — the whole § Audit and recovery
 * state machine against one host, with the canonical evidence taken from the
 * router's own answer.
 */
async function recoverAndClear(
  instance: Miniflare,
  payload: RouterReplicaDesired,
): Promise<{
  observed: RouterObservation[];
  audit: { recoveryLock: unknown; committed: { revision: string } | null };
}> {
  const host = payload.host;
  const base = Date.now();
  const { digest, lockId, recoverySequence } = await acquireRecoveryLock(instance, payload, base);

  // 2. Remove the block, then prove the canonical answer — from the ROUTER.
  const wafRemovedAt = new Date(base + 4_000).toISOString();
  const clearIds: [string, string, string] = [`c1-${host}`, `c2-${host}`, `c3-${host}`];
  const clearProviders: ProviderRequest[] = [];
  const observed: RouterObservation[] = [];
  for (const [index, principal] of principals('canonical').entries()) {
    const nonce = `canonical-${String(index)}-${host}`;
    await expect(
      control<ChallengeResult>(instance, {
        op: 'challenge',
        host,
        request: {
          host,
          phase: 'canonical-after-unblock',
          expectedStateDigest: digest,
          recoveryLockId: lockId,
          recoverySequence,
          wafRemovedAt,
        },
        principal,
        now: base + 5_000,
        nonce,
      }),
    ).resolves.toMatchObject({ ok: true });

    // THE public request, through the real router over the real binding, while
    // the lock is held. The lock fences the publisher, not the lookup.
    const answer = await observeRouter(instance, host, nonce);
    observed.push(answer);
    clearProviders.push(providerRequest(host, index, nonce, answer.status, base + 6_000, false));

    await expect(
      control<AttestResult>(instance, {
        op: 'attest',
        host,
        observation: canonicalObservation(host, nonce, base + 6_000, answer),
        principal,
        now: base + 7_000,
        id: clearIds[index],
      }),
    ).resolves.toMatchObject({ ok: true });
  }

  const clear: RecoveryRequest = {
    schemaVersion: 1,
    host,
    expectedCommitted: { revision: payload.revision, digest },
    sourceAudit: await sourceAuditFor(payload, base + 8_000),
    action: {
      kind: 'clear-lock',
      lockId,
      wafRemovedAt,
      probeAttestationIds: clearIds,
      providerRequests: clearProviders as WafEvidence['providerRequests'],
    },
    incidentUrl: 'https://example.com/incidents/972',
    reason: 'canonical state proven from three regions',
  };
  await expect(
    control<RecoveryResult>(instance, {
      op: 'recover',
      host,
      request: clear,
      context: recoveryContext(base + 8_000, 'unused-on-clear'),
    }),
  ).resolves.toEqual({ ok: true, sequence: '2', action: 'clear-lock' });

  const audit = await control<{
    ok: true;
    page: { recoveryLock: unknown; committed: { revision: string } | null };
  }>(instance, { op: 'audit', host, after: '0' });
  return { observed, audit: audit.page };
}

describe('recovery evidence taken from the router’s own answer', () => {
  it.each([
    [
      'a disabled route, publicly refused as inactive',
      INACTIVE_HOST,
      'inactive' as const,
      '2',
    ],
    [
      'a tombstone, publicly refused as unknown-host',
      TOMBSTONE_HOST,
      'unknown-host' as const,
      '2',
    ],
  ])('clears the lock on %s', async (_label, host, reason, revision) => {
    const instance = miniflare();
    // Both states are reached the way a real one is: revision 1 active, then
    // its exact successor carrying the withdrawal.
    await expect(publish(instance, routePayload(host, 'active', '1'))).resolves.toEqual({
      status: 200,
      result: 'applied',
    });
    const payload: RouterReplicaDesired =
      reason === 'inactive'
        ? routePayload(host, 'disabled', revision)
        : {
            schemaVersion: 1,
            revision,
            host,
            desired: { kind: 'tombstone' },
            updatedAt: new Date().toISOString(),
          };
    await expect(publish(instance, payload)).resolves.toEqual({ status: 200, result: 'applied' });

    const { observed, audit } = await recoverAndClear(instance, payload);

    // Every one of the three public answers carried the reason AND the
    // committed revision — the pair the registry then compared against
    // committed state before it would consume them.
    expect(observed).toHaveLength(3);
    for (const answer of observed) {
      expect(answer.status).toBe(404);
      expect(answer.reason).toBe(reason);
      expect(answer.revision).toBe(revision);
      expect(answer.servesOrigin).toBe(false);
    }
    // And the lock is gone, so a queued publisher delivery can proceed again
    // instead of being fenced with `503 recovery-locked` forever.
    expect(audit.recoveryLock).toBeNull();
    expect(audit.committed?.revision).toBe(revision);
    await expect(publish(instance, routePayload(host, 'active', '3'))).resolves.toEqual(
      reason === 'inactive'
        ? { status: 200, result: 'applied' }
        : { status: 409, result: 'tombstone-final' },
    );
  }, 30_000);

  it('accepts a canonical attestation, and refuses the same one with only its observed revision removed', async () => {
    // The negative control for the pair above, and the exact failure a router
    // that dropped the revision on a refusal produces: the runner holds an
    // expectation derived from committed state and observes a revision-less
    // response, so the attestation is refused and no `clear-lock` evidence can
    // ever be assembled for that host.
    //
    // Both halves are here because only the pair isolates the revision. A
    // refusal on its own proves nothing about `observedRevision`: an
    // attestation whose phase, lock, nonce or freshness does not line up is
    // refused just as loudly, and refused EARLIER — which is precisely how the
    // previous version of this test passed. It issued a `blocked-before-worker`
    // challenge and submitted a `canonical-after-unblock` observation, so
    // `acceptProbeAttestation` rejected the phase mismatch before it ever
    // reached the revision comparison, and deleting that comparison outright
    // left the test green.
    //
    // So the challenge below MATCHES the observation's phase, the recovery lock
    // is really held, and the intact evidence is accepted first. The second
    // attestation differs from the accepted one in exactly one field.
    const instance = miniflare();
    // Reached the way a real tombstone is: revision 1 active, then its exact
    // successor carrying the withdrawal.
    await publish(instance, routePayload(TOMBSTONE_HOST, 'active', '1'));
    const payload: RouterReplicaDesired = {
      schemaVersion: 1,
      revision: '2',
      host: TOMBSTONE_HOST,
      desired: { kind: 'tombstone' },
      updatedAt: new Date().toISOString(),
    };
    await expect(publish(instance, payload)).resolves.toEqual({ status: 200, result: 'applied' });

    const base = Date.now();
    const { digest, lockId, recoverySequence } = await acquireRecoveryLock(instance, payload, base);
    const wafRemovedAt = new Date(base + 4_000).toISOString();
    const [intactRunner, mutatedRunner] = principals('revision-control');

    // One real `canonical-after-unblock` challenge, then THE public request
    // through the real router over the real binding, exactly as the clearing
    // path above assembles its evidence.
    const observeUnderChallenge = async (
      principal: ProbePrincipal,
      nonce: string,
    ): Promise<RouterObservation> => {
      await expect(
        control<ChallengeResult>(instance, {
          op: 'challenge',
          host: TOMBSTONE_HOST,
          request: {
            host: TOMBSTONE_HOST,
            phase: 'canonical-after-unblock',
            expectedStateDigest: digest,
            recoveryLockId: lockId,
            recoverySequence,
            wafRemovedAt,
          },
          principal,
          now: base + 5_000,
          nonce,
        }),
      ).resolves.toMatchObject({ ok: true });
      return observeRouter(instance, TOMBSTONE_HOST, nonce);
    };

    const intactNonce = `revision-control-intact-${TOMBSTONE_HOST}`;
    const intact = await observeUnderChallenge(intactRunner, intactNonce);
    expect(intact.status).toBe(404);
    expect(intact.reason).toBe('unknown-host');
    expect(intact.revision).toBe('2');
    await expect(
      control<AttestResult>(instance, {
        op: 'attest',
        host: TOMBSTONE_HOST,
        observation: canonicalObservation(TOMBSTONE_HOST, intactNonce, base + 6_000, intact),
        principal: intactRunner,
        now: base + 7_000,
        id: `revision-control-intact-${TOMBSTONE_HOST}`,
      }),
    ).resolves.toMatchObject({ ok: true });

    const mutatedNonce = `revision-control-missing-${TOMBSTONE_HOST}`;
    const mutated = await observeUnderChallenge(mutatedRunner, mutatedNonce);
    expect(mutated).toEqual(intact);
    await expect(
      control<AttestResult>(instance, {
        op: 'attest',
        host: TOMBSTONE_HOST,
        observation: {
          ...canonicalObservation(TOMBSTONE_HOST, mutatedNonce, base + 6_000, mutated),
          // The ONLY difference from the accepted attestation: what the runner
          // would have recorded had the router published no revision header on
          // this refusal.
          observedRevision: '',
        },
        principal: mutatedRunner,
        now: base + 7_000,
        id: `revision-control-missing-${TOMBSTONE_HOST}`,
      }),
    ).resolves.toEqual({ ok: false, error: 'probe-refused' });
  }, 30_000);
});
