---
spec_id: proof-media-token-revocation
status: accepted
---

# Proof-media token revocation

The reusable server primitive for #1534 implements part of #806 Decision 6's accepted direction; D6 remains open for staging evidence. It strips `firebaseStorageDownloadTokens` and sets `private, no-store, max-age=0` in one metadata update conditional on the object's metageneration. A `412` restarts from fresh metadata; eight consecutive conflicts fail retryably. Missing objects count as done. Clean objects need no write. Byte generation and unrelated metadata, including moderation holds, remain unchanged.

`sweepProofMediaTokens` processes the complete `proofs/{eventId}/` prefix, including photos, thumbnails, audio and held objects. Callers supply a non-secret operation identifier: retry with the same identifier to resume, and use a fresh identifier for a later revocation. The bucket, Event and operation identify a server-only `proofMediaTokenSweeps` progress record. It carries a listing cursor, processed-object count, revision and pending/complete status. A failed page leaves its cursor pending; repeating that page skips already-clean objects. Transactional revision comparison prevents concurrent workers from advancing or counting the same page twice. Complete is published only after an exhausted listing and successful processing of every returned object.

This proves the objects encountered by the sweep were clean when processed. A caller can still mint a token after an object's pass; preventing later minting and proving old URLs fail belong to the remaining #806 implementation and staging gate. The sweep cannot recall previously downloaded or cached bytes. It performs no object deletion and deploys no trigger. Building this module authorizes no production run.

## Test coverage

`tests/functions/proof-media-token-revocation.test.ts` covers policy parity, token stripping, metadata preservation, concurrent mint/write conflicts, missing objects, paging, crash recovery, repeat operations, concurrent workers, bounded contention and Event confinement. The Rules layer denies browser access to progress records.
