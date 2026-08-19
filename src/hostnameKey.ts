/**
 * The Firestore document key for a DNS hostname.
 *
 * This is a storage-key normalizer, not an origin-equivalence predicate. The
 * edge and browser bootstrap reject root-dot requests before lookup because
 * browser auth helpers require an exact serialized origin. Host-header-specific
 * work such as port and bracketed-IPv6 handling belongs to the Worker adapter.
 */
export function hostnameKey(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
}
