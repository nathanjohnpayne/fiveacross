# Notices: reusable admin-to-players messaging (Admin "Messages" door)

**Track:** admin/social · **Phase:** 0 · **Size:** M · **Epic:** Daily Cards (admin console) **Refs:** ADR 0002 (Feed as the shared public surface), `specs/admin-console-ia.md` (hub-and-detail IA), `docs/agents/ticket-workflow.md`. New feature—data model + rules + two player surfaces + one admin surface. No push notifications; delivery is the existing Firestore realtime + offline cache. **Target mockups (the parity reference):** `plans/daily-cards-wireframes.html`—`#frame-admin-messages` (compose + sent history, the sixth hub door), `#frame-feed-notice` (the pinned Notice as players see it), and the updated `#frame-admin-hub` (six doors). **Suggested runner:** Claude Sonnet 5, high reasoning effort (cross-cutting: rules + data + Feed merge + two surfaces; every seam is specced below).

## Problem

Admins have no way to tell all Players anything. Game-state changes (final-days rules, schedule notes, "the leaderboard closes at dock") currently travel by word of mouth or the group chat, which not every Player is in. The app already has a live surface everyone watches—the Feed—but no admin-authored entry type, and nothing reusable for the next announcement or the next cruise.

## Design (matches the frames)

A **Notice** is an admin-authored broadcast: title + body, optionally **pinned**. It is a first-class Feed citizen, not a chat—no recipients, no threading, no read receipts.

- **Admin → Messages** (`#frame-admin-messages`): a sixth hub door (megaphone) at `/more/admin/messages`. Compose = title field, body field, "Pin to Feed + show Card banner" toggle (default on), one "Post to everyone" button. Below it, the sent history newest-first with quiet `Unpin` / `Delete` actions.
- **Feed** (`#frame-feed-notice`): a pinned Notice renders as an accent-bordered card at the very top of the Feed, above every Proof/Moment; attribution + day chip follow Moment conventions ("📌 Nathan · Day 8"). Unpinning demotes it into the stream at its `createdAt`. Deleting removes it everywhere.
- **Card banner**: while a Notice is pinned, the Card tab shows it once as a dismissible banner (✕). Dismissal is per-device and hides only the banner—the Notice stays in the Feed for latecomers.
- **Reusable**: nothing in the model is specific to the first message; a future announcement is a new document.

## Data model + rules

```
events/{eventId}/notices/{noticeId}
  title: string        # ≤ 60 chars
  body: string         # ≤ 400 chars
  uid, displayName     # the posting admin (attribution, Moment-style)
  createdAt: number    # ms epoch
  dayIndex?: number    # stamped at post time from the current Day
  pinned: boolean
```

`firestore.rules`: read for any signed-in user; create/update/delete only when `request.auth.uid in events/{eventId}.admins` (the existing `isAdmin` pattern). Validate title/body types + length caps and `pinned: bool` on create. No report counter—Notices are admin-authored.

## First Notice (seed content—post via the new surface once it ships)

- **Title:** `Final stretch 🏁`
- **Body:** `Last days at sea, and every card you've unlocked is still in play. Once a thing has happened, it's happened — if it's on three of your cards, that's three squares. Scroll back through your days, light up everything you've earned, and stack those bingos before we dock in Barcelona. 🚢`

(Rephrases the ask: final days; every unlocked Day Card is playable; squares and bingos still count; a prompt achieved once may be marked on every card that carries it.)

## Files to modify

