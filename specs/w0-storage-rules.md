# w0-storage-rules—Storage rules review + emulator tests

Prove `storage.rules` against the Firebase Storage emulator with `@firebase/rules-unit-testing`, and cross-check that a Proof object which satisfies Storage also satisfies the Firestore `proofs` create rule. The MIME + size caps (`okImage()` image/\* < 8 MB, `okAudio()` audio/\* < 12 MB) are the upload-time moderation surface (ADR 0004). This is a test-first ticket: it adds the Storage emulator coverage the scaffold lacked and leaves `storage.rules` unchanged, because the cross-check confirms the Storage pinning and the Firestore create regex are already in lockstep.

Every claim below is asserted by `tests/rules/w0-storage-rules.test.ts` (layer: rules-emulator; runner `npm run test:rules`, which boots the Firestore + Storage emulators via `firebase emulators:exec`). Object paths mirror `src/data/storage.ts` (`uploadProofMedia`, `uploadAvatar`).

## okImage—image caps on the content-validated proof path

- An owner uploading a 7 MB `image/*` object to `proofs/{eventId}/{uid}/{proofId}.jpg` is ALLOWED (`okImage()` size cap `< 8 MB`).
- The same owner uploading a 9 MB `image/*` object is DENIED (over the 8 MB cap).
- The 8 MB cap is enforced on the first create of a proof path, not only on an update to an already-uploaded path: an owner uploading a 9 MB `image/*` object to a brand-new proof path is DENIED.
- An owner uploading a non-image, non-audio object (`application/pdf`) to a proof path is DENIED (neither `okImage()` nor `okAudio()` accepts the content type).

## okAudio—audio caps on the content-validated proof path

- An owner uploading an 11 MB `audio/*` object to `proofs/{eventId}/{uid}/{proofId}.webm` is ALLOWED (`okAudio()` size cap `< 12 MB`).
- The same owner uploading a 13 MB `audio/*` object is DENIED (over the 12 MB cap).
- The 12 MB cap is enforced on the first create of a proof path too: an owner uploading a 13 MB `audio/*` object to a brand-new proof path is DENIED.
- `okAudio()` gates on `contentType.matches('audio/.*')`, not the object's filename extension—a `.m4a` object with `Content-Type: audio/mp4` (what `uploadProofMedia` writes for a Safari-recorded MP4/AAC clip, #295) is subject to the exact same size cap as a `.webm` object; `storage.rules` needs no change to accept it.

## avatars/{uid}.jpg—owner-only, filename-pinned

- The owner writing `avatars/{uid}.jpg` with a valid image is ALLOWED.
- A caller writing another user's `avatars/{other}.jpg` is DENIED (the filename must equal `request.auth.uid + '.jpg'`).
- The owner writing a wrong filename (`avatars/{uid}.png`) is DENIED.
- The owner writing an over-cap (9 MB) image to their own `avatars/{uid}.jpg` is DENIED: `okImage()`'s 8 MB cap applies to avatars, not only proof paths.

## proofs/{eventId}/{uid}/{file}—owner create, owner/admin delete

- The owning uploader creating `proofs/{eventId}/{uid}/{proofId}.jpg` (valid image) is ALLOWED.
- A non-owner creating an object under another user's proof folder is DENIED.
- The owner deleting their own proof object is ALLOWED.
- An Event admin (uid listed in `events/{eventId}.admins`) deleting the object is ALLOWED—a delete carries no `request.resource`, so it is intentionally exempt from the `okImage()`/`okAudio()` content check.
- An authenticated caller who is neither the object's owner nor listed in `events/{eventId}.admins` is DENIED from deleting the proof object.

## og/\*\*—inert, public-read + write-denied

- `og/**` is public-read: a seeded OG object is readable by an unauthenticated caller.
- Every write to `og/**` is DENIED, including from a signed-in caller, both an update to an already-seeded object and a create of a brand-new object. The OG renderer is dropped per ADR 0005; the block stays inert, and its removal is ticket #39.

## Storage ↔ Firestore Proof pinning (lockstep cross-check)

- For one `(eventId, uid, proofId)` triple, the exact object path the owner is allowed to write in Storage (`proofs/{eventId}/{uid}/{proofId}.jpg` for a photo; `.webm` OR `.m4a` for audio, matching whichever `uploadProofMedia` actually names the clip, #295) is byte-identical to one of the `storagePath` shapes the Firestore `proofs` create rule pins (`firestore.rules`), and a Firestore proof document carrying that `storagePath` plus its matching `mediaURL` is ALLOWED. Storage `okImage()`/`okAudio()` and the Firestore create regex therefore accept the same Proof object under either audio extension, so `storage.rules` needs no tightening.
- A mismatched object—one that satisfies Storage's owner/content-type check but is not named after the target `proofId` (for example `proofs/{eventId}/{uid}/not-{proofId}.jpg`)—is ALLOWED by Storage yet DENIED by the Firestore `proofs` create rule, proving the two rulesets diverge outside the exact pinned path rather than merely agreeing on it.

## Acceptance criteria

- Given a > 8 MB image, when uploaded to a proof/avatar path, then Storage DENIES it (`okImage` cap), on both a first create and an update to an existing object.
- Given `avatars/{uid}.jpg`, when the owner writes it, then ALLOWED; a different uid's path is DENIED.
- Given a Proof delete request, when the caller is signed in but neither the object's owner nor an Event admin, then Storage DENIES it.
- Given a valid Proof object path, when checked against the Firestore Proof-create rule, then both accept it (pinning in lockstep); given a mismatched Proof object path that Storage alone accepts, Firestore DENIES pinning it (negative lockstep).
- Given a write to `og/**`, then Storage DENIES it whether the object already exists or is brand-new.
- `okImage`/`okAudio` size + MIME caps asserted.
- Avatar + Proof-object owner-only paths asserted.
- Inert `og/**` write-deny asserted.
- Storage ↔ Firestore Proof pinning cross-checked, including the negative case.
