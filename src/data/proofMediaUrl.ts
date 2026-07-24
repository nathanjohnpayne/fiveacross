// proofMediaUrl — the emulator↔production bridge for a Proof's `mediaURL` (#335).
//
// THE PROBLEM. `firestore.rules`' proof-create rule pins `mediaURL` to the exact
// Storage object this Proof owns, host included:
//
//   ^https://firebasestorage[.]googleapis[.]com/v0/b/[^/]+/o/proofs%2F…
//
// That host pin is deliberate — it is what stops a client claiming an arbitrary
// off-Storage URL as proof media. Against REAL Storage, `getDownloadURL()`
// returns exactly that shape and the rule matches. Against the local Storage
// EMULATOR it returns the emulator's own origin (`http://127.0.0.1:9199/v0/b/…`,
// same path and query), which never matches — so every real photo/audio Proof
// 403s in the emulator stack, and no e2e spec could ever drive the media path.
// The regex the coverage exists to protect was the one thing e2e could not
// exercise (#335).
//
// THE BRIDGE. Two inverse origin rewrites, both inert outside the e2e emulator
// build:
//
//   * `canonicalizeProofMediaUrl` runs at PROOF-WRITE (`uploadProofMedia`), and
//     turns the emulator download URL into its production-canonical twin. The
//     value written to Firestore is then the same shape production writes, so
//     the rules regex is exercised FOR REAL rather than relaxed or bypassed.
//   * `resolveProofMediaUrl` runs at RENDER (the Feed's media sink) and at
//     cache-purge, and inverts it, so the browser fetches the bytes back from
//     the emulator that actually holds them.
//
// Only the ORIGIN is rewritten; `/v0/b/<bucket>/o/<encoded path>?alt=media&token=…`
// is byte-identical between the two hosts, which is what makes the pair lossless.
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
// SCOPE. PROOF media only. `uploadAvatar` deliberately keeps the raw
// `getDownloadURL()` value: avatar URLs are pinned by no rules regex (a profile
// `photoURL` is free-form), so canonicalizing one would buy nothing and add a
// second rewrite surface. The service worker's CacheFirst proof-media route
// (`PROOF_MEDIA_URL_PATTERN`, ./proofMediaCache.ts) matches the PRODUCTION host,
// so under the e2e build the resolved emulator request simply misses the route
// and nothing is cached — which is the correct behaviour for a test run, and the
// reason `deleteProof`'s cache purge resolves its key the same way the render
// path does rather than purging a key the browser never wrote.
//
// ORDERING NOTE FOR THE RENDER HALF. `resolveProofMediaUrl` must run BEFORE
// `safeMediaUrl`, never after: `safeMediaUrl` is the CodeQL-recognised sanitizer
// barrier for the `js/xss-through-dom` class on the Proof media sinks (PR #95),
// and any rewrite applied after it would sit between the barrier and the DOM and
// re-open the class. Composed the documented way round — sanitize last — the
// barrier still terminates every flow into the `src` attribute.

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
const PRODUCTION_DOWNLOAD_ORIGIN = 'https://firebasestorage.googleapis.com';

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
 * the value written to a Proof doc matches `firestore.rules`' `mediaURL` regex.
 * Identity outside the e2e emulator build, and identity on any URL that is not
 * an emulator download URL (a production URL passes through untouched).
 */
export function canonicalizeProofMediaUrl(url: string): string {
  if (!EMULATOR_STORAGE_WIRED) return url;
  // Built here rather than hoisted to module scope ON PURPOSE: keeping every
  // emulator literal inside the guarded branch is what lets the production build
  // drop them with the dead code. The cost is one regex compile per call, on a
  // path that only ever runs in the e2e build (once per proof upload).
  return url.replace(
    new RegExp(
      `^https?://(?:${STORAGE_EMULATOR_HOST.replace(/\./g, '\\.')}|localhost):${STORAGE_EMULATOR_PORT}/`,
      'i',
    ),
    `${PRODUCTION_DOWNLOAD_ORIGIN}/`,
  );
}

/**
 * The inverse of {@link canonicalizeProofMediaUrl}: point a canonicalized
 * `mediaURL` back at the emulator that actually holds the bytes, so the Feed's
 * `<img>`/`<audio>` can load it. Identity outside the e2e emulator build, and
 * identity on a value that is not a production download URL (an emulator URL
 * seeded directly by a test fixture passes through untouched).
 *
 * MUST be composed INSIDE `safeMediaUrl(...)`, never around it — see the
 * ordering note in this file's header.
 */
export function resolveProofMediaUrl(url: string | null | undefined): string | null | undefined {
  if (!EMULATOR_STORAGE_WIRED || !url) return url;
  // Same reasoning as above: the literals live inside the guarded branch so the
  // production build can drop them. One compile per Feed media card, e2e only.
  return url.replace(
    // Anchored on the full origin plus its trailing `/`, so a look-alike host
    // (`https://firebasestorage.googleapis.com.example/…`) never matches.
    new RegExp(`^${PRODUCTION_DOWNLOAD_ORIGIN.replace(/[.]/g, '\\.')}/`, 'i'),
    `http://${STORAGE_EMULATOR_HOST}:${STORAGE_EMULATOR_PORT}/`,
  );
}
