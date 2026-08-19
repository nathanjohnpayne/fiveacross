// @vitest-environment node
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Log, LogLevel, Miniflare } from 'miniflare';
import type { RouterReplicaDesired } from './contracts';
import type { ProbeObservation, ProbePrincipal } from './probe';
import type { RecoveryRequest, SourceAudit, WafEvidence } from './recovery';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const NOW = Date.parse('2026-08-19T12:35:00.000Z');
let registryBundle = '';
const instances: Miniflare[] = [];

const wrapper = `
import { HostRegistryObject } from './registry.mjs';
export { HostRegistryObject };
export default {
  async fetch(request, env) {
    const input = await request.json();
    const stub = env.HOST_REGISTRY.getByName(input.host, { locationHint: 'wnam' });
    let value;
    if (input.op === 'sync') value = await stub.sync(input.payload, input.epoch);
    else if (input.op === 'lookup') value = await stub.lookup();
    else if (input.op === 'audit') value = await stub.audit(input.after);
    else if (input.op === 'challenge') value = await stub.issueProbeChallenge(input.request, input.principal, input.now, input.nonce);
    else if (input.op === 'attest') value = await stub.attestProbe(input.observation, input.principal, input.now, input.id);
    else if (input.op === 'recover') value = await stub.recover(input.request, input.context);
    else return Response.json({ error: 'unknown operation' }, { status: 400 });
    return Response.json(value);
  },
};
`;

