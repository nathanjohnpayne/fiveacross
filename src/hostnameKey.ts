/**
 * The Firestore document key for a DNS hostname.
 *
 * URL hostnames retain a trailing DNS root dot while the edge strips it, so
 * both the browser and Worker must use this exact normalization before they
 * address a `hostnames/{host}` document. Host-header-specific work such as
 * port and bracketed-IPv6 handling belongs to the Worker adapter.
 */
export function hostnameKey(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
}
