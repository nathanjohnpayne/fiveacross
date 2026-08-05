# App shell & bottom-tab navigation (w0-app-shell)

Feature: a frozen, stable set of route mount points — Card / Feed / Ranks / Prompts / Admin-if-admin — rendered as a bottom tab bar, so Wave-1+ tickets fill their own tab's page component without editing `App.tsx` or `Nav.tsx`.

## Contract

- `src/components/tabs.ts` is the single source of truth for the tab set: `TABS` (id, label, path, `end`, `adminOnly`) and `FALLBACK_PATH`.
- `src/components/TabBar.tsx` renders `TABS` (filtered by `visibleTabs(isAdmin)`) as `NavLink`s inside `.tabs`, a bottom-fixed bar.
- `src/components/Nav.tsx` renders the top identity bar (brand, avatar, sign-out) plus `TabBar`, sourcing `isAdmin` from the signed-in Player's Event-admin membership.
- `src/App.tsx` maps every `TABS` entry to its page component via an exhaustive `Record<TabId, ReactElement>` and renders one `<Route>` per tab plus a `*` → `FALLBACK_PATH` catch-all. The `more` route alone mounts with a splat (`/more/*`) so the admin console's real sub-routes (`specs/admin-console-ia.md`) nest inside the frozen mount point — the tab SET is unchanged.
- While the signed-in auth/attestation bootstrap is unresolved, `App.tsx` renders the shared animated `LoadingState` with state-specific copy instead of a static "Loading…" string.

## Acceptance criteria

- Given a signed-in non-Admin Player, when the shell renders, then the bottom tab bar shows Card, Feed, Ranks, and Prompts, and hides Admin.
- Given a signed-in Admin, when the shell renders, then the Admin tab also appears.
- Given the auth bootstrap is still resolving, when the JavaScript app has mounted, then an animated, live-region loading indication explains that their pass is being checked.
- Given the frozen route table, when an unrecognized path is visited, then it does not mount any of the five known tabs and defers to the `/` (Card) fallback.
- Given `viewport-fit=cover` (already set in `index.html`) on a notched iOS device, when the shell renders, then the tab bar's own bottom padding includes `env(safe-area-inset-bottom)` so it clears the home indicator, and each tab's tap target is at least 44px tall for one-handed reachability.
- `App.tsx:` the `joinAndDeal` effect's error-swallowing is unchanged (out of scope for this ticket; owned by `w1-auth-google`).

## Test coverage

`src/components/w0-app-shell.test.tsx` (Vitest, `environment: 'node'` — no jsdom/RTL yet; that harness upgrade is `w0-test-harness`, a sibling Wave-0 ticket):

- The `TABS` contract: exactly five tabs in the frozen Card/Feed/Ranks/Prompts/Admin order with the expected paths, only `admin` flagged `adminOnly`, unique ids/paths, and the `*` fallback pointed at the Card tab's path.
- `visibleTabs(isAdmin)`: excludes Admin when `false`, includes it when `true`.
- `TabBar` — a real render via `react-dom/server`'s `renderToStaticMarkup` (no DOM needed) wrapped in a `MemoryRouter`: renders 4 links (Admin hidden) for a non-admin, 5 links for an admin, in the frozen order. `TabBar` has no Firebase-backed imports, so this exercises the actual production component, not a stand-in.
- The route table: a `TABS`-driven `<Routes>`/`<Route>` tree (mirroring `App.tsx`'s mapping, with placeholder `<div data-tab>` elements standing in for the real Firebase-backed page components, which cannot render outside a browser/emulator context) mounts the expected marker at each of the five known paths, and mounts none of them at an unrecognized path.

The `App.tsx` → real page component wiring itself (`Record<TabId, ReactElement>`) is exhaustiveness-checked by `npm run typecheck`, not a runtime test: removing a page from the map, or adding a tab to `TABS` without a matching page, fails the type check.

The one-handed-reachability / safe-area *layout* CSS (`.tabs`, `.tab` in `src/index.css`) is verified by code review + manual device/simulator check rather than an automated test — CSS layout assertions need a real layout engine (jsdom's is a no-op), which is also gated on `w0-test-harness`.

The bar's **compositing contract** is the exception, because it is a grep rather than a layout question and it has now failed twice in production: the `.tabs` rule must stay `position: fixed; bottom: 0`, must paint a fully opaque background, and must carry no `backdrop-filter`, `filter`, `transform`, `will-change`, or `perspective`. On iOS WebKit a fixed element promoted to its own compositing layer is not reliably kept pinned to the visual viewport during scroll — it detaches and freezes mid-screen, most visibly in a standalone home-screen PWA on a scrolling route (#422's `backdrop-filter: blur(8px)`, then #451). The test reads parsed rules and declarations rather than matching rule text (Codex P2 on #452): it collects every rule whose *subject* selector carries the `.tabs` class—so `.app .tabs` and `.tabs.compact` are covered while `.tabs > .tab` and `body:has(.tabs) .install-prompt` correctly are not—compares on unprefixed property names so `-webkit-backdrop-filter` is caught and `text-transform` is not mistaken for `transform`, and allowlists the background to the known-opaque token rather than denylisting the word `transparent`, which would pass `rgb(0 0 0 / 80%)`. The test pins each property so a future polish pass has to argue with a red test instead of quietly reintroducing one. The `.tab` press/hop transforms are deliberately NOT covered: they were already on main when #422 was verified pinned on a real device, so they are not implicated, and the motion pass keeps them.