beforeAll(async () => {
  const bundled = await build({
    entryPoints: ['worker/src/registry/registryWorker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['cloudflare:workers'],
  });
  registryBundle = bundled.outputFiles[0].text;
});

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

function miniflare(): Miniflare {
  const instance = new Miniflare({
    compatibilityDate: '2026-07-30',
    modules: [
      { type: 'ESModule', path: 'entry.mjs', contents: wrapper },
      { type: 'ESModule', path: 'registry.mjs', contents: registryBundle },
    ],
    durableObjects: {
      HOST_REGISTRY: {
        className: 'HostRegistryObject',
        useSQLite: true,
        unsafeUniqueKey: 'event-router-registry-v1',
      },
    },
    log: new Log(LogLevel.NONE),
  });
  instances.push(instance);
  return instance;
}

async function rpc<T>(instance: Miniflare, input: Record<string, unknown>): Promise<T> {
  const response = await instance.dispatchFetch('https://registry.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: HOST, ...input }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

function payload(revision: string, eventId: string): RouterReplicaDesired {
  return {
    schemaVersion: 1,
    revision,
    host: HOST,
    desired: {
      kind: 'route',
      eventId,
      status: 'active',
      slug: 'r2-abcdefghijklmnopqrstuvwxyz',
      edition: 'fiveacross',
      pathNamespace: null,
    },
    updatedAt: new Date(NOW).toISOString(),
  };
}

function projectionDigest(value: RouterReplicaDesired): string {
  const desired = value.desired;
  if (desired.kind !== 'route') throw new Error('test requires a route');
  return createHash('sha256')
    .update(
      JSON.stringify([
        1,
        value.revision,
        value.host,
        'route',
        desired.eventId,
        desired.status,
        desired.slug,
        desired.edition,
        desired.pathNamespace,
      ]),
    )
    .digest('hex');
}

describe('HostRegistryObject runtime transactions', () => {
  it('serializes concurrent arrivals, survives response loss/reset, and atomically locks with consumed probe evidence', async () => {
    const instance = miniflare();
    const left = payload('1', 'left');
    const right = payload('1', 'right');

    const concurrent = await Promise.all([
      rpc<{ status: number; result: string }>(instance, {
        op: 'sync',
        payload: left,
        epoch: '1',
      }),
      rpc<{ status: number; result: string }>(instance, {
        op: 'sync',
        payload: right,
        epoch: '1',
      }),
    ]);
    expect(concurrent.map((result) => result.result).sort()).toEqual(['applied', 'revision-conflict']);

    const lookup = await rpc<{
      kind: 'committed';
      revision: string;
      desired: RouterReplicaDesired['desired'];
    }>(instance, { op: 'lookup' });
    const accepted = lookup.desired.kind === 'route' && lookup.desired.eventId === 'left' ? left : right;
    expect(lookup.revision).toBe('1');

    await rpc(instance, { op: 'sync', payload: accepted, epoch: '1' });
    await expect(
      rpc<{ result: string }>(instance, {
        op: 'sync',
        payload: accepted,
        epoch: '1',
      }),
    ).resolves.toEqual({ status: 200, result: 'replay' });

    const digest = projectionDigest(accepted);
    const blockNonce = 'block-nonce-1';
    const blockDigest = createHash('sha256')
      .update(JSON.stringify({ recoveryBlock: blockNonce }))
      .digest('hex');
    const attestationIds: [string, string, string] = ['att-1', 'att-2', 'att-3'];
    const providerRequests: WafEvidence['providerRequests'] = [0, 1, 2].map((index) => ({
      rayId: `ray-${index}`,
      eventAt: new Date(NOW - 1_000).toISOString(),
      verifiedAt: new Date(NOW).toISOString(),
      edgeColoCode: ['SJC', 'IAD', 'LHR'][index],
      host: HOST,
      path: '/__registry-probe',
      query: `nonce=nonce-${index}`,
      queryDigest: createHash('sha256').update(`nonce=nonce-${index}`).digest('hex'),
      edgeResponseStatus: 403,
      httpLogResponseDigest: String(index + 4).repeat(64),
      firewall: {
        action: 'block' as const,
        source: 'firewallcustom' as const,
        ruleId: 'rule-1',
        ref: 'registry-recovery',
        matchIndex: 0 as const,
        logResponseDigest: String(index + 7).repeat(64),
      },
    })) as WafEvidence['providerRequests'];

    for (const index of [0, 1, 2] as const) {
      const principal: ProbePrincipal = {
        subject: `probe-${index}`,
        keyVersion: `probe-key/${index}`,
        keyFingerprint: String(index + 1).repeat(64),
        region: ['us-west1', 'us-east1', 'europe-west1'][index],
      };
      await expect(
        rpc(instance, {
          op: 'challenge',
          request: {
            host: HOST,
            phase: 'blocked-before-worker',
            expectedStateDigest: digest,
          },
          principal,
          now: NOW,
          nonce: `nonce-${index}`,
        }),
      ).resolves.toMatchObject({ ok: true });
      const observation: ProbeObservation = {
        phase: 'blocked-before-worker',
        probeNonce: `nonce-${index}`,
        observedAt: new Date(NOW).toISOString(),
        rayId: `ray-${index}`,
        host: HOST,
        requestPath: `/__registry-probe?nonce=nonce-${index}`,
        expectedStatus: 403,
        observedStatus: 403,
        expectedBlockBodyDigest: blockDigest,
        observedBlockBodyDigest: blockDigest,
      };
      await expect(
        rpc(instance, {
          op: 'attest',
          observation,
          principal,
          now: NOW,
          id: attestationIds[index],
        }),
      ).resolves.toMatchObject({ ok: true });
    }

    const sourceAudit: SourceAudit = {
      revision: '1',
      digest,
      observedAt: new Date(NOW).toISOString(),
      canonicalProjection: {
        sourceDocumentDigest: 'a'.repeat(64),
        host: HOST,
        desired: accepted.desired,
      },
      ledgerPayload: accepted,
      ledgerDocumentDigest: 'b'.repeat(64),
      attestorSub: 'source-attestor',
      attestorKeyVersion: 'source-key/1',
      attestorKeyFingerprint: 'c'.repeat(64),
      attestationIssuedAt: new Date(NOW).toISOString(),
      attestationSignature: 'signed-source',
    };
    const wafEvidence: WafEvidence = {
      zoneId: 'zone-1',
      rulesetId: 'ruleset-1',
      ruleId: 'rule-1',
      host: HOST,
      verifiedAt: new Date(NOW).toISOString(),
      blockNonce,
      providerRule: {
        enabled: true,
        action: 'block',
        expression: `http.host eq "${HOST}"`,
        ref: 'registry-recovery',
        customResponseBodyDigest: blockDigest,
        responseDigest: 'd'.repeat(64),
      },
      probeAttestationIds: attestationIds,
      providerRequests,
    };
    const recovery: RecoveryRequest = {
      schemaVersion: 1,
      host: HOST,
      expectedCommitted: { revision: '1', digest },
      sourceAudit,
      action: { kind: 'acquire-lock', wafEvidence },
      incidentUrl: 'https://example.com/incidents/1',
      reason: 'publisher incident',
    };
    await expect(
      rpc(instance, {
        op: 'recover',
        request: recovery,
        context: {
          now: NOW,
          operatorSub: 'recovery-operator',
          lockId: 'lock-1',
        },
      }),
    ).resolves.toEqual({ ok: true, sequence: '1', action: 'acquire-lock' });

    await expect(
      rpc<{ status: number; result: string }>(instance, {
        op: 'sync',
        payload: payload('2', 'successor'),
        epoch: '7',
      }),
    ).resolves.toEqual({ status: 503, result: 'recovery-locked' });
    const audit = await rpc<{
      ok: true;
      page: {
        records: Array<{ action: string }>;
        highestAuthenticatedPublisherEpoch: string;
      };
    }>(instance, { op: 'audit', after: '0' });
    expect(audit.page.records.map((record) => record.action)).toEqual(['acquire-lock']);
    expect(audit.page.highestAuthenticatedPublisherEpoch).toBe('7');

    await instance.unsafeEvictDurableObject('', 'HostRegistryObject', {
      name: HOST,
    });
    const afterReset = await rpc<{
      ok: true;
      page: {
        recoveryLock: { lockId: string };
        records: Array<{ sequence: string }>;
      };
    }>(instance, { op: 'audit', after: '0' });
    expect(afterReset.page.recoveryLock.lockId).toBe('lock-1');
    expect(afterReset.page.records.map((record) => record.sequence)).toEqual(['1']);
  }, 30_000);
});
