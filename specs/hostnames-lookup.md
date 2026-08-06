---
spec_id: hostnames-lookup
status: accepted
---

# `hostnames/{host}`—the pre-auth Event lookup and its rules (`hostnames-lookup`)

Implements [ADR 0009](../docs/adr/0009-event-resolved-from-hostname.md). One world-readable document per public address, resolvable by `get` and never by `list`, so an application can decide which Event it is serving before it has a signed-in user. Guarded by `tests/rules/hostnames-lookup.test.ts`.

This ticket owns the collection and its rules only. Consuming it at startup—parsing the hostname, caching the result, canonicalising an alias—is separate work.

## Glossary

**Hostname document**—the mapping from one public address to one Event. Keyed by the full hostname (`bodega-bay.fiveacross.app`), not by [Slug](../CONTEXT.md), so an Event's canonical address and each of its aliases are separate documents pointing at the same Event, with the alias naming its canonical. *Avoid:* route, domain record.

## Data model

`hostnames/{host}` where `{host}` is the full lowercase hostname.

| Field | Type | Meaning |
|---|---|---|
| `eventId` | string | The Event this address resolves to |
| `canonicalHost` | string | The address this Event is actually served from; equals `{host}` on the canonical document |
| `edition` | string | Which Edition dresses this address—the only source available early enough to style the sign-in screen |
| `status` | string | `active` \| `disabled` \| `archived` |
| `slug` | string | The first label, denormalised for the edge router |
| `isCanonical` | bool | Whether this document is the canonical address or an alias |
| `preview` | map (optional) | The sign-in gate's Event-preview slice (#647): `{ eventName, dateRange?, hostedBy?, days?: [{date, title, emoji?}] }`—display copy only, read fail-soft (`coerceEventPreview`, src/eventPreview.ts); absent means the gate draws no card |

`edition` rides here rather than on the Event document for the reason ADR 0009 gives: `events/{eventId}` requires `signedIn()`, so an Edition read from it arrives after the surface that most needs it has already rendered. `preview` (#647) rides here for the same reason: the wireframes' Join frame draws the Event's name, dates, host and Day line on the sign-in screen itself, which renders before any authenticated read is possible.

## Rules contract

```
match /hostnames/{host} {
  allow get: if true;
  allow list: if false;
  allow create, update, delete: if false;
}
```

**The get/list split is the safety property, not a stylistic choice.** `get` resolves an address the caller already knows; `list` would enumerate every Event on the platform, converting a set of unguessable addresses into a directory. `allow read` grants both and must not be used here.

**World-readable is deliberate and bounded.** A Slug is an address, not a secret: knowing one grants nothing, because every read of Event data still passes the membership gate. What is exposed is that an Event exists at a hostname the reader already typed, plus its Edition—which the branding on the page announces regardless—plus, when the document carries a `preview` slice (#647), the display copy the sign-in page itself shows to anyone who loads that hostname: the Event's name, its date range, the host's display name, and the Day schedule's titles. That is a real widening of the disclosure relative to the original contract, accepted deliberately with the postcard design (wireframes § "Join—the postcard, not the casino"): every field in the slice is copy the signed-out gate renders on screen, so the document discloses nothing the page does not. Nothing rules-gated may be moved into `preview`; membership, rosters, pools and everything else on the Event document stay behind `signedIn()`.

**No client writes at all**, including admins. The mapping is authoritative routing state across a global namespace, where no per-Event admin has authority; a writable mapping would let a client point an existing hostname at an Event it should not see, or squat an address before its Event exists. Only the Admin SDK populates it.

## Bodega postcard provisioning

The Bodega sign-in postcard is public display copy on the same pre-auth lookup; it must exist on **every serving Bodega hostname**, never only on the canonical host. `scripts/provision-bodega-preview.mjs` is the controlled Admin-SDK maintenance path. It validates the fixed live set (`bodega-bay.fiveacross.app`, `bodega-bay.vacaybingo.com`, and `fiveacross.app`) before it writes anything, refuses missing, inactive, or repointed documents, and applies only `preview` in one transaction. It never creates a routing document or changes `eventId`, `status`, or canonical metadata.

Run its dry run and then its explicit apply **before** deploying the postcard UI:

```bash
eval "$(scripts/op-preflight.sh --agent codex --mode deploy)"
GOOGLE_CLOUD_PROJECT=fiveacross npm run provision:bodega-preview
GOOGLE_CLOUD_PROJECT=fiveacross npm run provision:bodega-preview -- --apply
```

The command refuses any project other than `fiveacross`; no default Firebase target is trusted. It is idempotent when all three documents already carry the exact preview. `src/test/bodega-preview-provision.test.ts` proves its all-host plan and fail-closed validation.

**An unknown host is a missing document, not a denial.** `get` succeeds against a non-existent path and returns `exists() == false`, so a client renders an Event-not-found state instead of a permission error it would otherwise have to distinguish from a network failure.

## Acceptance criteria

- **Given** an unauthenticated client, **when** it `get`s a hostname document, **then** the read succeeds. (Test: unauth-get.)
- **Given** a signed-in client, **when** it `get`s a hostname document, **then** the read succeeds. (Test: auth-get.)
- **Given** any client, authenticated or not, **when** it queries the `hostnames` collection, **then** the read is denied. (Test: list-denied.)
- **Given** an unknown hostname, **when** a client `get`s it, **then** the read succeeds and the document does not exist—a not-found path, never an error. (Test: unknown-host.)
- **Given** any client, **when** it attempts to create, update, or delete a hostname document, **then** the write is denied—including a signed-in user and an Event admin. (Test: writes-denied, admin-write-denied.)

## Test coverage

`tests/rules/hostnames-lookup.test.ts` (rules emulator, `npm run test:rules`)—its own `projectId` so `clearFirestore()` cannot race the other rules suites under Vitest's file parallelism, matching the convention in `w1-attestation.test.ts`. Seeds fixture documents through `withSecurityRulesDisabled` (the Admin-SDK stand-in), then exercises each arm above.
