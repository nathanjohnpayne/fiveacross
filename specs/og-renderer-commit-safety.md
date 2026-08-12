---
spec_id: og-renderer-commit-safety
status: accepted
---

# OG renderer: fail-closed size cap and atomic multi-destination commit (`scripts/og/render-og-editions.mjs`)

`render-og-editions.mjs` (#699, #713) generates the per-Edition link-unfurl artwork (`public/og-{gcb,vacay,fiveacross}.png` and their byte-identical `plans/og-images/` mirrors) from `scripts/og/og-edition.html`. Two behavioral guarantees govern how a render is allowed to reach those committed destinations, documented for operators in `docs/app/og-artwork.md`: a render that would ship a broken link preview must never replace a committed one, and `--all` must update every targeted Edition or none of them, never a partial set.

The mechanism lives across four small modules the render script composes, each independently testable without booting Playwright: `og-size-guard.mjs` (the hard cap), `og-scratch-path.mjs` (per-invocation-unique staging paths), `og-stage-commit.mjs` (atomic staged commit with rollback), and `og-commit-lock.mjs` (cross-process serialization over the destination set). Nothing else in the repo currently writes to `public/og-*.png` or `plans/og-images/*-og.png`, so this spec's contract binds this one caller — but it binds any future one too, per the note in `docs/agents/code-modification-rules.md`.

## Every render must clear the hard cap before it can replace a committed copy

WhatsApp caps `og:image` at 600 KB. A render lands in a per-destination scratch file first; only a render whose final bytes (after an optional pngquant pass) clear the cap is allowed to become the committed `public/og-*.png` / mirror pair.

- **Given** a render whose final bytes exceed the 600 KB hard cap even after quantisation **when** `assertWithinHardCap` runs **then** it throws and the caller deletes the scratch file before any committed destination or mirror is touched. (Test: "throws — without writing anything — when the final render is still over budget".)
- **Given** a render at or exactly on the cap **when** the same check runs **then** it passes through and staging proceeds. (Tests: "passes through a render within the hard cap", "passes through a render exactly at the hard cap".)
- **Given** a failure **when** the error is read by an operator or CI **then** it names the Edition and both the measured and cap byte counts. (Test: "names the Edition and both sizes in the failure so it is actionable from CI logs".)

## `--all` commits every targeted Edition or none of them

`render-og-editions.mjs` stages every targeted Edition to its own scratch path and calls `commitStaged` only once every targeted Edition has individually cleared the hard cap. A failure at any point before that — a later Edition's hard cap, a degraded font load — must leave every already-staged Edition uncommitted.

- **Given** `--all` targets multiple Editions and a later one fails its hard-cap or font-integrity check **when** the run ends **then** no earlier Edition's `public/` destination or mirror has been replaced, and every staged scratch file is removed. (Test: `discardStaged` "deletes every staged scratch file without touching any destination".)
- **Given** the commit phase itself fails partway through the staged list (a mirror directory going unwritable, a rename failing) **when** `commitStaged` unwinds **then** every destination/mirror it had already touched in this call is restored to its pre-commit bytes — an entry that existed before the commit gets its original bytes back, one that did not exist is removed rather than left behind. (Tests: "restores every already-committed destination and mirror to their pre-commit bytes when a later entry fails", "removes a newly-created destination and mirror that had no prior version, rather than leaving them behind".)
- **Given** two invocations both target the same destination and stage independently **when** their scratch writes happen **then** neither invocation's staged bytes are visible to or overwritten by the other — scratch paths are unique per invocation (pid + random token), not a pure function of the destination. (Test: "keeps two invocations' staged bytes independent even though both target the same dest".)

## Concurrent invocations never interleave one destination's commit

Two `render-og-editions.mjs` processes can legitimately target the same destination at once (a manual preview racing a scheduled `--all`, or two overlapping `--edition` runs). `render-og-editions.mjs` acquires a lock on every destination it is about to commit, in a fixed (sorted) order, and holds every one of those locks for the whole commit-or-rollback phase — not just a single file touch — before `commitStaged` is ever called.

- **Given** two invocations race to commit the SAME destination **when** either reaches its commit phase **then** the second is blocked until the first releases, so their rename+copy pairs (and their rollback backups) never interleave. (Tests: "a second acquire on an already-locked destination times out instead of proceeding", "WITH the lock, no two workers are ever inside the critical section at the same time".)
- **Given** no lock is held at all **when** the same two invocations race **then** they CAN observe each other mid-critical-section — proving the race the lock closes is real, not hypothetical. (Test: "WITHOUT the lock, workers CAN be inside the shared critical section at the same time — proving the race is real".)
- **Given** a lock's owning process has died, or the lock has sat longer than any real commit takes **when** a waiter polls **then** the lock is stolen so a crashed renderer never bricks a future commit to that destination — but a lock still owned by a live, on-time holder is never stolen. (Test: "steals a lock file left by a process that is no longer running".)
- **Given** a lock is judged stale and about to be stolen **when**, in the window between that decision and the delete, another waiter has released-and-republished a brand-new healthy lock at the same path **then** the steal must not delete that replacement — ownership is re-verified by filesystem identity (`dev`+`ino`), not just by re-reading pid/mtime, immediately before the unlink, and a mismatch backs off instead of deleting. (Test: "does not delete a healthy lock a waiter just published in that window, and never lets this call acquire it either".)
- **Given** a lock is published **when** any process reads it **then** it never observes a lock file that exists but has incomplete content — publication is via `linkSync` from an already-fully-written scratch file, never an in-place `openSync` + separate write. (Tests: "never creates the lock path itself via a direct openSync — only a private scratch path", "publishes the lock only via linkSync, whose target is the lock path", "the source linkSync publishes from already contains the full pid line — never empty or partial".)
- **Given** two invocations' commits interleave under the lock (one fully commits and cleans up its own recovery backup while the other is still mid-rollback) **when** the still-rolling-back invocation restores its own pre-commit bytes **then** it restores from its OWN backup, never the other invocation's — backup paths are unique per `commitStaged` call, not a pure function of the target path. (Test: "restores the pre-commit bytes even when another invocation fully commits (and cleans up its own backup) in the middle of this invocation's failure".)
- **Given** `commitStaged` is called directly, bypassing `withDestinationLocks` **when** two such calls race **then** the race reopens — `commitStaged` performs no locking of its own; the guarantee above holds only for callers that acquire the lock for the whole commit-or-rollback phase first. (Test: "deletes invocation A's committed file when B's own destExisted/mirrorExisted check ran before A ever created it — proving the caller's lock is still required even with unique backup names, and that this is real, not hypothetical".)

## Acceptance criteria

- **Given** the merged behavior **when** `npm test` runs the `scripts/og/*.test.mjs` suite **then** it is green.
- **Given** a new caller that wants to write to `public/og-*.png` or `plans/og-images/*-og.png` **when** it is added **then** it acquires `withDestinationLocks` for its whole commit-or-rollback phase before calling `commitStaged`, per `docs/agents/code-modification-rules.md`'s pointer to this spec — `commitStaged` and `stealIfStale` provide no protection on their own for a caller that skips it.
