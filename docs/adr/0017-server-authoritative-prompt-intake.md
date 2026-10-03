---
status: accepted
implemented: partial
---

# Server-authoritative Community Prompt intake

The owner selected [Option A for #1311](https://github.com/nathanjohnpayne/fiveacross/issues/1311#issuecomment-5963609807): a `submitPrompt` callable admits at most ten live pending Community Prompts per Player per Event. The server counts current rows inside the creation transaction and reads/writes a per-Player `promptQuota/{uid}` sequence fence. The sequence is a conflict witness, never a quota counter; approval/rejection frees capacity through the next live count, with no decrement trigger or backfill. Existing over-cap rows stay intact and reviewable. No per-Event cap setting is introduced.

Auth, optional App Check and the existing membership/archive admission contract apply before submission. IDs use the canonical bounded Firestore segment validator. A caller-owned existing ID acknowledges a lost-response retry without altering the existing row, even after review or at capacity; a foreign ID collision fails. The server supplies the creation instant and shared default target routing. Client-owned Mark credit stays unchanged (ADR 0001).

Ship two source PRs: first the callable dark, with the existing client and pending-create Rules unchanged; then the dependent client and Rules cutover, closing stale-client direct pending creates. The dark PR alone does not enforce the cap on all production submissions. Deploy and verify callable reachability before authorizing the client/Rules cutover. This source work does not authorize production writes or deployment.

Prompt submission after cutover requires signal: keep typed text on failure and say to retry with signal; do not promise a queued submission. Offline Marks and their durable queued writes retain ADR 0006. Before any deployment, perform the owner-required read-only real pending-queue distribution check, assess whether legitimate contributors commonly need more than ten, and obtain separate deployment authorization. Issued media URLs and privacy policy decisions are independent.

For the callable release, separately authorize and verify `SUBMIT_PROMPT_APP_CHECK=false` in each selected project’s merged Functions dotenv files (`functions/.env.gaycruisebingo` and `functions/.env.fiveacross` for the two current projects). The declared false default does not exempt the name from Firebase’s non-interactive param-coverage guard. No environment file is modified by this source work.
