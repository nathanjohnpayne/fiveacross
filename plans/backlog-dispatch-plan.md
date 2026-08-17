# Backlog dispatch plan — 2026-08-17

Triage, prioritization, parallelization and runner assignment for every open ticket on [Project #7](https://github.com/users/nathanjohnpayne/projects/7). Plan only — nothing here is implemented; each ticket below carries a ready-to-launch runner prompt.

## Ground truth this plan is built on

**Production reality.** No Event is live today: the GCB cruise ended 2026-07-24 and Bodega Bay ran 2026-08-07..09 (PRD Phase 2 exit condition met). "Live surface" priority therefore means **production health**, not in-event hotfixes — and production health is currently red: the synthetic uptime check has been failing all day (last three runs 2026-08-17, all `failure` — #781, unsubscribe 403), and the production functions deploy hard-fails on missing env keys (#767, observed 2026-08-13). Until #767 lands and a deploy succeeds, merged fixes (including #768's unsubscribe rerouting) are not reaching production.

**PRD phase ladder** (fiveacrossbingo PRD § Migration Plan): Phase 0 (wildcard platform foundation) is *partially* done — the Worker router (#529) and centralised auth handoff (#530) were explicitly descoped from the Bodega launch via the descope ladder and remain open. Phase 1 (brand extraction) is done except community-prompt generalization (#533) and scoring policy (#531). Phase 2 (Bodega POC) is **done**. Phase 3 (multi-event isolation) is the next gate and is mostly *unfiled* (membership/invitations have no tickets — see Decisions). Phase 5 (self-service creation, epic #786) is not gate-open, but its spec/contract front (#787) is deliberately front-loadable.

**In-flight work.** Zero open PRs — nothing claims files or board slots.

**Plans-directory tickets.** Every ticket the dispatch brief listed as "possibly unfiled" has already shipped; nothing needs filing:

| plans/ ticket | Shipped as |
|---|---|
| `join-postcard-stamp-bug-ticket.md` | PR #777 (`4e0ee2c`), merged |
| `echo-marks-ticket.md` | #447 (`5fd969f`) + hardening #482 |
| `admin-messages-ticket.md` | #440 (`c1f939d`) + #456 |
| `share-cards-redesign-ticket.md` | #444/#449 (`d59e0f3a`, `292f5f0`) |
| `schedule-repair-line-quiet-controls-ticket.md` | #416 (quiet variant live in `src/index.css` + `specs/admin-console-ia.md`) |
| `reshuffle-ticket.md`, `easy-mix-ticket.md`, `schedule-correction-ticket.md`, `schedule-recovery-strip-ticket.md`, `admin-redesign-ticket.md` | `specs/reshuffle.md`, `specs/easy-mix.md`, `specs/schedule-correction.md`, #414, `specs/admin-console-ia.md` |

**Hot files** (per `plans/gaycruisebingo-parallelization.md`, extended by the wizard epic): `src/types.ts`, `firestore.rules`, `src/index.css`, `CONTEXT.md`, plus `src/App.tsx` (routes) and — new with #786 — `src/domainTypes.d.ts`. At most one dispatched ticket per wave touches each. **Phase 4 trigger paths** (`.github/review-policy.yml`): `firestore.rules`, `storage.rules`, `functions/**`, `src/auth/**`, `.github/**`, or ≥ 300 changed lines.

## 1 · Triage table

Every open issue. P0 = production health, dispatch alone and immediately. P1 = unblocked work in an active phase. P2 = unblocked standalone, not urgent. Park = superseded/stale/blocked-with-no-path (never silently — see Decisions). Human = console/DNS work with no model dispatch.

| # | Title (short) | Triage | Reasoning |
|---|---|---|---|
| #767 | Production deploy param-drift | **P0** | Production deploy hard-fails; blocks shipping every merged fix. Same defect class #730 already solved for e2e. |
| #781 | Synthetic uptime: unsubscribe 403 | **P0 (human)** | Red right now. Remediation is the idempotent invoker-restore script + a successful deploy of #768's fix; auto-closes on green. No code to write beyond #767. |
| #784 | Finale last-call window empty | **P1** | Real logic bug in `finaleTimes` for any same-date closing Day; pure function, regression-testable. Fires on the next Event, not today — P1 not P0. |
| #551 | DayDef.scoring + standingsFreezeAt | **P1** | Ready; closes the client/functions podium divergence the PRD risk table calls out; Phase 1/2 leftover. |
| #557 | Community Prompt Day targeting | **P1** | Ready; PRD Phase 1 "generalize suggestions" leftover; gate for #558/#559. |
| #671 | Edition-aware EMAIL_FROM | **P1** | Ready; shipped email families send from the wrong brand; small functions param plumbing. |
| #670 | Abuse-kind bug reports | **P1** | Ready; deferred leg of #638 with the design already written in the issue. |
| #765 | Redirect-only Google sign-in | **P1** | Decision recorded 2026-08-14 in-issue; identity track is active; two-PR sequence specified. |
| #787 | Wizard spec + data model | **P1*** | Unblocked sub-issue of #786; pure spec/contract, no UI, consumes #785. *Phase-5 gate judgement in Decisions. |
| #545 | Worker Event router | **P1** | Phase-0 leftover, corrected 2026-08-17; prerequisite for the wizard epic's usable output; dev/test unblocked (deploy waits on #539 DNS). |
| #544 | Edition on hostname doc | **P1** | Unblocked, small, feeds pre-auth branding surfaces. |
| #548 → #549 → #550 | Auth handoff chain | **P1 (sequenced)** | Phase-0 leftover (#530); #548 unblocked now; #549 after #548; #550 is the verification gate after both. #547 (console) is the human leg. |
| #689 | Player-level blocking | **P1** | Ready; Phase-3-aligned and a hard store-policy gate for Phase 7; L and rules-heavy — needs a spec sub-step first. |
| #788–#795 | Wizard shell + steps + provisioner | **P1 (blocked chain)** | Blocked per their own Blocked-by lists; enter waves as #787/#788 land. #793 (provisioner) additionally held by the epic's platform gate (#529/#530/membership). |
| #736 | Day chips tabbable behind overlay | **P2** | Real a11y/staleness bug, well analysed, narrow fix shape suggested in-issue. |
| #632 | GA4 coverage pass | **P2 (split)** | Email-UTM leg is actionable; the fiveacross-stream decision is Nathan's (Decisions). |
| #134 | Post-Event archive | **P2** | Newly timely — both Events have now ended and nothing sets `status:'archived'`. |
| #132 → #133 | Cloud Vision proof scan → auto-hide | **P2 (sequenced)** | Hardening pair; #132's region blocker resolved, needs API enablement + env flip + deploy; #133 consumes #132's flags. |
| #44 | App Check enforcement | **P2 (human-gated)** | Client scaffold shipped; remaining work is key provisioning + enforcement — console-side, plus a deploy env change. |
| #743, #769 | [error-tracking] NS_ERROR_FAILURE | **P2 (triage)** | Empty bodies, zero comments — genuinely untriaged (checked, per the pre-triage rule). One investigation pass via PostHog before any code. |
| #626 | Path-based Events on mirror hosts | **Park (decision)** | Overlaps #766's root/path decision; designing both independently guarantees a collision. Hold behind the #766 decision. |
| #604 | Leaderboard proof chips union | **Park (decision)** | Shipped-by-design vs. reporter expectation; `decision-needed` already applied — Nathan picks a side first. |
| #766 | Park Events at /eventname, root = create page | **Park (decision)** | Crosses a stated PRD non-goal and reverses a recorded rejection; explicitly a Decision for Nathan, not a build ticket yet. |
| #599 | Decision: fiveacross.app canonical | **Park (close)** | Decision made and owner-confirmed 2026-08-17; amendments propagated into #545/#546/#547/#549/#600/#630. Close as a completed decision record. |
| #537 | Create Five Across Firebase project | **Park (close)** | The project exists and served the entire Bodega POC in production. Close after a checklist spot-check. |
| #540 | PostHog proxy d.vacaybingo.com | **Park (close)** | Its own body says the ingest half moved to #578 and this proxy is now unused. Close as superseded. |
| #541 | Five Across build target | **Park (verify-close)** | Deploys to `fiveacross` demonstrably work (Bodega shipped); `.firebaserc` aliases were deliberately *removed* (#592), inverting an acceptance item. Verify DEPLOYMENT.md documents the path, then close or re-scope. |
| #538, #539, #547, #578, #600, #630 | Domains/DNS/OAuth/PostHog console work | **Human** | `human-action` console/DNS batch — grouped runbook below. #630 stays blocked until #600 completes. |
| #558, #559 | Community squares quota; entry point | **P2 (blocked)** | Both depend on #557's targeting model (derived link — being added to the board). #558 is additionally spec-first (Decisions). |
| #630 | Redirect fiveacrossbingo.com zone | **Human (blocked)** | Explicitly deferred until #600's migration completes. |
| #785 | Wizard implementation constraints | **Reference** | Not a work ticket — the durable contract extract #787+ consume. Leave open until the epic closes. |
| #527, #528, #529, #530, #531, #533, #131, #786 | Epics | **Tracking** | Stay open as containers; status flows from sub-issues. |
| #726, #736*, #738–#764, #774, #779, #780 | Post-review observation backlog (~30) | **P2 (batched sweeps)** | P2/P3 advisory findings from merged PRs. Grouped into 4 sweep lanes (below) rather than 30 dispatches; none is individually urgent. |

(*#736 is listed individually above because it is a real user-facing bug, not an advisory note.)

## 2 · Wave schedule

Target width 3–4. Hot-file column proves no intra-wave conflict; the Phase 4 column shows the external-review batch whose round-trips overlap. Within a wave, a types-first rule applies: the contract-owning ticket lands first and dependents rebase.

### Wave 0 — dispatch now, alone (P0)

| Ticket | Runner | Hot files | Phase 4 |
|---|---|---|---|
| #767 deploy-env validation | Sonnet 5 · medium | none (`scripts/**`; reads `functions/src/params.ts`) | No (keep the guard in `scripts/**`; if it must touch `functions/**`, it batches with Wave 1) |
| #781 unsubscribe 403 | **Human runbook** (below) | n/a | n/a |

Nothing waits behind Wave 0, and Wave 0 waits on nothing. #781's green rerun additionally requires a successful deploy, which #767 unblocks — same lane, same day.

### Wave 1 — P1, four lanes

| Ticket | Runner | Hot files | Phase 4 |
|---|---|---|---|
| #784 finale last-call | Sonnet 5 · medium | none (`functions/src/unlockDay.ts` + tests) | **Yes** (functions) |
| #671 EMAIL_FROM | Sonnet 5 · medium | none (`functions/src/params.ts`, `adminAlerts.ts`, `dailyEmail.ts`) | **Yes** (functions) |
| #557 prompt Day targeting | Opus 4.8 · high | **firestore.rules** (sole owner this wave) | **Yes** (rules) |
| #787 wizard spec + model | Opus 4.8 · high | **src/domainTypes.d.ts** (sole owner) | No |

No file overlap: #784 and #671 touch disjoint functions modules; #557 owns rules; #787 is spec + new pure modules. The three Phase 4 tickets form one review batch.

### Wave 2 — contract land + auth start

| Ticket | Runner | Hot files | Phase 4 |
|---|---|---|---|
| #551 scoring/freeze | Opus 4.8 · high | **src/types.ts** (sole owner); `functions/src/unlockDay.ts` *after #784 merges* — types-first within the wave | **Yes** |
| #765 redirect sign-in (2 PRs) | Sonnet 5 · high | none (`src/auth/**`) | **Yes** (auth) |
| #670 abuse-kind reports | Sonnet 5 · high | none (`functions/src/bugReport*`, `src/components/BugReport.tsx`, `src/data/bugReports.ts`) | **Yes** (functions) |
| #788 wizard shell | Sonnet 5 · high | **src/App.tsx** (sole owner) | No |

#551 explicitly rebases on #784's merged `finaleTimes`; do not dispatch #551 until #784 is merged (sequenced on the same file).

### Wave 3 — rules handoff + wizard steps

| Ticket | Runner | Hot files | Phase 4 |
|---|---|---|---|
| #689 player blocking (spec first) | Opus 4.8 · high | **firestore.rules**, **src/types.ts** (sole owner of both this wave) | **Yes** |
| #545 Worker router | Opus 4.8 · high | none (new `worker/` code; deploy gated on #539) | Likely (cross-cutting classifier) |
| #789 wizard Step 1 | Sonnet 5 · medium | none (`src/components/setup/`) | No |
| #790 wizard Step 2 | Sonnet 5 · high | none (`src/components/setup/`, new `src/slug.ts` pure module) | No |

### Wave 4 — auth functions + router consumers

| Ticket | Runner | Hot files | Phase 4 |
|---|---|---|---|
| #548 handoff mint/exchange | Opus 4.8 · xhigh | **firestore.rules** (small `authHandoffs` block; after #689 merges) | **Yes** |
| #546 per-host manifest | Opus 4.8 · high | none (`worker/`; after #545) | Likely |
| #791 wizard Step 3 | Opus 4.8 · high | none | No |
| #544 edition on hostname doc | Sonnet 5 · high | none (`src/data/hostnames.ts`, pre-auth plumbing) | No |

### Wave 5 — auth client + wizard tail

| Ticket | Runner | Hot files | Phase 4 |
|---|---|---|---|
| #549 client handoff | Opus 4.8 · high | none (`src/auth/**`; after #548) | **Yes** |
| #792 wizard Step 4 | Opus 4.8 · high | **src/index.css** if the slider extraction needs it (sole owner); after #791 | No |
| #795 preview strip | Sonnet 5 · high | none (`src/components/setup/`, scoped theme island) | No |
| #736 day-switcher inert | Sonnet 5 · medium | none (`src/components/Board.tsx`) | No |

### Wave 6+ — gated and background (sketch, re-plan at dispatch time)

- **#793 provisioner + #794 Step 5**: HOLD until #545, #548–#550 and a membership gate exist (the epic's own platform prerequisite). #793 is Opus 4.8 · xhigh, Phase 4.
- **#550 sign-in device matrix**: verification gate after #549 + #547; evidence-gathering, Sonnet 5 · medium.
- **#632 email-UTM leg** (Sonnet 5 · medium, Phase 4), **#134 archive** (Sonnet 5 · high, Phase 4), **#132 → #133 Vision** (Sonnet 5 · medium each, Phase 4, sequenced), **#743/#769 triage** (Sonnet 5 · low, PostHog investigation, no code until diagnosed).
- **Post-review sweeps** — four batched lanes, each one runner (Sonnet 5 · medium), each producing one PR per area, closing its issues with dispositions: (a) SW/update cluster #750–#758 + #726; (b) `firestoreRecovery` cluster #744–#749; (c) e2e-env cluster #738–#742; (d) singles #759–#764, #774, #779, #780.

## 3 · Runner prompts

**Standard preamble (prepend to every prompt below, substituting `<slug>`, `<issue>`):**

> Work in a fresh worktree: `git -C ~/GitHub/gaycruisebingo worktree add ~/GitHub/.gaycruisebingo-worktrees/<slug> -b feat/<slug> origin/main` (hidden folder, never a visible sibling). Run `npm install` there (plus `npm --prefix functions install` if you touch `functions/**` or run e2e); never copy `.env.local` into the worktree; `GITHUB_ACTIONS=1 npm run build` is the local build gate. Session prelude: `eval "$(scripts/op-preflight.sh --agent claude --check)"`; reads use the cached PAT, guarded writes go through `scripts/gh-as-author.sh` / `scripts/gh-as-reviewer.sh`. Board choreography per `docs/agents/ticket-workflow.md`: claim atomically (assign `nathanjohnpayne` + move to In progress via `scripts/gh-projects/move-item.sh <issue> "In progress"` + claim comment under `nathanpayne-claude`); back off if already assigned. PR body carries `Closes #<issue>`; move to In review; drive review per AGENTS.md (under-threshold → reviewer-identity approve; Phase 4 paths → `@codex review` loop, up to 10 rounds before phase-4b fallback, record 👍/👎 + resolve every thread). DoD: `npm run typecheck` · `npm test` · `npm run build` green, repo gates (`repo_lint`, `md-prose-wrap` — soft-passes without markdown-it-py, so reflow prose by hand), spec↔test alignment, conventional commit. Stop after merge + board Done + promoting newly unblocked dependents to Ready.

### Wave 0

**#767 — deploy-env validation** · Sonnet 5 · medium · slug `deploy-env-param-guard`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/767. Apply PR #730's derive-don't-hand-maintain approach to the deploy path: derive the required param set from `functions/src/params.ts` (reuse/extend `scripts/gen-functions-env.mjs`'s extraction) and validate `functions/.env.<projectId>` against it before `firebase deploy` starts, failing loudly with the missing key names. Wire it into the deploy scripts (`package.json` deploy targets / `docs/app/phase-1-deploy.md` § preflight). Remember firebase `resolveParams` partitions on env presence, not code defaults — a param with a `default:` still hard-fails non-interactive deploys. The real `functions/.env.gaycruisebingo` is untracked and machine-local: your PR ships the guard + docs + a documented remediation line naming `EMAIL_REPLY_TO` and `EMAIL_UNSUBSCRIBE_URL`; the human deploy session fixes the local file. Keep the guard in `scripts/**` to stay off Phase 4 paths. Tests: unit-test the extraction + validation against a fixture params file (drifted, complete, extra-keys cases).

**#781 — unsubscribe 403 (HUMAN RUNBOOK — no model dispatch)**

> From a deploy-capable session: (1) `scripts/set-email-unsubscribe-invoker.sh` (idempotent IAM restore, per the issue body and `docs/app/phase-1-deploy.md` § 1a-i); (2) after #767 merges, fix the local `functions/.env.gaycruisebingo` (add `EMAIL_REPLY_TO`, `EMAIL_UNSUBSCRIBE_URL`) and deploy main — this also finally ships #768's Hosting rerouting and everything merged since 2026-08-13; (3) re-run the synthetic-uptime workflow; #781 auto-closes on green. Before deploying, grep `<deployed-sha>..origin/main` for undeployed `src/**`/`functions/**` changes per the deploy-ships-all-of-main rule.

### Wave 1

**#784 — finale last-call empty window** · Sonnet 5 · medium · slug `finale-last-call-window`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/784. `finaleTimes` (`functions/src/unlockDay.ts:248`) derives `lastCallAt` forward from the preceding Day's unlock, which produces an empty `[lastCallAt, farewellUnlockAt)` interval whenever the closing Day shares a calendar date with its predecessor (the Bodega tail). Implement the issue's derive-backwards option — `lastCallAt = farewellUnlockAt - LAST_CALL_LEAD_MS` when the forward derivation lands at-or-after `farewellUnlockAt` (or unconditionally; pick the simpler defensible form and say why in the PR) — plus the durable part: an assertion/guard that the window is non-empty, logging loudly if a schedule shape ever re-empties it. Regression test pins the Bodega tail shape (two Days on 2026-08-09, closing second) asserting `lastCallAt < farewellUnlockAt`; keep all existing `finaleTimes` tests green. Pure-function change; do not touch scheduling cadence. Phase 4 (functions) — batch with #671/#557 review round-trips. Note: #551 (Wave 2) retargets `finaleTimes` anchoring; keep this fix minimal so it rebases cleanly under #551.

**#671 — Edition-aware EMAIL_FROM** · Sonnet 5 · medium · slug `edition-email-from`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/671. Both email families brand per-serving-host in the body but send From: one per-project address. Make the sender vary the same way the body already does: resolve From per Event/host through the same host→Edition resolution the renderers use (see how `functions/src/adminAlerts.ts` and `functions/src/dailyEmail.ts` pick brand copy), with `EMAIL_FROM` demoted to fallback. Wireframes' `#fx-email-registers-tri` lists Sender as a per-brand register row — that's the parity target. Mind #767's lesson: if you add params, add them to `functions/.env.example` and the derived-env guard, never a hand-list. Tests: per-host From resolution for GCB/Vacay hosts + fallback; existing email tests stay green. Phase 4 (functions), Wave-1 batch. Resend domain verification for any new From address is a human follow-up — name it in the PR body rather than blocking on it.

**#557 — Community Prompt Day targeting** · Opus 4.8 · high · slug `prompt-day-targeting`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/557 (epic #533). Add explicit Day targeting through submission → approval → snapshot: store submitter attribution, submission time, intended Day, moderation status, organiser-edited final text; an approved suggestion joins only its intended Day's snapshot; approval after cutoff rolls to the next eligible unsnapshotted Day; none left → retained for recap/pack. Hard invariants: an already-snapshotted or dealt Day is never mutated; suggestions never visible outside their Event; everything pending until approval. You own `firestore.rules` this wave (sole owner) — keep the rules diff small and covered by `tests/rules/` (Event-scoping cases per the acceptance list). Respect the Day Snapshot contract (`CONTEXT.md` § Day Snapshot; ordering mistakes silently deal wrong cards — the reason this is Opus). Spec: extend/author the community-prompts spec with matching tests. Phase 4 (rules), Wave-1 batch. On merge, promote #558/#559 Backlog → Ready.

**#787 — wizard spec + data model** · Opus 4.8 · high · slug `setup-wizard-spec`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/787 (epic #786; contract authority #785; frames `#frame-setup-*` in `plans/daily-cards-wireframes.html`). Ship `specs/event-setup-wizard.md` (frontmatter + `## Test coverage`) plus the data model only — no UI: `EventDraft` (device-local, never holds a claimed slug, schema-versioned), `OccasionDef` + the occasion→Edition/defaults matrix as data (six occasions from the frames, placeholder packs where content is unowned — epic Decision 2 stays open), and the shared validation predicates (per-assigned-pool ≥ 24 mirroring `MIN_POOL` counted per pool, closing-pool-on-final-Day, future-first-unlock, ≤ 10 Days, per-Day required fields) as pure unit-tested functions importable by Steps 3–5 and the provisioner. You own `src/domainTypes.d.ts` this wave. Honor every #785 contract fact (spicy = main-pool only; Day ≠ calendar date; `tutorial` independent of pool). Under threshold expected; no Phase 4 paths. On merge, promote #788 → Ready.

### Wave 2

**#551 — DayDef.scoring + standingsFreezeAt** · Opus 4.8 · high · slug `scoring-policy-freeze` · **dispatch only after #784 merges**

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/551 (ADR 0011). State scoring per Day, move the freeze to the Event, and align the functions podium to the client — the issue's site table (`src/game/logic.ts:770/790`, `src/data/finale.ts:39/162`, `functions/src/unlockDay.ts:218`, `functions/src/finaleContent.ts:82/91`, `src/types.ts` + converters) is the work list. Legacy docs default `scoring` from pool on read so GCB is byte-identical (regression-pin it). Add the client/functions podium parity test the PRD risk table demands: one fixture schedule fed to both. You own `src/types.ts` this wave — types commit first, dependents rebase. Rebase onto #784's merged `finaleTimes` fix before touching `unlockDay.ts`. Phase 4 (functions + types); expect the threshold.

**#765 — redirect-only sign-in** · Sonnet 5 · high · slug `redirect-sign-in`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/765 — implement the recorded decision (issue comment `decision-comment-765-2026-08-14`, read it first): one top-level `signInWithRedirect` on every same-origin-handler surface, `signInWithPopup` only as the cross-origin fallback (local dev / Auth Emulator). Two PRs in sequence per the decision's guardrails: (1) harden the redirect-return completion path; (2) flip the surfaces. `src/auth/**` — Phase 4 on both PRs; keep each small. Verify against `src/auth-domain.ts`'s host allowlist and the OAuth-client memory (redirect URIs are console-managed — flag any missing `__/auth/handler` URI to the human rather than assuming). Device-matrix caveats live in #550; note residual verification there.

**#670 — abuse-kind bug reports** · Sonnet 5 · high · slug `bug-report-kind`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/670. Add the `kind` field end-to-end exactly as the issue enumerates: `functions/src/bugReportContract.cjs` (+ `.d.cts`), `bugReportCore.ts`, `bugReports.ts` persistence, `src/data/bugReports.ts` client send, a reporter control in `src/components/BugReport.tsx`, contract-parity tests both sides — then the deferred #638 leg: admin alert when `kind === 'abuse'` arrives (follow `functions/src/adminAlerts.ts` patterns). Unknown/absent kind must validate as a plain bug (back-compat with shipped clients). Phase 4 (functions), Wave-2 batch.

**#788 — wizard shell** · Sonnet 5 · high · slug `setup-wizard-shell` · **after #787 merges**

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/788. The wizard route, five-step navigation frame, and device-local Save draft/resume, per the shared chrome of `#frame-setup-*`. One new sibling `<Route>` in `src/App.tsx` before the catch-all — you own `App.tsx` this wave; touch nothing else in it. New `src/components/setup/` directory (shell, step registry, chrome); consume #787's draft store; `src/components/tabs.ts` is frozen. Spec section + component tests per the ticket. No Phase 4 paths. On merge, promote #789/#790/#795 → Ready.

### Wave 3

**#689 — player-level blocking** · Opus 4.8 · high · slug `player-blocking` · **spec sub-step first**

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/689. Step 1 (same PR series, first commit/PR): author `specs/player-blocking.md` — reciprocal-by-default model, block-list data shape, the full shared-read-path inventory (Feed, proofs, hearts, doubts, tally markers, moments, leaderboard, avatars), rules-enforcement strategy vs. client filtering split, and unblock semantics — with matching test enumeration; get it reviewed before the enforcement PR(s). Step 2: implement, rules-enforced (not display-only), every listed surface honoring the block. You own `firestore.rules` and `src/types.ts` this wave (rebase on #551's merged types). Keep PRs under 300 lines each where possible; Phase 4 regardless (rules). This is the App Store/Play blocking gate — required independent of Phase 7.

**#545 — Worker Event router** · Opus 4.8 · high · slug `worker-event-router`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/545 (epic #529; read the 2026-08-17 corrections in-body: namespaces are `*.fiveacross.app` + `*.vacaybingo.com`, NOT `*.fiveacrossbingo.com`; the Worker is a router/namespace guard, never a canonicaliser and never authorization). One versioned Worker: slug validation, reserved labels, fail-closed unknown-Event handling, origin proxy to Firebase Hosting. New top-level `worker/` dir — document its justification in AGENTS.md § Repository Layout per code-modification rules. Wrangler-testable locally (miniflare/vitest); DNS attach (#539) and cutover are human steps — Gates 1–3 of the PRD ladder govern rollout; your deliverable ends at "deployable + tested", not "live". Expect the cross-cutting Phase 4 classifier. On merge, promote #546 → Ready.

**#789 — wizard Step 1 · Occasion** · Sonnet 5 · medium · slug `setup-step-occasion`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/789, frame `#frame-setup-occasion`. Occasion list from #787's `OccasionDef` matrix (consume, don't fork); selection commits Edition/pack/defaults visibly (Edition pill). New component under `src/components/setup/`; step tests per ticket. No hot files, no Phase 4.

**#790 — wizard Step 2 · Basics** · Sonnet 5 · high · slug `setup-step-basics`

> Ticket: https://github.com/nathanjohnpayne/gaycruisebingo/issues/790, frame `#frame-setup-basics`, contract #785. Name/dates/timezone, live slug availability, marking mode, audience. New `StepBasics.tsx`; the slug normalization + reserved-names pure module (`src/slug.ts`-style, dependency-free — #545 and #793 consume it, so keep it framework-clean); availability helper over `fetchHostnameDoc` in `src/data/hostnames.ts` (read-only). A draft never holds a slug — availability is advisory until launch. Consume #787's validators. No hot files, no Phase 4.

### Waves 4–5 (dispatch prompts to be refreshed at dispatch time against merged state)

- **#548** `auth-handoff-functions` · Opus 4.8 · xhigh · Phase 4: mint/exchange callables + `authHandoffs` rules block per the issue's acceptance list (transactional single-use, server-side expiry, origin allowlist, no token in any URL; replay/expiry/mismatch/concurrency tests). Rules edits rebase on #689.
- **#546** `worker-manifest-injection` · Opus 4.8 · high: per-hostname PWA manifest via the #545 Worker; read the struck-canonicalization note — this is now the *only* source of per-host installed identity.
- **#791** `setup-step-squares` · Opus 4.8 · high: pack seeding, prompt CRUD, live per-pool ≥ 24 gate; rhyme with `PromptPool.tsx`, draft-only writes.
- **#544** `hostname-edition-plumbing` · Sonnet 5 · high: `edition` on `hostnames/{host}` + pre-auth surface plumbing with safe fallback.
- **#549** `auth-handoff-client` · Opus 4.8 · high · Phase 4 (`src/auth/**`): client half + `VITE_AUTH_MODE` escape hatch; target origin = the serving host sign-in began on (no canonicalization step — see the 2026-08-17 amendment).
- **#792** `setup-step-look` · Opus 4.8 · high: unlock times, themes, place/tonight, free space, Daily mix; extract `EasyMixSlider` shared component without breaking `GameSettings` tests; owns `src/index.css` if needed.
- **#795** `setup-preview-strip` · Sonnet 5 · high: Edition-skinned preview via a scoped theme island that must not disturb the app-global `ThemeContext`/`data-theme` contract.
- **#736** `day-switcher-inert` · Sonnet 5 · medium: thread `overlayOpen` to `daySwitcher` as its own disabled/inert prop (the issue's narrower option); RTL coverage for every early-return branch.

## 4 · Human-action runbook (Nathan — console/DNS batch, one sitting)

1. **#781 remediation** (P0): invoker script + deploy after #767 — see Wave 0.
2. **#539** wildcard DNS + 7 reserved labels on both namespaces (Cloudflare).
3. **#538** exact custom domains `bodega-bay.fiveacross.app` gate-1 pattern + `auth.fiveacross.app` on the fiveacross project (certs take up to 24h — do early).
4. **#547** `auth.fiveacross.app` authorized domain + `https://auth.fiveacross.app/__/auth/handler` redirect URI (per the 2026-08-17 correction — NOT `auth.fiveacrossbingo.com`). Batch with #600 step 3 in one console visit.
5. **#600** steps 1–4 (DNS CNAME, Hosting custom domain, OAuth redirect URI, authorized domain); step 5 (hostnames doc) is agent-scriptable afterward.
6. **#578** PostHog managed reverse proxy at `d.fiveacross.app` + CNAME.
7. **#630** stays blocked until #600 completes.
8. **#44** reCAPTCHA Enterprise key provisioning when hardening gets scheduled.

## 5 · Decisions for Nathan

1. **Close-as-done/superseded (approve the batch):** #537 (project exists, served Bodega), #540 (superseded by #578, per its own body), #599 (decision made + propagated 2026-08-17), #541 (verify DEPLOYMENT.md first — its `.firebaserc`-alias acceptance item was deliberately inverted by #592).
2. **#766 root/path parking + #626 mirror paths** — one combined decision, explicitly flagged in both issues as crossing a PRD non-goal / a recorded rejection. Until decided, both stay parked; nothing in Waves 0–5 conflicts with either outcome.
3. **#604 proof chips** — union-of-types vs. latest-proof-by-design. One-line answer unblocks an XS ticket (or a wontfix close).
4. **#632 fiveacross GA4 stream** — "decide, don't inherit": create a GA4 stream for the fiveacross project or record that PostHog is sufficient. The email-UTM leg proceeds regardless (Wave 6+).
5. **Phase-gate judgement I made (review it):** the wizard epic (#786) is PRD Phase 5 and Phase 3 (isolation) hasn't started, but I scheduled the *client-side* wizard chain (#787–#792, #795) anyway because it is genuinely unblocked, was filed by you two days ago (intent signal), and its provisioner (#793) — the only piece that makes real Events — stays held behind #529/#530/membership. If you'd rather sequence strictly by phase, pull #787+ out of Waves 1–5 and the auth/router chain fills the width.
6. **Phase 3 has no tickets.** Membership/invitations/rules-isolation (the Phase 3 exit condition) exists only as PRD prose. Filing that epic + sub-issues is the single highest-leverage backlog gap; recommend a spec-first epic filing session (I did not file these — scoping them is product work, not derivable mechanically).
7. **#558 spec-first override:** stamped Opus · xhigh (deal-path invariants); per the dispatch policy anything Opus-high-without-spec gets a spec sub-step — its launch prompt must start with a `specs/community-squares-quota.md` extension before touching the dealer. Blocked on #557 regardless.
8. **Runner overrides recorded:** #765 unstamped → Sonnet 5 · high (M, decision + guardrails already written; auth sensitivity handled by the two-PR split + Phase 4, not by model size). #671/#670 unstamped → Sonnet 5 medium/high per the matrix. #767/#784 → Sonnet 5 medium (enumerated causes, pinned oracles). All stamped tickets keep their stamps (#557/#787/#551/#689/#545/#546/#548/#549/#791–#793 Opus; #544/#550/#559/#788–#790/#794/#795 Sonnet).

## 6 · Board updates

**Done with this plan (native GitHub blocked-by dependency links, author-attributed):** #558 ← #557, #559 ← #557, #546 ← #545, #549 ← #548, #550 ← #549, #630 ← #600, #133 ← #132, #788 ← #787 (chain links #789–#795 were already present in-body).

**Pending — needs the op-preflight author PAT (the keyring OAuth token lacks the `project` scope, and refreshing the 1Password cache prompts biometrics, so it waits for a human-present session).** Run once, then the block below:

```bash
eval "$(scripts/op-preflight.sh --agent claude --mode all)" && \
for pair in "790 Backlog" "791 Backlog" "792 Backlog" "793 Backlog" "794 Backlog" "795 Backlog" \
            "767 Ready" "784 Ready" "787 Ready" "765 Ready" "544 Ready" "545 Ready"; do \
  set -- $pair; PROJECT=7 OWNER=nathanjohnpayne REPO=nathanjohnpayne/gaycruisebingo \
    GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT" scripts/gh-projects/move-item.sh "$1" "$2"; done
```

- #790–#795 sit in **No Status** (added without the unconditional Backlog move the ticket workflow mandates) → **Backlog**.
- Dispatch-ready promotions → **Ready**: #767, #784, #787, #765, #544, #545 (already Ready: #551, #557, #670, #671, #689, #578, #538, #539).
- Nothing new filed: every plans/-directory ticket named by the dispatch brief is verifiably shipped (table in § Ground truth).
