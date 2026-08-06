---
spec_id: admin-messages
status: accepted
---

# admin-messages — Notices: reusable admin-to-players messaging

Implements `plans/admin-messages-ticket.md` (issue #439), matching `plans/daily-cards-wireframes.html` frames `#frame-admin-messages` (compose + sent history, the sixth hub door), `#frame-feed-notice` (the pinned Notice as players see it), and the updated `#frame-admin-hub` (six doors). New feature — a data model, a rules block, one admin surface, and two player surfaces. No push notifications; delivery is the existing Firestore realtime + offline cache.

## Concept

A **Notice** is an admin-authored broadcast: a title and body the admin writes, optionally **pinned**. It is a first-class Feed citizen, not a chat — no recipients, no threading, no read receipts, no report counter. Glossary-distinct from a Moment (CONTEXT.md): a Moment announces a game beat and carries no authored copy; a Notice IS the admin's own words. Nothing in the model is specific to the first message — a future announcement, or the next Event's, is simply a new document.

## Data model

`events/{eventId}/notices/{noticeId}` (`NoticeDoc`, `src/types.ts`):

- `title: string` — ≤ 60 chars (rules cap).
- `body: string` — ≤ 400 chars (rules cap).
- `uid, displayName` — the posting admin (attribution, Moment-style; `displayName` bounded to the ≤100 attribution contract via `markerDisplayName`).
- `createdAt: number` — ms epoch, client-set.
- `dayIndex?: number` — stamped at post time from the event's current Day (`defaultViewedIndex(event.days, now)`), so the Feed reads "📌 Nathan · Day 8". Optional so a schedule-less Event still posts.
- `pinned: boolean`.
- `editedAt?: number` — ms epoch, stamped on each successful in-place copy correction (#455). Absent on a never-edited Notice, so every doc written before Edit shipped stays valid with no backfill; present means both the Feed card and the admin history show "edited".

The doc carries its own id on read (`noticeConverter` pins `id` to `snap.id`); the write path (`src/data/notices.ts`) uses raw refs and a Firestore auto-id. A Notice is MUTABLE (the pin toggle, plus an in-place copy correction since #455) and DELETABLE — unlike a Moment, which is create-once/immutable — so `postNotice` / `setNoticePinned` / `editNotice` / `deleteNotice` are the four writers.

### What an edit may and may not change (#455)

Editing exists so a typo or off-house-style punctuation is fixable without a Delete + repost, which would lose the Notice's Feed position and re-banner every player who already dismissed it. It deliberately keeps the integrity half PR #440 hardened:

- **Mutable:** `title`, `body`, `pinned`, `editedAt`.
- **Immutable:** `uid` and `displayName` (a byline can never be moved onto another admin), `createdAt` (a Notice can never be re-sorted to the top of the Feed by editing it), and `dayIndex`.

An edit is therefore always visible, never silent — and that visibility is enforced by the rules, not merely by the client: a copy change is rejected unless it stamps a fresh `editedAt`, and an existing stamp can never be removed. The reason content was locked in the first place survives: a delivered broadcast may be **corrected**, but not **rewritten**.

## Rules (`firestore.rules` § notices)

Inside `match /events/{eventId}`, a sibling of `moments`:

- `read`: any signed-in user (the delivery surface everyone watches).
- `create`: `isAdmin(eventId)` AND `uid == request.auth.uid` (attribution bound to the posting admin, the markers/moments isOwner discipline — a "📌 Nathan" byline can't be forged) AND `title is string && title.size() <= 60` AND `body is string && body.size() <= 400` AND `pinned is bool` AND `createdAt is number` within `+60s / -24h` of `request.time` (so a forged far-future stamp can't pin a Notice above all Feed activity, the moments/proofs bound).
- `update`: `isAdmin(eventId)` AND the diff touches ONLY `title`, `body`, `pinned`, `editedAt` (`diff(resource.data).affectedKeys().hasOnly([...])`) AND the create-time title (≤ 60) / body (≤ 400) caps and `pinned is bool` revalidated, plus two provenance clauses:
  - **A copy change must stamp a fresh `editedAt`** — if the diff touches `title` or `body`, it must also touch `editedAt`. This is what makes "an edit is visible" an *enforced* invariant rather than a client-side convention: no client can rewrite copy while leaving the "edited" marker off. Reusing the stored stamp does not count, because an unchanged `editedAt` is not in `affectedKeys`.
  - **When `editedAt` changes it must be near-now** — a number within `+60s / -24h` of `request.time`, the same bound `createdAt` carries, so an edit can neither backdate nor future-date its own provenance. Since an absent field fails `is number`, an existing stamp can never be stripped to hide a correction.

  The freshness bound is scoped to the **diff**, not to mere presence. A pin-only `updateDoc` merges the *stored* `editedAt` into `request.resource.data`, so a presence-scoped check would reject every Pin/Unpin once a Notice's last edit fell outside the 24h window (Codex P1, PR #456).

  Because `uid`, `displayName`, `createdAt`, and `dayIndex` are absent from `hasOnly`, any attempt to change them is denied — a stale or hand-built admin client can correct copy but can never re-attribute a delivered Notice or re-sort it in the Feed (the rules are the enforcement boundary, not just the client writer).
- `delete`: `isAdmin(eventId)`.

No owner-write path (a Notice belongs to the admin role, not one uid) and no report counter (admin-authored content is not player-reportable).

## Surfaces

### Admin → Messages (`/more/admin/messages`, `#frame-admin-messages`)

The sixth hub door (`Megaphone` icon, no badge) in `AdminHub.tsx`; `'messages'` joins the `ADMIN_SECTIONS` tuple (`route.ts`), `SECTION_TITLES.messages = 'Messages'` and the render guard join `Admin.tsx`, and the section inherits the whole `AdminSheet` navigation-and-dismissal contract (Done / back / Escape / backdrop) for free. `MessagesPanel.tsx`:

- **Compose** — a title field, a body textarea, a "Pin to Feed + show Card banner" toggle (default ON), and one "Post to everyone" button (disabled until both fields are non-empty). On a settled success the draft clears and the pin resets to on; a rejected post surfaces an inline `role="alert"` pill and KEEPS the draft (the `AdminAddItemForm` / #411 convention).
- **Sent history** — newest-first, each row showing the title and a "Day N · Name · 📌 pinned · edited" line with quiet `Edit`, `Unpin`/`Pin`, and `Delete` controls (`AsyncButton` — disables in flight, surfaces a failure pill).
- **Edit** (#455) — swaps the row for an inline editor: a title input and body textarea prefilled with the current copy, under the same caps as Compose, with `Save` / `Cancel`. Save is disabled while either field is blank; on a settled success the editor closes; a rejected save KEEPS the editor open with the draft intact and surfaces an inline `role="alert"` (the same #411 convention Compose uses), so a retry is one tap. Saving with nothing actually changed closes without writing — a no-op save must not stamp `editedAt` and brand an untouched Notice "edited" (the draft is compared trimmed, so trailing whitespace alone is not an edit). Only copy is editable — the byline, Day, and Feed position are fixed here and in the rules.

### Feed (`#frame-feed-notice`)

`ProofFeed.tsx` `NoticeCard`: an accent-bordered, accent-tinted card. `mergeFeed` sorts PINNED Notices to the very top of the Feed (newest pinned first, above every Proof/Moment/Tally Card regardless of time); UNPINNED Notices interleave newest-first in the stream at their `createdAt`. Attribution follows the Moment convention — pinned wears "📌 Nathan · Day 8", unpinned drops the pin, and a corrected Notice appends "edited" (#455) so a reader can always tell the copy changed after it was delivered. This Feed copy is NOT dismissible: it is the durable record latecomers scroll to. (`#frame-feed-notice` draws a ✕ on the card; that ✕ is the Card-tab banner's affordance, not the Feed card's — the frame reuses one visual for both. The behavioral spec, and the acceptance criterion "the Feed copy remains", governs: the ✕ lives on the banner.)

### Card-tab banner (`NoticeBanner.tsx`)

While a Notice is pinned, the Card tab shows it once as a dismissible banner (✕) above the Board (mounted in `App.tsx`'s `card` page). Dismissal is PER-DEVICE — `localStorage`, keyed `gcb.notice.<id>.dismissedAt`, mirroring the CoachOverlay / InstallPrompt pattern (read/write fall open on a storage error) — and hides ONLY the banner; the Feed copy stays for latecomers. Of the pinned Notices (newest-first), the banner shows the newest one this device has not dismissed.

## Feed merge (`mergeFeed`, `src/hooks/useData.ts`)

`mergeFeed(proofs, moments, tallyCards, notices, max)`: pinned Notices form a capped masthead (newest-first, at most five visible pinned Notices, and when `max > 1`, at least one slot reserved for the normal stream); everything else — proofs, moments, non-zero tally cards, and unpinned Notices — interleaves newest-first below; the concatenation is capped to `max`. With no Notices the output is byte-identical to the pre-Notice merge (the `notices` default is `[]`, contributing no entries) — the regression guard below pins this.

## Decisions (from the ticket, resolved)

- **Name** — "Notice" (glossary-distinct from Moment).
- **Dismissal persistence** — per-device `localStorage` (zero schema, matches theme/coach persistence; an Event-length product favors local over per-user Firestore).
- **Multiple pins** — allowed; newest pinned first in both the Feed masthead and the banner selection.
- **First-Notice copy** — "Final stretch 🏁" / the final-days body, posted through the shipped UI (the feature's own acceptance test), not seeded by script.

## Analytics

None this wave. `track('notice_post')` / `track('notice_dismiss')` ship only if the analytics-catalog owner (#33) signs off; absent that, no analytics are wired.

## Tests (spec ↔ test alignment)

- **Rules** (`tests/rules/notices.test.ts`): any signed-in read allowed; non-admin create/update/delete denied; admin create/update/delete allowed; `title` > 60, `body` > 400, and non-boolean `pinned` each denied on create. For the edit contract (#455, #456): an admin corrects `title`/`body` with a fresh `editedAt` (allowed); a copy change WITHOUT a stamp denied; the caps revalidated on update; a non-numeric or out-of-bounds `editedAt` denied; `editedAt` deletion denied, alone and alongside a copy change; a Notice whose stored `editedAt` is three days old still pins/unpins (the diff-scoping regression guard); `uid`, `displayName`, `createdAt`, and `dayIndex` denied both alone and smuggled alongside a legal copy change; a non-admin edit denied.
- **`mergeFeed` unit** (`src/data/w2-feed-moments.test.ts`): a pinned Notice sorts above newer Proofs/Moments; the pinned masthead is capped without evicting the normal stream; an unpinned Notice interleaves by `createdAt`; the `max` cap still holds; an empty-notices stream leaves the merge byte-identical to the pre-Notice output (regression guard).
- **Banner** (`src/components/NoticeBanner.test.tsx`): renders the newest pinned Notice while undismissed; ✕ writes the per-device key and hides it; a remount with the key present does not render (persist-across-reload), a different notice id still renders; dismissal never touches the Feed copy.
- **Admin IA** (`src/components/admin-console-ia.test.tsx`): the hub renders the Messages door and routes to `/more/admin/messages`, opening the "Messages" dialog under the existing dismissal contract.
- **MessagesPanel** (`src/components/MessagesPanel.test.tsx`): compose posts with title + body + pin and clears; `Unpin` flips `pinned` false; `Delete` removes the row from history. For Edit (#455): the editor opens prefilled with the current copy and `Save` calls `editNotice` with the trimmed values then closes; `Cancel` closes without writing; a rejected save keeps the editor open with the draft intact and raises the alert; `Save` is disabled while either field is blank; a Save with nothing changed (and one differing only by trailing whitespace) closes without calling `editNotice`; an edited row shows "edited" and an unedited one does not.
- **Feed card** (`src/components/ProofFeed.test.tsx`): a Notice carrying `editedAt` renders "edited" on the card; one without renders exactly as before (#455 regression guard).