- `src/types.ts`—`NoticeDoc` (shape above). Coordinate: HOT shared file.
- `src/data/converters.ts` + `src/data/paths.ts`—`noticeConverter`, `noticesCol()` / `noticeRef(id)`.
- `src/data/notices.ts` (new)—`postNotice`, `setNoticePinned`, `deleteNotice`; `dayIndex` stamped from the event's current Day the way the Moment writers do.
- `src/hooks/useData.ts`—`useNotices()` subscription; extend `FeedEntry` + `mergeFeed(proofs, moments, tallyCards, notices)` so pinned Notices sort first (then the existing newest-first merge; unpinned Notices interleave by `createdAt`).
- `src/components/admin/MessagesPanel.tsx` (new)—compose + history per `#frame-admin-messages`; quiet buttons (see the repair-line quiet-controls convention).
- `src/components/admin/AdminHub.tsx`, `src/components/admin/route.ts`, `src/components/Admin.tsx`—the sixth door + `/more/admin/messages` section wiring (badge: none).
- `src/components/ProofFeed.tsx`—render Notice entries (accent card, pinned-first) per `#frame-feed-notice`.
- Card-tab banner—a small `NoticeBanner` rendered above the Board; per-device dismissal keyed by notice id (`localStorage`), mirroring the theme-preference persistence pattern.
- `firestore.rules`—the `notices` block. HOT file; keep the PR small.
- `CONTEXT.md`—add **Notice** to the glossary (admin-authored broadcast with body text; distinct from a Moment, which announces a game beat and carries no authored copy).
- `specs/admin-messages.md` (new)—this design, **with matching tests** (spec↔test alignment).
- `track('notice_post')` / `track('notice_dismiss')`—only if the analytics catalog owner (#33 convention) signs off; otherwise skip analytics entirely this wave.

## Validation (tests are the gate; the frames define "right")

- **Rules emulator** (`tests/rules/`): non-admin create/update/delete of a Notice denied; admin allowed; any signed-in read allowed; length caps enforced; `pinned` must be boolean.
- **RTL** (`src/components/`): compose posts with title+body+pin and clears; `Unpin` flips `pinned` false; `Delete` removes from history; hub shows the Messages door and routes to `/more/admin/messages` under the existing dismissal contract (`Admin.test.tsx` / `admin-console-ia` patterns).
- **`mergeFeed` unit**: a pinned Notice sorts above newer Proofs/Moments; an unpinned Notice interleaves by `createdAt`; cap still honored; empty-notice stream leaves the merge byte-identical to today (regression guard).
- **Banner**: renders while a pinned Notice exists and undismissed; ✕ persists per device across reload (`fake-indexeddb`/localStorage test per the offline suite's pattern); dismissal never hides the Feed copy.
- **Parity**: built surfaces match `#frame-admin-messages` and `#frame-feed-notice`; `tests/e2e/d15-mockup-parity.spec.ts` gains the Messages door in its hub walk only if the hub walk asserts door count—otherwise reference-only.

## Acceptance criteria

- **Given** an admin, **when** they post the seed Notice with pin on, **then** every signed-in Player sees it at the top of the Feed and once as a Card-tab banner, attributed and day-stamped.
- **Given** a Player taps ✕, **then** the banner never returns on that device, and the Feed copy remains.
- **Given** unpin, **then** the Notice drops to its `createdAt` position in the Feed; **given** delete, **then** it disappears from Feed, banner, and history.
- **Given** a non-admin, **then** every Notice write is rejected server-side.
- **Given** no Notices, **then** Feed and Card render exactly as today.

## Definition of Done

- `specs/admin-messages.md` + matching tests (spec↔test alignment); `npm run typecheck` · `npm test` · `npm run build` green; rules suite green.
- Repo gates pass (`repo_lint`, `md-prose-wrap`, review-policy label gate). `firestore.rules` and `src/types.ts` are hot/protected-adjacent—keep the PR under the review threshold or expect Phase 4.
- Conventional commits + `Closes #`; authored `nathanjohnpayne`, reviewed under `nathanpayne-{agent}`; board discipline per `docs/agents/ticket-workflow.md`.
- The first Notice is posted through the shipped UI (not seeded by script)—that is the feature's own acceptance test.

## Decisions (surface, do not silently override)

- [ ] **Name.** "Notice" (specced; glossary-distinct from Moment). Confirm, or prefer "Announcement"/"Bulletin".
- [ ] **Dismissal persistence.** Per-device `localStorage` (specced—zero schema, matches theme persistence) vs. per-user in Firestore (survives device switches; one more rules surface). Cruise-length product favors local.
- [ ] **Multiple pins.** Specced: allowed, newest pinned first. Alternative: posting a pinned Notice auto-unpins prior ones (one banner at a time).
- [ ] **First-Notice copy.** Confirm the title/body above or supply preferred wording.
