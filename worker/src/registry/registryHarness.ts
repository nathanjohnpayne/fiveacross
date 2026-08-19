import { WorkerEntrypoint } from 'cloudflare:workers';
import { lookupSyntheticHost, type RegistryLookupBinding } from './registryHarnessCore';
import type { RegistryLookup } from './state';

interface RegistryHarnessEnv {
  REGISTRY?: RegistryLookupBinding;
}

export class SyntheticRegistryHarnessEntrypoint extends WorkerEntrypoint<RegistryHarnessEnv> {
  async lookup(host: string): Promise<RegistryLookup> {
    if (this.env.REGISTRY === undefined) return { kind: 'unavailable' };
    return lookupSyntheticHost(host, this.env.REGISTRY);
  }
}

export default {} satisfies ExportedHandler<RegistryHarnessEnv>;
