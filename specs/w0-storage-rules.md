# w0-storage-rules—Storage rules review + emulator tests

Prove `storage.rules` against the Firebase Storage emulator with `@firebase/rules-unit-testing`, and cross-check that a Proof object which satisfies Storage also satisfies the Firestore `proofs` create rule. The MIME + size caps (`okImage()` image/\* < 8 MB, `okAudio()` audio/\* < 12 MB) are the upload-time moderation surface (ADR 0004). This began as a test-first ticket: it added the Storage emulator coverage the scaffold lacked and changed no rule, because the cross-check confirmed the Storage pinning and the Firestore create regex were already in lockstep. **`storage.rules` is no longer unchanged, and this file states the contract as it now stands.** The post-Event archive epic has since tightened the proof-media arm twice, and both denials are asserted below: a proof object is IMMUTABLE, so a second upload to a path that already holds one is refused even for its owner ([#1153](https://github.com/nathanjohnpayne/fiveacross/issues/1153)), and the OWNER's media delete is now the ORPHAN branch and nothing else—always open for a blob no Proof document points at, denied in every state for media one still does ([#1149](https://github.com/nathanjohnpayne/fiveacross/issues/1149), then [#1153](https://github.com/nathanjohnpayne/fiveacross/issues/1153)). Rationale for both lives in `specs/post-sailing-archive.md` § "The enforcement", which owns the archive contract; what belongs here is the Storage arm's own behaviour, and the sentence this paragraph replaced said the opposite of it.

Every claim below is asserted by `tests/rules/w0-storage-rules.test.ts` (layer: rules-emulator; runner `npm run test:rules`, which boots the Firestore + Storage emulators via `firebase emulators:exec`). Object paths mirror `src/data/storage.ts` (`uploadProofMedia`, `uploadAvatar`).

The suite empties the bucket between cases through `tests/support/storage-emulator.ts`, not `RulesTestEnvironment.clearStorage()`: that helper lists the bucket ROOT and deletes the `items` it finds, and `listAll()` does not recurse, so every object this app writes—all of them under a prefix—survives it. The no-op was invisible while proof objects could be overwritten, and became load-bearing the moment they could not. The E2E seed's `withStorage` fixture clears the bucket through the same helper, for the same reason: it seeds proof media under hard-coded ids, so a rerun against a bucket `clearStorage()` had not actually emptied re-uploaded them as denied updates.

## okImage—image caps on the content-validated proof path

- An owner uploading a 7 MB `image/*` object to `proofs/{eventId}/{uid}/{proofId}.jpg` is ALLOWED (`okImage()` size cap `< 8 MB`).
- The same owner uploading a 9 MB `image/*` object to a path of its own is DENIED (over the 8 MB cap). Each cap case gets its OWN fresh object path: proof objects are immutable ([#1153](https://github.com/nathanjohnpayne/fiveacross/issues/1153), below), so a second upload to a path the case already occupied would be denied whatever it weighed and the assertion would say nothing about the cap.
- The 8 MB cap is enforced on the create a real upload performs, which is the only write the arm admits: an owner uploading a 9 MB `image/*` object to a brand-new proof path is DENIED.
- An owner uploading a non-image, non-audio object (`application/pdf`) to a proof path is DENIED (neither `okImage()` nor `okAudio()` accepts the content type).

## okAudio—audio caps on the content-validated proof path

- An owner uploading an 11 MB `audio/*` object to `proofs/{eventId}/{uid}/{proofId}.webm` is ALLOWED (`okAudio()` size cap `< 12 MB`).
- The same owner uploading a 13 MB `audio/*` object to a path of its own is DENIED (over the 12 MB cap), on a fresh path for the same reason as the image cap above.
- The 12 MB cap is enforced on the create a real upload performs: an owner uploading a 13 MB `audio/*` object to a brand-new proof path is DENIED.
- `okAudio()` gates on `contentType.matches('audio/.*')`, not the object's filename extension—a `.m4a` object with `Content-Type: audio/mp4` (what `uploadProofMedia` writes for a Safari-recorded MP4/AAC clip, #295) is subject to the exact same size cap as a `.webm` object; the arm carries no per-extension clause and needs none to accept it.

## avatars/{uid}.jpg—owner-only, filename-pinned

- The owner writing `avatars/{uid}.jpg` with a valid image is ALLOWED.
- A caller writing another user's `avatars/{other}.jpg` is DENIED (the filename must equal `request.auth.uid + '.jpg'`).
- The owner writing a wrong filename (`avatars/{uid}.png`) is DENIED.
- The owner writing an over-cap (9 MB) image to their own `avatars/{uid}.jpg` is DENIED: `okImage()`'s 8 MB cap applies to avatars, not only proof paths.

## proofs/{eventId}/{uid}/{file}—owner create, owner/admin delete

- The owning uploader creating `proofs/{eventId}/{uid}/{proofId}.jpg` (valid image) is ALLOWED.
- A non-owner creating an object under another user's proof folder is DENIED.
- **A proof object is IMMUTABLE** ([#1153](https://github.com/nathanjohnpayne/fiveacross/issues/1153); rationale in `specs/post-sailing-archive.md` § "The enforcement"). A SECOND upload to a path that already holds an object is DENIED even for the owner—at the same bytes the create accepted, and at any other accepted size or content type, for audio as much as photo. The arm's predicate is `resource == null` rather than an `allow create` without `update`: the Storage emulator evaluates a second upload to an occupied path under `create` and admits it, so dropping `update` alone would deny nothing and no test could catch it. `resource` is the existing object's metadata, so this reads the bucket, not Firestore, and the arm's Firestore-access budget is unchanged.
- Immutability is about an OBJECT, not a name: a first upload to a fresh path is ALLOWED, and so is a re-upload to the same name AFTER that object is deleted—which is what keeps `attachProof`'s rollback-then-retry working, and what makes the revocation sweeper's `412` mean "re-occupied after a delete" and nothing else.
- `avatars/{uid}.jpg` stays overwritable in place (§ above), which is what proves the immutability is confined to the proofs arm. The Vision handler's `{proofId}_thumb.jpg` also re-saves under this prefix, on the Admin SDK, which bypasses these rules entirely.
- The owner deleting their own proof object is ALLOWED only when the object is an ORPHAN that no Proof document points at—and then in every Event state, open or frozen. It is DENIED for media a live Proof document still points at, in every state, the OPEN Event included ([#1153](https://github.com/nathanjohnpayne/fiveacross/issues/1153)). That is what closes the delete-and-recreate route into the generation-capture window: immutability refuses an OVERWRITE and welcomes a RECREATE, so an owner able to empty the path could refill it between `proofMediaGeneration()`'s read and `deleteProof`'s commit and leave the media-revocation tombstone bound to a blob the path no longer holds. Nothing the app does needs the old permission—`deleteProof` commits the Proof document's removal BEFORE it revokes the object, and `attachProof`'s rollback deletes an object no document was ever written for—so both client deletes are orphan deletes. Rationale and the frozen halves live in `specs/post-sailing-archive.md` § "The enforcement" and `tests/rules/post-sailing-archive.test.ts`.
- An Event admin (uid listed in `events/{eventId}.admins`) deleting the object is ALLOWED—a delete carries no `request.resource`, so it is intentionally exempt from the `okImage()`/`okAudio()` content check.
- An authenticated caller who is neither the object's owner nor listed in `events/{eventId}.admins` is DENIED from deleting the proof object.

## og/\*\*—inert, public-read + write-denied

- `og/**` is public-read: a seeded OG object is readable by an unauthenticated caller.
- Every write to `og/**` is DENIED, including from a signed-in caller, both an update to an already-seeded object and a create of a brand-new object. The OG renderer is dropped per ADR 0005; the block stays inert, and its removal is ticket #39.

## Storage ↔ Firestore Proof pinning (lockstep cross-check)

- For one `(eventId, uid, proofId)` triple, the exact object path the owner is allowed to write in Storage (`proofs/{eventId}/{uid}/{proofId}.jpg` for a photo; `.webm` OR `.m4a` for audio, matching whichever `uploadProofMedia` actually names the clip, #295) is byte-identical to one of the `storagePath` shapes the Firestore `proofs` create rule pins (`firestore.rules`), and a Firestore proof document carrying that `storagePath` plus its matching `mediaURL` is ALLOWED. Storage `okImage()`/`okAudio()` and the Firestore create regex therefore accept the same Proof object under either audio extension, so the PINNING needs no tightening—which is a claim about the two path shapes agreeing, not about the arm as a whole, whose immutability and delete clauses have since tightened for reasons of their own.
- A mismatched object—one that satisfies Storage's owner/content-type check but is not named after the target `proofId` (for example `proofs/{eventId}/{uid}/not-{proofId}.jpg`)—is ALLOWED by Storage yet DENIED by the Firestore `proofs` create rule, proving the two rulesets diverge outside the exact pinned path rather than merely agreeing on it.

## Acceptance criteria

- Given a > 8 MB image, when uploaded to a proof/avatar path, then Storage DENIES it (`okImage` cap), each proof case measured on its own fresh object path.
- Given a second upload to a proof object path that is already occupied, then Storage DENIES it whatever it carries; given a fresh path, or the same name after a delete, then ALLOWED; given `avatars/{uid}.jpg`, then an in-place overwrite is still ALLOWED.
- Given `avatars/{uid}.jpg`, when the owner writes it, then ALLOWED; a different uid's path is DENIED.
- Given a Proof delete request, when the caller is signed in but neither the object's owner nor an Event admin, then Storage DENIES it.
- Given a Proof delete request from the object's OWNER, when a Proof document still points at the object, then Storage DENIES it even on an open Event; when no Proof document does, then ALLOWED.
- Given a valid Proof object path, when checked against the Firestore Proof-create rule, then both accept it (pinning in lockstep); given a mismatched Proof object path that Storage alone accepts, Firestore DENIES pinning it (negative lockstep).
- Proof-object OWNER-delete bound to the absence of the Proof document asserted, with the orphan case beside it.
- Given a write to `og/**`, then Storage DENIES it whether the object already exists or is brand-new.
- `okImage`/`okAudio` size + MIME caps asserted.
- Proof-object immutability asserted, with the avatar arm's mutability asserted beside it.
- Avatar + Proof-object owner-only paths asserted.
- Inert `og/**` write-deny asserted.
- Storage ↔ Firestore Proof pinning cross-checked, including the negative case.
