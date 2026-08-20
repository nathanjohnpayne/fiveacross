import { describe, expect, it } from 'vitest';
import { REGISTRY_ROLE_AUDIENCES } from '../../worker/src/registry/verificationRecords.ts';
import { REGISTRY_R0_CONTRACT, validateRegistryR0Contract } from './r0-contract.mjs';

describe('registry R0 provisioning contract', () => {
  it('pins distinct identities/keys, least privilege, fixed placement, and nonsampled evidence inputs', () => {
    expect(validateRegistryR0Contract()).toEqual(REGISTRY_R0_CONTRACT);
    expect(REGISTRY_R0_CONTRACT.cloudflare).toMatchObject({
      locationHint: 'wnam',
      kvNamespaces: 0,
      publicNamespaceRoutes: 0,
      wafExpression: 'http.host eq "<normalized-host>"',
      logExplorer: {
        datasets: ['http_requests', 'firewall_events'],
        sampled: false,
        costAlertRequired: true,
        tokenRuntimeVisible: false,
      },
    });
  });

  it('keeps the reviewed source-attestor audience identical to the registry verifier', () => {
    const sourceAttestor = REGISTRY_R0_CONTRACT.identities.find(({ role }) => role === 'source-attestor');
    expect(sourceAttestor?.audience).toBe(REGISTRY_ROLE_AUDIENCES['source-attestor']);
    expect(sourceAttestor?.audience).toMatch(/\/__internal\/hostname-replicas\/v1\/source-attestor$/);
  });

  it('uses valid Google service-account emails for every configured identity', () => {
    for (const identity of REGISTRY_R0_CONTRACT.identities) {
      const match = /^([a-z][a-z0-9-]{4,28}[a-z0-9])@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/.exec(
        identity.subjectAccount,
      );
      expect(match, identity.subjectAccount).not.toBeNull();
      expect(match?.[1].length, identity.subjectAccount).toBeLessThanOrEqual(30);
    }
    expect(
      REGISTRY_R0_CONTRACT.identities.find(({ role }) => role === 'source-attestor')?.subjectAccount,
    ).toBe('event-router-source-attestor@fiveacross.iam.gserviceaccount.com');
  });

  it('pins semantic fields and alert policies for every required operator outcome', () => {
    expect(REGISTRY_R0_CONTRACT.cloudflare.observability).toEqual({
      semanticEvent: 'event-router-registry.semantic',
      workersLogs: { enabled: true, headSamplingRate: 1 },
      requiredFields: ['event', 'outcome', 'registryVersion', 'host', 'revision', 'latencyMs'],
      excludedFields: ['authorization', 'token', 'signature', 'requestBody', 'eventData', 'firebaseKey'],
      alertPolicies: [
        { id: 'revision-conflict', outcome: 'conflict', countGreaterThan: 0, windowSeconds: 60 },
        { id: 'aged-revision-gap', outcome: 'gap', gapAgeMsGreaterThan: 300_000, windowSeconds: 60 },
        { id: 'recovery-action', outcome: 'recovered', countGreaterThan: 0, windowSeconds: 60 },
        { id: 'recovery-locked', outcome: 'recovery-locked', countGreaterThan: 0, windowSeconds: 60 },
        {
          id: 'empty-object-cardinality',
          outcome: 'empty-object',
          distinctHostsGreaterThan: 64,
          windowSeconds: 300,
        },
      ],
    });
  });

  it('fails closed if a publisher receives Firestore or public-key-viewer capability', () => {
    const altered = structuredClone(REGISTRY_R0_CONTRACT);
    altered.publisherRuntime.deny = altered.publisherRuntime.deny.filter(
      (permission) => permission !== 'datastore.*',
    );
    expect(() => validateRegistryR0Contract(altered)).toThrow('publisher runtime');
  });

  it('fails closed on duplicate probe identity/region or sampled provider evidence', () => {
    const altered = structuredClone(REGISTRY_R0_CONTRACT);
    altered.identities.at(-1).subjectAccount = altered.identities.at(-2).subjectAccount;
    expect(() => validateRegistryR0Contract(altered)).toThrow('distinct');

    const sampled = structuredClone(REGISTRY_R0_CONTRACT);
    sampled.cloudflare.logExplorer.sampled = true;
    expect(() => validateRegistryR0Contract(sampled)).toThrow('Cloudflare');

    const missingAlert = structuredClone(REGISTRY_R0_CONTRACT);
    missingAlert.cloudflare.observability.alertPolicies = missingAlert.cloudflare.observability.alertPolicies.filter(
      ({ id }) => id !== 'revision-conflict',
    );
    expect(() => validateRegistryR0Contract(missingAlert)).toThrow('observability');
  });

  it.each([
    ['overlong account id', 'event-router-registry-source-attestor@fiveacross.iam.gserviceaccount.com'],
    ['invalid account id', 'event_router@fiveacross.iam.gserviceaccount.com'],
    ['invalid project id', 'event-router-audit@FiveAcross.iam.gserviceaccount.com'],
  ])('fails closed on an %s', (_label, subjectAccount) => {
    const altered = structuredClone(REGISTRY_R0_CONTRACT);
    altered.identities[1].subjectAccount = subjectAccount;
    expect(() => validateRegistryR0Contract(altered)).toThrow('service-account email');
  });
});
