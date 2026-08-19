import type { RegistryLookup } from './state';

const SYNTHETIC_EVENT_HOST = /^r2-[a-z2-7]{26}\.(?:fiveacross\.app|vacaybingo\.com)$/;
const SYNTHETIC_ROOT_HOST = /^r2-root-[a-z2-7]{20}\.(?:fiveacross\.app|vacaybingo\.com)$/;

export interface RegistryLookupBinding {
  lookup(host: string): Promise<RegistryLookup>;
}

export async function lookupSyntheticHost(
  host: string,
  registry: RegistryLookupBinding,
): Promise<RegistryLookup> {
  if (!SYNTHETIC_EVENT_HOST.test(host) && !SYNTHETIC_ROOT_HOST.test(host)) {
    throw new Error('synthetic host rejected');
  }
  return registry.lookup(host);
}
