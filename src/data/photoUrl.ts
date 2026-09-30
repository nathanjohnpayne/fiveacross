// photoUrl — the one definition of an avatar URL this app will store or render.
//
// A participant's avatar is shown to every other participant (Leaderboard,
// rosters, the Feed, proof and Moment rows). An `<img src>` pointed at an
// arbitrary host lets whoever chose the URL log each viewer's IP and user agent,
// so an avatar is either absent or an https URL on one of the two hosts the app
// itself produces:
//
//   * `lh<N>.googleusercontent.com` — Google account photos (Google is the only
//     sign-in provider, `src/firebaseAuth.ts`);
//   * `firebasestorage.googleapis.com` — Storage download URLs, which is what
//     `uploadAvatar` returns for a custom avatar (`avatars/{uid}.jpg`).
//
// `firestore.rules`' `photoUrlOk` holds every stored avatar field (users,
// players, proofs, moments) to the SAME hosts and the same length cap, so a
// writer that sanitizes through here never trips the rule, and a value that
// reached Firestore some other way (a legacy row, a direct SDK write before the
// rule existed) still never reaches an `<img>` through `Avatar`.
//
// Under the Playwright e2e build ONLY, `uploadAvatar` canonicalizes the Storage
// EMULATOR's download URL to its production-shaped twin before it is written
// (the #335 bridge in `./proofMediaUrl.ts`), so the stored value passes this
// check and the rule, and `Avatar` resolves it back to the emulator to render.

/** The ceiling `firestore.rules` enforces on a stored avatar URL. */
export const PHOTO_URL_MAX = 1024;

// A literal, anchored host pattern rather than one assembled from a list: the
// same CodeQL `js/incomplete-hostname-regexp` reasoning `proofMediaUrl.ts`
// records. Every `.` escaped; the host must be followed by `/` so a look-alike
// (`firebasestorage.googleapis.com.example.test`) never matches.
const ALLOWED_PHOTO_URL = /^https:\/\/(?:lh[0-9]\.googleusercontent\.com|firebasestorage\.googleapis\.com)\//;

/** True only for a string avatar URL the rules and the renderer both accept. */
export function isAllowedPhotoUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PHOTO_URL_MAX &&
    ALLOWED_PHOTO_URL.test(value)
  );
}

/** The value to STORE for an avatar: the URL when allowed, else `null`. */
export function allowedPhotoUrlOrNull(value: unknown): string | null {
  return isAllowedPhotoUrl(value) ? value : null;
}
