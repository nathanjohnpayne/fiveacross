/** Owner-approved public hostname projection (#1419). Canonical routing and
 * recovery metadata stay private. One dependency-free module is compiled with
 * Functions and imported directly by Node 22 maintenance and Vite consumers. */
export const PUBLIC_HOSTNAME_FIELDS = Object.freeze({
  routing: Object.freeze(['eventId', 'canonicalHost', 'edition', 'status', 'adultContent', 'slug', 'isCanonical']),
  preview: Object.freeze(['eventName', 'dateRange', 'days', 'hostedBy']),
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Admission checks whole documents; it never redacts a Firestore read. */
export function hasOnlyPublicHostnameFields(data: unknown): data is Record<string, unknown> {
  if (!record(data) || !Object.keys(data).every(key => key === 'preview' || PUBLIC_HOSTNAME_FIELDS.routing.includes(key))) return false;
  if (!Object.prototype.hasOwnProperty.call(data, 'preview')) return true;
  return record(data.preview) && Object.keys(data.preview).every(key => PUBLIC_HOSTNAME_FIELDS.preview.includes(key));
}

/** Deliberately lossy at this public boundary: retain only the eleven approved
 * semantic fields, preserving their values and the existing preview container.
 * Canonical source records are neither mutated nor serialized through this. */
export function projectPublicHostname(data: unknown): Record<string, unknown> {
  if (!record(data)) throw new Error('public hostname projection requires a canonical document');
  const projected: Record<string, unknown> = {};
  for (const key of PUBLIC_HOSTNAME_FIELDS.routing) {
    if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined) projected[key] = data[key];
  }
  if (record(data.preview)) {
    const preview: Record<string, unknown> = {};
    for (const key of PUBLIC_HOSTNAME_FIELDS.preview) {
      if (Object.prototype.hasOwnProperty.call(data.preview, key) && data.preview[key] !== undefined) preview[key] = data.preview[key];
    }
    projected.preview = preview;
  }
  return projected;
}
