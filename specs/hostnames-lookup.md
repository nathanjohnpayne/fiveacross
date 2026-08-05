---
spec_id: hostnames-lookup
status: accepted
---

# `hostnames/{host}` — the pre-auth Event lookup and its rules (`hostnames-lookup`)

Implements [ADR 0009](../docs/adr/0009-event-resolved-from-hostname.md). One world-readable document per public address, resolvable by `get` and never by `list`, so an application can decide which Event it is serving before it has a signed-in user. Guarded by `tests/rules/hostnames-lookup.test.ts`.

This ticket owns the collection and its rules only. Consuming it at startup — parsing the hostname, caching the result, canonicalising an alias — is separate work.

## Glossary

**Hostname document** — the mapping from one public address to one Event. Keyed by the full hostname (`bodega-bay.vacaybingo.com`), not by [Slug](../CONTEXT.md), so an Event's canonical address and each of its aliases are separate documents pointing at the same Event, with the alias naming its canonical. *Avoid:* route, domain record.

## Data model

`hostnames/{host}` where `{host}` is the full lowercase hostname.

| Field | Type | Meaning |
|---|---|---|
| `eventId` | string | The Event this address resolves to |
| `canonicalHost` | string | The address this Event is actually served from; equals `{host}` on the canonical document |
| `edition` | string | Which Edition dresses this address — the only source available early enough to style the sign-in screen |
| `status` | string | `active` \| `disabled` \| `archived` |
| `slug` | string | The first label, denormalised for the edge router |
| `isCanonical` | bool | Whether this document is the canonical address or an alias |

`edition` rides here rather than on the Event document for the reason ADR 0009 gives: `events/{eventId}` requires `signedIn()`, so an Edition read from it arrives after the surface that most needs it has already rendered.

## Rules contract

```
match /hostnames/{host} {
  allow get: if true;
  allow list: if false;
  allow create, update, delete: if false;
}
```

**The get/list split is the safety property, not a stylistic choice.** `get` resolves an address the caller already knows; `list` would enumerate every Event on the platform, converting a set of unguessable addresses into a directory. `allow read` grants both and must not be used here.

**World-readable is deliberate and bounded.** A Slug is an address, not a secret: knowing one grants nothing, because every read of Event data still passes the membership gate. What is exposed is that an Event exists at a hostname the reader already typed, plus its Edition — which the branding on the page announces regardless.

**No client writes at all**, including admins. The mapping is authoritative routing state across a global namespace, where no per-Event admin has authority; a writable mapping would let a client point an existing hostname at an Event it should not see, or squat an address before its Event exists. Only the Admin SDK populates it.

**An unknown host is a missing document, not a denial.** `get` succeeds against a non-existent path and returns `exists() == false`, so a client renders an Event-not-found state instead of a permission error it would otherwise have to distinguish from a network failure.

## Acceptance criteria

- **Given** an unauthenticated client, **when** it `get`s a hostname document, **then** the read succeeds. (Test: unauth-get.)
- **Given** a signed-in client, **when** it `get`s a hostname document, **then** the read succeeds. (Test: auth-get.)
- **Given** any client, authenticated or not, **when** it queries the `hostnames` collection, **then** the read is denied. (Test: list-denied.)
- **Given** an unknown hostname, **when** a client `get`s it, **then** the read succeeds and the document does not exist — a not-found path, never an error. (Test: unknown-host.)
- **Given** any client, **when** it attempts to create, update, or delete a hostname document, **then** the write is denied — including a signed-in user and an Event admin. (Test: writes-denied, admin-write-denied.)

## Test coverage

`tests/rules/hostnames-lookup.test.ts` (rules emulator, `npm run test:rules`) — its own `projectId` so `clearFirestore()` cannot race the other rules suites under Vitest's file parallelism, matching the convention in `w1-attestation.test.ts`. Seeds fixture documents through `withSecurityRulesDisabled` (the Admin-SDK stand-in), then exercises each arm above.
