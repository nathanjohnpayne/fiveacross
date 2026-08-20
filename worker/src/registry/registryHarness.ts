import { WorkerEntrypoint } from 'cloudflare:workers';
import { lookupSyntheticHost } from './registryHarnessCore';
import type { RegistryLookup } from './state';

export class SyntheticRegistryHarnessEntrypoint extends WorkerEntrypoint<RegistryHarnessEnv> {
  async lookup(host: string): Promise<RegistryLookup> {
    if (this.env.REGISTRY === undefined) return { kind: 'unavailable' };
    return lookupSyntheticHost(host, (candidate) => this.env.REGISTRY.lookup(candidate));
  }
}

export default {} satisfies ExportedHandler<RegistryHarnessEnv>;
