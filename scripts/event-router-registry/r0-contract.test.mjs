import { describe, expect, it } from 'vitest';
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
  });
});
