/**
 * The complete set of constraints Firestore places on a document id, checked
 * before an untrusted value is joined into a path.
 *
 * Firestore rejects an id that is empty, over 1500 UTF-8 BYTES, contains `/`,
 * is a bare `.` or `..`, or matches `__.*__`. The last two pass the Admin SDK's
 * LOCAL path validation, so they reach the server and fail on the read instead
 * of at the call site, which turns a bad input into an opaque `internal` or a
 * permanently failing retry. Byte length rather than string length, because
 * the limit is bytes and a multi-byte id reaches it sooner than its `.length`
 * suggests. One copy, shared by every caller that builds a path from input
 * (`podiumEmail.ts`'s Most-Loved join key, `approvePrompts.ts`'s payload).
 */
export function isFirestoreDocumentId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 1500 &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..' &&
    !/^__.*__$/.test(value)
  );
}
