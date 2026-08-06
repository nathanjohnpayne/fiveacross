# Tab-contract revision & header simplification (d15-tab-contract)

Feature: the Phase 1.5 revision of the frozen bottom-tab-bar contract from Card · Feed · Ranks · Prompts · Admin to **Card · Feed · Ranks · More**, plus the top-bar simplification that hands the avatar and sign-out button to the new More menu. This is the one deliberate revision point of the `src/components/tabs.ts` frozen mount-point table (#203), implementing `plans/daily-cards-spec.md` § "More menu (⋯ tab)" (the mount-point move only) and § "Header" (the top bar's simplification). It is a THIN mount-point revision: the More menu's actual contents are #208, and live port/theme header data is #205.

## Contract

- `src/components/tabs.ts`—`TabId` is `'card' | 'feed' | 'ranks' | 'more'`; `TABS` is exactly four entries in that frozen order (Card `/`, Feed `/feed`, Ranks `/leaderboard`, More `/more`). `adminOnly` is gone from `TabDef`—admin visibility is now an in-menu concern inside More (#208), not a tab-level gate. `visibleTabs()` returns the full set (kept as a function for a stable seam if per-Player gating returns).
- `src/components/TabBar.tsx` stays pure/presentational and Firebase-hook-free. It takes an optional `morePhotoURL: string | null` prop (supplied by `Nav.tsx` from its own `useAuth()`, the same pattern the old `isAdmin` prop established). The More tab wears the Player's avatar as its icon: when `morePhotoURL` is set it renders an `<img>` (the `Avatar` rendering approach), and signed-out it falls back to an ellipsis glyph. Every tab—More included (#297)—renders its plain-text label beneath its glyph, so the accessible name is the visible label on all four; the avatar's `alt` stays empty and the More `NavLink` carries no `aria-label`, keeping screen readers from announcing "More" twice.
- `src/components/Nav.tsx` no longer renders the `ProfileEditor` avatar button or the sign-out button; the top `.nav` bar shows only the brand plus a two-line "where are we" header slot (placeholder-only here—live `EventDoc.days[]` port/theme text is #205). `ThemeSwitcher` stays mounted where it is (its relocation into More is #208), and `Nav.tsx` resolves `photoURL` from `useAuth()` and passes it to `TabBar`. The two affordances that leave `Nav.tsx` land in the new, deliberately minimal `src/components/More.tsx` (the `ProfileEditor` avatar button and the sign-out button) so neither regresses while the full menu is still Wave 1; #208 replaces `More.tsx` wholesale.
- `src/App.tsx` maps `TabId` → page component exhaustively (`card`/`feed`/`ranks`/`more`), with `more` → `More`. `ItemPool` (Prompts) and `Admin` are no longer routed, tab-driven pages—their imports and `Route`s leave the TABS-driven route table; they become components other tickets mount directly inside More (#208). `ItemPool.tsx`/`Admin.tsx` and their internals are untouched.

## Acceptance criteria

- Given the bottom tab bar, when it renders, then it shows exactly Card, Feed, Ranks, and More—no Prompts or Admin tab.
- Given a signed-in Player with a photo, when the More tab renders, then its icon is that Player's avatar image; given a signed-out state (no photo), then it falls back to an ellipsis glyph. Either way the tab shows a visible "More" caption beneath the glyph, matching the other three tabs (#297).
- Given the top `.nav` bar, when it renders, then it shows only the brand and the two-line header slot—no avatar button and no sign-out button; the frozen route table mounts no `/items` (Prompts) or `/admin` route.
- Given the interim More page, when it renders, then it carries the `ProfileEditor` avatar button and the sign-out button, so neither affordance regresses.

## Test coverage

`src/components/d15-tab-contract.test.tsx` (Vitest, `renderToStaticMarkup`—Firebase-hook-free components, no jsdom needed):

- The `TABS` frozen contract: exactly four entries with ids `['card','feed','ranks','more']` (and matching labels/paths) in that order, no `adminOnly`, and `visibleTabs()` returns the full set.
- `TabBar` More-icon rendering: with a `morePhotoURL` it renders the More tab's `NavLink` as an avatar `<img>` (that URL, empty `alt`); with `morePhotoURL={null}` it renders the ellipsis fallback glyph and no `<img>`. In both states the link ends with the visible "More" caption and carries no `aria-label` (#297). The route table's `/items`/`/admin` retirement is asserted in the sibling `src/components/w0-app-shell.test.tsx`, which owns `App.tsx`'s `TABS` → `<Route>` mapping (updated here to the four-tab set).

## Out of scope (later tickets)

The full More menu contents (profile card, Theme relocation, Text size, Play/Support sections, Admin link, version footer) and `ThemeSwitcher`'s move into More are #208, which replaces `More.tsx` wholesale; `ThemeSwitcher` stays mounted in `Nav.tsx` here. Live `EventDoc.days[]` port/theme text in the two-line header is #205 (which also depends on the schema ticket)—this ticket renders a static placeholder only.
