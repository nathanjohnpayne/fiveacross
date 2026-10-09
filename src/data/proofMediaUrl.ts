// proofMediaUrl — emulator/production origin bridge for public avatars and
// legacy Proof cache purge (#335, #1533). New Proof writes persist only a
// storagePath; their readers use authenticated SDK bytes (#1532).
//
// Avatar writes still canonicalize emulator download URLs to the production
// Storage host required by photoUrlOk (D9); Avatar resolves them back to the
// emulator. deleteProof resolves legacy exact URLs and tokenless bucket/path
// purge identities to the same browser origin. Only the origin is rewritten;
// the encoded object path and query remain byte-identical.
//
// WHY THIS IS SAFE IN PRODUCTION. `EMULATOR_STORAGE_WIRED` repeats — deliberately,
// rather than importing — the same statically-foldable gate `src/firebase.ts`
// uses to decide whether to call `connectStorageEmulator` at all. Under
// `npm run build` (`MODE === 'production'`) it folds to `'production' === 'e2e'`
// → `false`, so both functions collapse to their identity early-return and the
// minifier drops the emulator origin literals with the dead branch — the shipped
// bundle carries no emulator host string, exactly as the firebase.ts branch does
// (the `dist/` grep in specs/x-e2e-happy-path.md § Testing covers both). Keeping
// the gate LOCAL to this module is the point: a cross-module import would make
// the fold depend on the bundler propagating a constant between chunks.
//
// This bridge supplies no bearer fallback for Proof rendering. Its remaining
// URL sinks sanitize after origin resolution.

/**
 * The Storage emulator's host/port, mirroring `firebase.json`'s `emulators.storage`
 * block and the `connectStorageEmulator(storage, '127.0.0.1', 9199)` call in
 * `src/firebase.ts` (drift between the two is pinned by this module's test).
 * `localhost` is accepted alongside the literal loopback IP so a differently
 * configured local stack still resolves.
 */
export const STORAGE_EMULATOR_HOST = '127.0.0.1';
export const STORAGE_EMULATOR_PORT = 9199;

/** The single origin every real `getDownloadURL()` resolves against. */
export const PRODUCTION_DOWNLOAD_ORIGIN = 'https://firebasestorage.googleapis.com';

// The two match patterns are LITERAL regexes rather than `new RegExp` built from
// the constants above. Assembling a hostname pattern by interpolation is exactly
// the shape CodeQL's `js/incomplete-hostname-regexp` and `js/incomplete-
// sanitization` rules flag (correctly: an escaping helper that handles `.` but
// not `\` is a real hazard in general, and a dynamically-built host pattern is
// hard to audit by eye) — and it flagged this module on PR #468 before this
// change. A literal is also simply easier to read as a security boundary. The
// cost is that the pattern and the constants could drift, so
// `proofMediaUrl.test.ts` derives its fixtures FROM the constants and asserts
// the literals still rewrite them.

/**
 * True only in the Playwright e2e build, which is the only build that talks to
 * the emulators. Mirrors `src/firebase.ts`'s emulator gate exactly — see the
 * "WHY THIS IS SAFE IN PRODUCTION" note above for why it is repeated rather
 * than shared.
 */
const EMULATOR_STORAGE_WIRED =
  import.meta.env.MODE === 'e2e' &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID?.startsWith('demo-') === true;

/**
 * Rewrite a Storage-EMULATOR download URL into its production-canonical form, so
 * the stored avatar URL matches `firestore.rules`' `photoUrlOk` host pin.
 * Identity outside the e2e emulator build, and identity on any URL that is not
 * an emulator download URL (a production URL passes through untouched).
 */
export function canonicalizeProofMediaUrl(url: string): string {
  if (!EMULATOR_STORAGE_WIRED) return url;
  // Anchored on the whole emulator origin plus its trailing `/`, so nothing
  // else — another loopback port, a host that merely starts the same way — is
  // ever rewritten. Kept inside the guarded branch (rather than hoisted to
  // module scope) so the production build drops the literals with the dead code.
  return url.replace(
    /^https?:\/\/(?:127\.0\.0\.1|localhost):9199\//i,
    `${PRODUCTION_DOWNLOAD_ORIGIN}/`,
  );
}

/**
 * The inverse of {@link canonicalizeProofMediaUrl}: point a canonicalized
 * legacy URL back at the emulator that actually holds its object. Identity outside the e2e emulator build, and
 * identity on a value that is not a production download URL (an emulator URL
 * seeded directly by a test fixture passes through untouched).
 *
 * Proof media rendering does not call this helper; it uses authenticated SDK bytes.
 */
export function resolveProofMediaUrl(url: string | null | undefined): string | null | undefined {
  if (!EMULATOR_STORAGE_WIRED || !url) return url;
  // Every `.` escaped and the trailing `/` required, so a look-alike host
  // (`https://firebasestorage.googleapis.com.example.test/…`) never matches;
  // `^` keeps a mid-string occurrence out too. Same in-branch placement as above.
  return url.replace(
    /^https:\/\/firebasestorage\.googleapis\.com\//i,
    `http://${STORAGE_EMULATOR_HOST}:${STORAGE_EMULATOR_PORT}/`,
  );
}
