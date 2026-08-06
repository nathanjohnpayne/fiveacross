---
spec_id: d15-claim-sheet-photo
status: accepted
---

# Claim sheet photo body—two affordances, source stamp, EXIF strip, heat line, dayIndex (`d15-claim-sheet-photo`)

Implements `plans/daily-cards-spec.md` § "Square tap—the Claim sheet" (photo body) and closes #190. First consumer of the `ProofDoc.source`/`dayIndex` and `EventDoc.settings.photoProofSource`/`stripPhotoExif` fields the schema contract (#200) added. Guarded by `src/components/d15-claim-sheet-photo.test.tsx` and `scripts/ci/check_spec_test_alignment`.

## Resolved posture (2026-07-11)

Transparency over restriction (ADR 0001). Both affordances—📷 Take photo and 🖼️ Library—are available in EVERY Claim Mode; Library is never gated on `claimMode`. The only restriction is the event-level admin override `EventDoc.settings.photoProofSource: 'camera_only'`, decoupled from Claim Mode. It is a client-presentational restriction, not a security boundary; a determined client can bypass it, and that is accepted.

## Contract

- `ProofSheet`—the photo body renders 📷 Take photo (`capture="environment"`) always, and 🖼️ Library (`accept="image/*"`, no `capture`—the `ProfileEditor` pattern) unless `photoProofSource === 'camera_only'`. The affordance the file came through is stamped as `source: 'camera' | 'library'`, from the input that fired (not EXIF). A "🔥 Marked by N others so far" heat line renders under the title from the supplied `tallyCount` when > 0. `dayIndex`/`stripExif` thread through to `attachProof`.
- `attachProof` (`src/data/proofs.ts`)—accepts `source`/`dayIndex`/`stripExif`; writes `source`/`dayIndex` on the Proof doc (null when absent) and passes `stripExif` to `uploadProofMedia`.
- `uploadProofMedia` (`src/data/storage.ts`)—takes `{ stripExif }`. For a photo it re-encodes through the `downscaleImage` canvas (the repaint drops EXIF/GPS—that IS the strip). With `stripExif` on (default) and the re-encode unavailable (decode failure → same object), it fails closed rather than upload a possibly-geotagged blob. `uploadAvatar` is untouched.
- `ProofFeed`—a `source: 'library'` Proof renders a 🖼️ badge; a `dayIndex` Proof renders a "Day N · Theme" chip (theme resolved from `EventDoc.days[dayIndex]` via `THEMES`, degrading to "Day N").
- `Board`—wires the viewed `dayIndex`, the event's `photoProofSource`/`stripPhotoExif` (defaults `camera_or_library`/`true`), and the open Square's live Tally count into `ProofSheet`.

## Frozen

The #181 Cross My Heart pledge, the audio/text bodies, `attachProof`'s transactional write set, and the Feed's non-photo rendering are unchanged.

## Acceptance criteria

- Default `camera_or_library`: both affordances render, in every Claim Mode.
- A 🖼️ Library attach commits `source: 'library'` and the Feed badges it 🖼️.
- `camera_only`: only 📷 Take photo renders, regardless of Claim Mode.
- `stripPhotoExif` true (default): a photo proof uploads with no EXIF/GPS.
