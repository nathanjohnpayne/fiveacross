import { isSyntheticRegistryHost } from './contracts';
import type { RegistryLookup } from './state';

/**
 * The harness may point-look-up ONLY a manifest-safe rehearsal host, and it
 * asks the shared classifier rather than carrying its own copy of the two
 * closed classes. A private harness with a slightly wider idea of "synthetic"
 * than the registry's would be a way to read a real Event's projection through
 * a Worker that exists precisely so that cannot happen.
 */
export async function lookupSyntheticHost(
  host: string,
  lookup: (host: string) => Promise<RegistryLookup>,
): Promise<RegistryLookup> {
  if (!isSyntheticRegistryHost(host)) {
    throw new Error('synthetic host rejected');
  }
  return lookup(host);
}
