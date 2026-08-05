---
status: accepted
---

# One repository, two production Firebase projects: Five Across is a new project, not a new tenant

The existing Firestore and Storage rules give **path scoping, not tenant isolation** — any signed-in account can read every Event's doc, items, players, active proofs, tally, doubts, and moments, and proof media under `proofs/{eventId}/{uid}/{file}` is likewise readable by path (see [x-multi-event-schema](../../specs/x-multi-event-schema.md) § "Rules / indexes / hosting implications"). Sequential Events within one community could accept that; an adults-only cohort and an unrelated general-audience group cannot. Rather than land the full membership-isolation workstream under a three-day deadline, Five Across begins on a **new production Firebase project** while Gay Cruise Bingo stays on `gaycruisebingo`. Both are deployment targets of this same repository, with the same source, tests, and release process — this is a data boundary, not a fork.

The reason is the read-scope gap, **not brand positioning**. Brand positioning alone never justifies a new project.

## Consequences

- Two `.env.local` files, two `.firebaserc` aliases (`gaycruisebingo` and `fiveacross`), and two deploy runs. The Vite blank-API-key guard applies to both.
- **Always pass the project explicitly.** `.firebaserc`'s `default` remains `gaycruisebingo`, and `scripts/firebase/op-firebase-deploy` falls back to that default when no project id is given — so a Five Across deploy run without one would publish to the legacy project, defeating the very boundary this ADR creates. Use `op-firebase-deploy fiveacross …`; the named aliases exist so the id is a word rather than a guess.
- Blaze billing, first-time API enablement, and a cold Functions deploy are one-time costs on the new project. App Check is opt-in via `VITE_RECAPTCHA_SITE_KEY` and can start unset.
- Bodega players have **no access path** to Gay Cruise Bingo data, and vice versa — the property the isolation workstream would otherwise have had to prove.
- Analytics deliberately does *not* split: one PostHog project carries `brand_id` / `edition_id` / `event_id` dimensions, because cross-event comparison is the question the platform exists to answer. A second managed reverse proxy (`d.vacaybingo.com`) keeps the old brand's hostname out of the new edition's network traffic.
- The projects may collapse into one only after non-self-writable membership and two-cohort isolation tests land. Additional projects after that need a contractual, ownership, or compliance reason.
