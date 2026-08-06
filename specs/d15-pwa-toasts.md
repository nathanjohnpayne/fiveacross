---
spec_id: d15-pwa-toasts
status: accepted
---

# PWA toasts: install nudge after-first-mark + copy, update banner defer-while-sheet-open, stacking (`#219`)

Implements `plans/daily-cards-spec.md` § "Install nudge and update banner": presentation and timing changes over the existing `InstallPrompt` (w1-pwa, #30) and `UpdatePrompt` (#178) mechanics, which stay frozen — `beforeinstallprompt` capture, `appinstalled`, the iOS Share hint, `install_pwa` tracking, `registerType: 'prompt'`, `updateServiceWorker(true)`, and the 60s `registration.update()` poll are all untouched. Both toasts are mounted as independent siblings at the top of `src/main.tsx`, outside `AuthProvider` — the shared coordination this ticket adds (`src/hooks/useToastStack.ts`) lives outside the auth-gated tree too, as a module-singleton store (the same pattern `useInstallPrompt` already uses for installability state). Guarded by `src/components/d15-pwa-toasts.test.tsx`, plus the extended `src/components/w1-pwa.test.tsx` and `src/components/app-update-reload-prompt.test.tsx` for the frozen mechanics.

## Install nudge: trigger moves to after the first Mark, restyled copy

`InstallPrompt` no longer offers on app-load. `useHasMarkedSquare()` (`useToastStack.ts`) gates it: false until the Player marks a Square, then true for the rest of the device's life (persisted to `localStorage['gcb.install.hasMarked']`, same fail-open-on-storage-unavailable pattern as the existing `gcb.install.dismissedAt` dismiss key). The signal is set by `markSquareOccurred()`, called from `src/analytics.ts`'s `track()` whenever the `mark_square` GA4 event fires — reusing that existing call site (`Board.tsx`) rather than adding a new one, per the issue body. Copy changes to "Full screen, works offline at sea." (Chromium/Android variant; the "at sea" clause is the `gcb` Edition's value and the string is Edition-scoped since #608 — `src/editions.ts`); the iOS "Add to Home Screen" hint copy and the ✕/"Not now" dismiss-forever behavior (`gcb.install.dismissedAt`, unchanged key) are untouched. The persistent More → Install the app row (#208) is what lets this toast afford to stay this quiet — a Player who dismisses or never marks a Square can still install from there.

- **Given** a Player who has not yet marked a Square, **when** the app loads (even if install-eligible), **then** no install toast appears.
- **Given** a Player marks their first Square, **when** the app is install-eligible, **then** the install toast appears with the new copy.
- **Given** the Player marked a Square in an earlier session, **when** the app reloads, **then** the toast stays eligible (the signal is persisted, not session-only).

## Update banner: defer while a claim sheet is open, new copy

`UpdatePrompt` now also checks `useClaimSheetOpen()` (`useToastStack.ts`) before rendering — `needRefresh` alone is no longer sufficient. `Board.tsx` reports the claim sheet's (`ProofSheet`'s `proofTarget`) open state via `setClaimSheetOpen`, since `UpdatePrompt` has no other way to see it from outside the auth-gated tree. Copy changes to "A fresh build just docked—your marks are safe." — "reload" reads as data loss to Players, so this reassures instead. `needRefresh` itself, `updateServiceWorker(true)`, and the periodic `registration.update()` poll are untouched; closing the sheet re-renders and an already-true `needRefresh` shows the banner immediately, no re-check needed.

- **Given** a claim sheet is open, **when** a new build is available (`needRefresh` true), **then** the update banner waits until the sheet closes.
- **Given** the sheet closes with `needRefresh` still true, **when** the next render happens, **then** the update banner appears immediately.

## Toast stacking: a shared coordinator, urgent outranks invitational

Before this ticket, `body.update-prompt-visible .install-prompt { display: none; }` fully suppressed the install banner whenever the update banner was up — the only two toast sources in the app were mutually exclusive. `src/hooks/useToastStack.ts`'s `useToastSlot(id, priority, wantsToShow)` replaces that: both `InstallPrompt` (`priority: 'invitational'`) and `UpdatePrompt` (`priority: 'urgent'`) register whether they want a slot, and the coordinator ranks requests — urgent before invitational, newest-first within a priority — capping visible slots at `MAX_VISIBLE_TOASTS` (2 today; the rule is written for more). "Newest" is decided by a monotonic registration sequence, not `Date.now()`: wall-clock can hand two registrations the same millisecond and silently flip their order run-to-run (#334), while registration order is total, so a new same-priority request deterministically outranks — and, at capacity, displaces — an older one. A toast that wins a slot gets a `stackIndex` (0 = topmost) that each component writes to its root element as the `--toast-index` CSS custom property; `src/index.css`'s shared `.install-prompt, .update-prompt` shell rule offsets `bottom` by `stackIndex * 54px`, so both anchor above the tab bar (`body:has(.tabs)`) without jumping the board, and `.app`'s reserved bottom clearance grows from ~64px to ~128px when both `install-prompt-visible` and `update-prompt-visible` are set on `<body>` at once (mirrored for `.bug-report-trigger` / `.guidelines-trigger`'s own lift). The lowest-ranked excess request — a third toast source (none exists today) would create one — sits at `visible: false, stackIndex: -1` and keeps re-requesting every render, claiming a slot the moment one frees up.

- **Given** both toasts are eligible to show, **when** they would coincide, **then** the update banner ranks above (lower `stackIndex` than) the install toast, and both are visible — capped at `MAX_VISIBLE_TOASTS`.
- **Given** install requested a slot before update became eligible, **when** update also requests a slot, **then** update still ranks above install — priority, not arrival order, decides rank.
- **Given** more requests exist than `MAX_VISIBLE_TOASTS`, **when** ranking happens, **then** the lowest-ranked excess requests get `visible: false` rather than a slot.

## Resolved decisions (2026-07-12)

- The first-Mark signal is device-persisted (`localStorage`), not session-only — a Player who marked yesterday and reopens today is still nudge-eligible, matching the existing dismiss key's persistence model.
- "Claim sheet" for the defer rule means `ProofSheet` specifically (`Board.tsx`'s `proofTarget`), not `TallySheet` — the ticket's own rationale ("never interrupts a proof mid-capture") names proof capture, and `TallySheet` has no photo/media capture to interrupt.
- Toast slot height is a fixed 54px estimate (mirroring the existing ~64px single-toast clearance estimate in `specs/w1-pwa.md`, itself unverified against a live layout), not a measured value — jsdom has no layout engine, so this is confirmed by code review, same caveat as the pre-existing clearance rules.
