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
//   * this app's OWN custom-avatar object — a Firebase Storage download URL for
//     `avatars/{uid}.jpg` in one of the two projects' buckets, which is what
//     `uploadAvatar` returns. The Storage HOST alone is not enough: any Firebase
//     project's bucket answers on it, and a bucket someone else owns is one whose
//     access logs they read (Codex P1 on #1352).
//
// `firestore.rules`' `photoUrlOk` holds every stored avatar field (users,
// players, proofs, moments) to the SAME shapes and length cap — and, for a
// Storage avatar, to the avatar OWNER's own object — so a writer that sanitizes
// through here (passing the owner's uid) never trips the rule, and a value that
// reached Firestore some other way (a legacy row) still never reaches an
// `<img>` through `Avatar`, which checks the shape without an owner.
//
// Under the Playwright e2e build ONLY, `uploadAvatar` canonicalizes the Storage
// EMULATOR's download URL to its production-host twin before it is written (the
// #335 bridge in `./proofMediaUrl.ts`) and `Avatar` resolves it back to render.
// The emulator's demo bucket is not one of the two projects' buckets, so a
// custom avatar written under the emulator is refused by the rules; no e2e spec
// drives one.

/** The ceiling `firestore.rules` enforces on a stored avatar URL. */
export const PHOTO_URL_MAX = 1024;

// Literal, anchored patterns rather than ones assembled from a list: the same
// CodeQL `js/incomplete-hostname-regexp` reasoning `proofMediaUrl.ts` records.
// Every `.` escaped; each host must be followed by `/` so a look-alike
// (`firebasestorage.googleapis.com.example.test`) never matches.
const GOOGLE_PHOTO_URL = /^https:\/\/lh[0-9]\.googleusercontent\.com\//;
const APP_AVATAR_URL =
  /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/(?:gaycruisebingo|fiveacross)\.(?:firebasestorage\.app|appspot\.com)\/o\/avatars%2F([A-Za-z0-9_-]{1,128})\.jpg(?:\?.*)?$/;

/**
 * True only for a string avatar URL the rules and the renderer both accept.
 * With `ownerUid`, a Storage avatar must be THAT user's own object — the check
 * every writer makes, mirroring the rules. Without it (the renderer, which is
 * handed only a URL), any user's avatar object in the app's buckets passes.
 */
export function isAllowedPhotoUrl(value: unknown, ownerUid?: string): value is string {
  if (typeof value !== 'string' || value.length > PHOTO_URL_MAX) return false;
  if (GOOGLE_PHOTO_URL.test(value)) return true;
  const avatar = APP_AVATAR_URL.exec(value);
  if (avatar === null) return false;
  return ownerUid === undefined || avatar[1] === ownerUid;
}

/** The value to STORE for an avatar owned by `ownerUid`: the URL when allowed, else `null`. */
export function allowedPhotoUrlOrNull(value: unknown, ownerUid?: string): string | null {
  return isAllowedPhotoUrl(value, ownerUid) ? value : null;
}
