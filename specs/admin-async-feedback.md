---
spec_id: admin-async-feedback
status: accepted
---

# admin-async-feedback—pending/error feedback on the moderation click handlers

Implements #411 (deferred from PR #410's review): the admin moderation row actions fired async `data/admin` writes with no local catch or pending state—a rejected write (offline, a rules denial) gave the admin no feedback and surfaced as an unhandled promise rejection. Every such action now disables while its write is in flight and surfaces a rejected write inline, in the spirit of `SchedulePanel`'s `UnlockNowButton`/`ResnapshotButton`. **No write path changes**—this wraps the exact calls the console already made.

## Contract

- `src/components/admin/AsyncButton.tsx` (new)—the shared affordance: a button that runs an async `onAction`, disables while pending, and on rejection renders an inline `.pill.pill-error` alert (`role="alert"`, default copy "Failed—try again."). The button re-enables after a failure—tapping again retries and clears the pill; success clears everything (including the common case where the row unmounts because the subscription removed it). Presentation props (`className`, `title`, `ariaLabel`, children) pass through, so existing selectors and accessible names are unchanged.
- `src/components/admin/ReviewQueue.tsx`—every row action runs through `AsyncButton`: Clear reports / Hide / Restore / Delete on report rows (both kinds), Ban author / Unban author (`BanControl`), Approve / Reject / Approve all on approvals, Confirm / Reject on claims.
- `src/components/admin/PromptPool.tsx`—Hide / Restore / Delete run through `AsyncButton`. The curated add form keeps its existing `busy` state and now surfaces a rejected add inline ("Didn’t add—try again."), keeping the draft text for a one-tap retry. A rejected inline text save keeps the editor OPEN with the draft intact and an inline alert ("Didn’t save—try again.") instead of silently closing as if committed—one failure state serves both commit paths (the Save button and Enter in the input).
- `src/components/admin/PlayersPanel.tsx`—Unban runs through `AsyncButton`.
- `src/index.css`—`.pill-error`, the failure accent on the existing `.pill` chrome.

## Acceptance criteria

- Given a moderation write that rejects, the acting control shows an inline `role="alert"` failure pill and the promise never escapes unhandled; tapping the control again retries and clears the pill.
- Given a moderation write in flight, its control is disabled—a double-tap cannot fire the write twice.
- Given a rejected inline prompt-text save, the editor stays open with the draft intact.
- Given a successful write, no residual pending or error state remains.

## Test coverage

`src/components/admin-async-feedback.test.tsx` (RTL-jsdom, basename-aligned): a rejecting delete shows the alert pill and a retry clears it on success; the control disables while a write is pending and re-fires only once; a rejected claim Confirm alerts in the Review queue; a rejected Unban alerts in Players; a rejected add keeps the draft with the add-specific alert; a rejected text save keeps the editor open with the draft.
