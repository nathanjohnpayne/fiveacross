---
spec_id: sec-rules-shape-hardening
status: accepted
---

# Rendered-field and upload-shape hardening (`sec-rules-shape-hardening`)

A hardening pass over the participant-authored values other clients render or act on. It adds type, size and host checks to the rules arms that store them, binds a Claim to its creator's own Proof, holds the Proof id to the auto-id shape before the media rules splice it into a pattern, and names the content types and object names Storage accepts. The honour-system trust model is untouched: a Player's STATS on `players/{uid}` stay freely self-written ([ADR 0001](../docs/adr/0001-honor-system-trust-model.md)), and a legacy row carrying a value the new checks refuse stays writable for every field a write does not touch. Rules cases live in `tests/rules/sec-rules-shape-hardening.test.ts`; the client mirror and converter coercion in `src/data/photoUrl.test.ts` and `src/components/w1-profile-avatar.test.tsx`; the claim-confirm gate in `src/data/cloud-vision-moderation.test.ts`; the Functions halves in `tests/functions/cloud-vision-moderation.test.ts`, `tests/functions/w4-gate-vision-moderation.test.ts`, `tests/functions/d15-scheduler-unlock.test.ts`, `tests/functions/easy-mix-snapshot.test.ts` and `tests/functions/daily-engagement-email.test.ts`.

## Avatars are absent or on an app-produced host

Every stored avatar field — `users/{uid}.photoURL`, `players/{uid}.photoURL`, a Proof's and a Moment's `photoURL` — is `null`/absent or an `https` URL that is either a Google account photo on `lh<N>.googleusercontent.com` (Google is the only sign-in provider) or the avatar OWNER's own custom-avatar object: `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/avatars%2F<uid>.jpg`, where `<bucket>` is one of the two projects' own buckets (`gaycruisebingo` / `fiveacross`, on `.firebasestorage.app` or `.appspot.com`) and `<uid>` is the row's owner (the path uid for users and players, the caller for proofs and Moments). At most 1024 characters (`photoUrlOk(value, uid)` in `firestore.rules`). The Storage host alone would not do: any Firebase project's bucket answers on it, and a participant-owned bucket's access logs would give back the IP and user agent of every viewer. `src/data/photoUrl.ts` is the client mirror: every writer stores through `allowedPhotoUrlOrNull(value, ownerUid)` (so an off-host or foreign value drops to the initial rather than failing the write), and `Avatar` renders only an allowed shape. Under the e2e emulator build `uploadAvatar` canonicalizes the emulator download URL like proof media (#335) and `Avatar` resolves it back to render; the emulator's demo bucket is not one of the two, so a custom avatar written under the emulator is refused (no e2e spec drives one).

- **Given** a create or update setting an avatar on another host, in another project's bucket, naming another user's avatar object, with another scheme, as a non-string, or over 1024 characters **then** it is DENIED; **given** a Google photo, the owner's own avatar object, or `null`, **then** it is ALLOWED.
- **Given** `Avatar` receives a disallowed URL **then** it renders the initial, never an `<img>`; a disallowed custom photo falls back to an allowed `src`.

## Profile and Player identity fields are typed

`users/{uid}` owner writes may carry only `displayName`, `handle`, `photoURL`, `customPhoto`, `createdAt`, `attestedAdultAt`, with `displayName` a string of at most 100 characters and `customPhoto` a boolean. A create is checked whole; an update is checked on the keys it ADDS or CHANGES, so removing a stale legacy key (or clearing a field) is always allowed. `players/{uid}` checks `displayName` (string, at most 100) and `photoURL` on create and whenever an update changes them; nothing else on the row. The client clips a Google display name to 100 before writing it. `playerConverter` reads a non-string `displayName` as absent (the identity-less shape renderers already tolerate, #317) and a disallowed `photoURL` as `null`; `proofConverter` reads a non-string `text` and a disallowed `photoURL` as `null`.

- **Given** a non-string or over-long name, an unknown profile key, or a non-boolean `customPhoto` **then** the write is DENIED.
- **Given** a legacy row whose stored name or avatar would now be refused **when** a write touches only other fields (stats, `attestedAdultAt`) **then** it is ALLOWED.

## Proof ids, Callout text and media objects

A Proof create requires the id to match `^[A-Za-z0-9-]{1,40}$` — `attachProof` mints 20-character alphanumeric auto-ids — because the media arms splice the id into `matches()` patterns, where `.`, `|`, `*` or `(` would widen the `mediaURL` pin to another object. `text` is absent, `null`, or a string of at most 1000 characters. In `storage.rules` a proof object's name must be `<id>.jpg` (content type exactly `image/jpeg`) or `<id>.webm` / `<id>.m4a` (audio), under an Event document that EXISTS and is open; avatars must be `image/jpeg`. `image/svg+xml` and every other image type are refused.

- **Given** an id with regex metacharacters, `_`, spaces or over 40 characters **then** the Proof create and the media upload are DENIED.
- **Given** a `.jpg` object of any type other than `image/jpeg`, or an object named with another extension **then** the upload is DENIED; **given** a proof upload under an Event id with no document **then** it is DENIED.

## A Claim names its creator's own Proof

A Claim create carries only the `attachProof` keys, starts `status: 'pending'` with no `resolvedBy`, has a string `displayName` of at most 100, an integer `cellIndex` in 0–24, and — when `proofId` is not null — a `proofId` of the auto-id shape whose Proof (read with `getAfter`, because `attachProof` writes both in one transaction) has `uid == request.auth.uid`. On the client, `confirmClaim` publishes the named Proof only when the live Proof is the claimant's own (`uid === c.uid`), still `'pending'`, and holds no safety hide; otherwise the Claim still resolves and the Proof is left as it stands.

- **Given** a Claim naming another Player's Proof, a missing Proof, or a path-shaped id **then** the create is DENIED; **given** the Proof and Claim written together **then** it is ALLOWED.
- **Given** a Confirm on a Claim whose Proof belongs to someone else or is not `'pending'` **then** no Proof write is made.

## Server-side halves

- `unlockDayNow` validates `eventId` with `isFirestoreDocumentId` and `dayIndex` as a non-negative integer (`parseUnlockDayNowPayload`), and both manual unlock paths conjoin an active membership with the `admins` roster on a membership-enforced Event, as `approvePrompts` does — checked again INSIDE the writing transaction (roster and membership read through it), so a revocation that commits after the pre-flight refuses the write.
- The daily email flattens and bounds every participant name through `singleLine` (now in `functions/src/emailShell.ts`, shared with the podium) before the plain-text part interpolates it.
- A Cloud Vision verdict applies only to the Proof whose stored `storagePath` is the scanned object; a parked verdict is keyed by the scanned object (`proofScans/{proofId}__{uploaderUid}`), so another folder's object can never replace it, and the consumer reads only the record its Proof's own `storagePath` names; an object under an Event id with no document is not scanned.
