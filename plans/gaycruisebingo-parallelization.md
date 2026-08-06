# Gay Cruise Bingo—Parallelization Plan (DAG · Waves · Hot Files · Claim Protocol)

How multiple agents run the [backlog](gaycruisebingo-backlog.md) in parallel without colliding. Each ticket is sized to a **single PR** and scoped to disjoint files where possible; the shared/hot files are serialized behind owner tickets.

## Waves

A Wave is a dependency depth, not a phase. Wave 0 is the foundation that unblocks everything; higher waves depend on lower ones. Tickets **within** a wave are mutually independent unless an explicit dependency says otherwise, so they can be claimed in parallel.

- **Wave 0—Foundation.** `w0-test-harness`, `w0-type-contract`, `w0-app-shell` (no deps → **Ready** now); `w0-firestore-rules`, `w0-storage-rules`, `w0-offline-persistence` (depend on the harness). Owns the shared contract files (types, routes, rules, firebase init, test infra).
- **Wave 1—Identity & core play.** Auth, 18+ attestation, profile/avatar, event seed; Board deal/join, Mark/win, prompt pool, themes, PWA.
- **Wave 2—Social core.** Tally, Proof, Doubts, Feed/Moments, Leaderboard, Share Cards, admin/moderation console, GA4, the two Phase-0 reconciliations.
- **Wave 3—Remaining social + hardening.** Claim Modes, security hardening, e2e happy-path.
- **Wave 4—Phase 1 backend & infra, then Phase 2 hardening.** Phase 1 (largely merged): server-authoritative report-count hide, domain/SSL, Blaze/budget. **Phase 2 hardening** (epic #131): Cloud Vision re-enable (`p2-vision-proof` → `p2-vision-moderation`), `w4-app-check`, `p2-archive`; plus launch checklist and multi-event schema.

## Dependency DAG

Read `A → B` as "A blocks B" (B depends on A). Independent roots can start immediately.

```
w0-test-harness ─┬─> w0-firestore-rules ─┬─> w1-board-deal-join ─> w1-board-mark-win ─┬─> w2-tally ─┬─> w2-doubts
                 │                        │                                            │             └─> (satisfied-by Proof)
                 ├─> w0-storage-rules     ├─> w1-prompt-pool ─────> w2-admin-console ──┤
                 └─> w0-offline-persist ──┘                                            ├─> w2-proof-capture ─┬─> w2-feed-moments
                                                                                       │                     └─> w2-doubts
w0-type-contract ─┬─> w1-adult-attestation                                            ├─> w2-leaderboard ───> w2-share-cards
                  ├─> w1-event-seed                                                    └─> w2-share-cards
                  ├─> w1-board-deal-join
                  └─> w2-tally / w3-claim-modes

w0-app-shell ─┬─> w1-auth-google ─┬─> w1-adult-attestation
              │                   ├─> w1-profile-avatar
              │                   └─> w4-app-check
              ├─> w1-prompt-pool
              ├─> w1-themes
              ├─> w1-pwa
              └─> w2-ga4-events

w2-admin-console ─┬─> w3-claim-modes         w2-share-cards ─> recon-share-og
                  └─> w4-phase1-functions     recon-recompute-stats (independent)

w1-board-mark-win + w2-leaderboard + w0-test-harness ─> x-e2e-happy-path ─> x-launch-checklist
w0-firestore-rules ─> w3-security-hardening
w4-infra-domain, w4-infra-blaze-budget, x-multi-event-schema: independent (near-launch)
p2-vision-proof ─> p2-vision-moderation   (Phase 2; p2-vision-proof reverses the #126 Vision gate; both build on the merged w4-phase1-functions autohide + w4-infra-blaze-budget Blaze)
w2-leaderboard + w2-feed-moments ─> p2-archive   (Phase 2; post-sailing freeze + hall of fame)
x-decisions-needed ─(soft)─> w1-event-seed, w2-admin-console, w4-app-check, w4-infra-blaze-budget, w4-infra-domain, w2-ga4-events, recon-recompute-stats
```

**Ready queue at kickoff (Wave-0, unblocked):** `w0-test-harness`, `w0-type-contract`, `w0-app-shell`. Set to `Ready`; everything else starts `Backlog`. When `w0-test-harness` merges, move `w0-firestore-rules` / `w0-storage-rules` / `w0-offline-persistence` to `Ready`; when the Wave-0 owners merge, promote the unblocked Wave-1 set, and so on.

## Hot / shared files—serialize behind an owner ticket

The contention risk is not the count of tickets but the count of tickets touching the **same** file. These files are touched by many tickets; each has a single **owner** ticket that lands its shape first, after which other tickets extend it in disjoint regions (or are sequenced).

| Hot / shared file | Owner ticket | Serialization rule |
|---|---|---|
| `src/types.ts` | **w0-type-contract** | Owner lands the full contract (rename, dead-config drop, new social types). Later tickets add only their own narrow fields; no two open PRs edit `types.ts` in the same wave. |
| `src/App.tsx` (routes) + `src/components/Nav.tsx` (tabs) | **w0-app-shell** | Owner establishes all five tab routes as stable mount points. Feature tickets fill their own tab component and do **not** edit `App.tsx`/`Nav.tsx`. |
| `firestore.rules` | **w0-firestore-rules** | Owner lands all Phase-0 collections + tests. `w1-adult-attestation`, `w3-security-hardening`, `w4-phase1-functions` make small, sequenced edits (each < 300 lines; `needs-phase-4`). |
| `storage.rules` | **w0-storage-rules** | Owner + tests; `recon-share-og` removes only the inert `/og/**` block. |
| `src/firebase.ts` | **w0-offline-persistence** | Owner changes Firestore init; `w4-app-check` only toggles the already-scaffolded App Check (no overlap). |
| `firebase.json` | **w0-test-harness** (adds `emulators`) | Sequenced: harness adds the emulators block; `recon-share-og` removes the `/s` rewrite; `w4-phase1-functions` touches `functions` config. Land in wave order to avoid three-way conflict. |
| `src/data/api.ts` | **w1-board-mark-win** (mark write path) | `w2-tally`/`w2-doubts` extend `setMark`'s write set **after** the mark ticket merges; declared as explicit deps. |
| `src/analytics.ts` | **w2-ga4-events** | Owns the event catalog; `w1-pwa` (`install_pwa`) and `w2-doubts` (`demand_proof`) add one call site each, coordinated via the catalog ticket. |
| `src/theme/*` | **w1-themes** | Single owner; no other ticket edits themes. |

Rule of thumb for an agent: **if your ticket must edit a hot file whose owner ticket is not yet merged, it is not Ready—wait or coordinate.** The board's `Depends on` edges encode this; do not start a ticket whose dependency is still open.

## Protected-path / over-threshold tickets (`needs-phase-4`)

Keep these PRs small (< 300 changed lines) so review stays tractable, and expect external (Phase 4) review:

- Auto-escalated by path today (`src/auth/**`): `w1-auth-google`, `w1-adult-attestation`.
- Security/backend-sensitive (mark `needs-phase-4`, keep small—not auto-escalated unless ≥ 300 lines): `w0-firestore-rules`, `w0-storage-rules`, `recon-recompute-stats`, `w3-security-hardening`, `w4-phase1-functions`, `w4-app-check`, `w4-infra-domain`, `w4-infra-blaze-budget`, `p2-vision-proof`, `p2-vision-moderation`, `p2-archive`. (Note: `firestore.rules` / `storage.rules` / `functions/**` are now in `external_review_paths`, so the `functions/`- and rules-touching ones also auto-escalate regardless of size.)
- `w3-security-hardening` proposes adding `firestore.rules` / `storage.rules` / `functions/**` to `external_review_paths` so these auto-escalate in future.

## Claim protocol (so agents don't double-pick)

The repo has **no** built-in claim convention, so this backlog defines one (also encoded in [`docs/agents/ticket-workflow.md`](../docs/agents/ticket-workflow.md)):

1. **Pick** a ticket whose Status is `Ready` and whose every `Depends on` is `Done`. Never pick `Backlog`.
2. **Claim atomically**: self-assign the issue **and** set Status → `In progress` in the same step, then post a one-line comment "claiming—<agent identity>". If two agents race, the second to assign backs off (assignee already set) and picks another `Ready` ticket.
3. **Branch**: `feat/<slug>` off `main` (never push to `main`).
4. **Open the PR** with `Closes #<issue>`; set Status → `In review`. The project's built-in "item added / reopened" workflow handles `Backlog`; the `Closes` link + merge drive `Done`.
5. **Merge** as `nathanjohnpayne` after review clears; Status → `Done` (auto via the closed-issue workflow, verified manually).
6. **On merge of a Wave-N owner**, whoever merges promotes the now-unblocked dependents from `Backlog` → `Ready`.

One agent = one in-progress ticket at a time is the safe default; an agent may hold at most one hot-file owner ticket open at once.

## Suggested parallel lanes (illustrative, 3–4 agents)

- **Lane A (foundation/security):** w0-test-harness → w0-firestore-rules → w0-storage-rules → w3-security-hardening → w4-phase1-functions.
- **Lane B (types/play):** w0-type-contract → w1-board-deal-join → w1-board-mark-win → w2-tally → w2-doubts.
- **Lane C (shell/identity/UI):** w0-app-shell → w1-auth-google → w1-adult-attestation → w1-profile-avatar → w1-themes → w1-pwa.
- **Lane D (social/moderation, after Wave 1):** w2-proof-capture → w2-feed-moments → w2-leaderboard → w2-share-cards → w2-admin-console → w3-claim-modes → recon-share-og / recon-recompute-stats.
- **Infra/launch** (w4-infra-*, x-*) fold in near launch; **x-decisions-needed** is human-triaged first and unblocks the gated few.
