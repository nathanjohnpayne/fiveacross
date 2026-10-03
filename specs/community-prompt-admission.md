---
spec_id: community-prompt-admission
status: accepted
---

# Community Prompt admission

The owner decision for #1311 admits ten live pending Community Prompts per Player per Event through `submitPrompt` (ADR 0017). Creation text is trimmed and must contain 1–80 characters; `spicy` is boolean. Ownership, pending status, main pool, zero reports, server creation time and default target are supplied by the server. Payload ownership, timestamps, status and target overrides grant no authority. Admission uses the current Event and materialized membership policy; closed/archiving Events deny new gameplay submissions. Existing banned-submitter eligibility is preserved; this ticket does not add a new ban policy.

Inside one transaction, read the Event, required membership, requested item and per-Player sequence fence, then a live two-equality pending query bounded to ten rows. At ten or above refuse with `resource-exhausted` without writes. Otherwise create the item and bump the fence atomically. Approval and rejection free capacity because counts are live. Existing over-cap rows are neither deleted nor edited. Different Players use different fences; there is no shared Event counter.

Same-ID retries on a caller-owned row return its existing target without changing content, status, creation time or capacity, including when the Event closes after a lost response. Event existence and current materialized admission are still required; closed Events deny new IDs. Foreign ownership collisions are refused. The server resolves the default target with the established shared routing helper and its current clock; no client timestamp backdating or target forging. Firestore failures return fixed safe retry copy, never SDK messages or user text in logs.

The first source PR is dark: the old client/Rules path stays active and can still bypass this cap. A separate dependent PR replaces submission with a signal-required callable and denies all client pending creates, including stale bundles. That cutover preserves typed text on network failure and offline Marks. Before deployment, read the real per-Player pending distribution and obtain owner approval; source tests do not prove deployed enforcement. The new declared `SUBMIT_PROMPT_APP_CHECK` param requires an explicit `SUBMIT_PROMPT_APP_CHECK=false` entry in both gitignored `functions/.env.gaycruisebingo` and `functions/.env.fiveacross` (or the selected project’s merged Functions dotenv files). The false source default does not satisfy the non-interactive param-coverage guard. Those environment edits and deployment are separate authorized configuration actions; this source PR neither performs nor verifies them.

`tests/functions/submit-prompt.test.ts` pins boundary rejection before Admin path construction and fixed error handling. `tests/rules/community-prompt-admission.test.ts` exercises the actual Admin transaction against the emulator: cap edges and retained over-cap rows, same-ID retries, concurrent final-slot submissions, review freeing capacity, membership/archive gates and server routing/stamps.
