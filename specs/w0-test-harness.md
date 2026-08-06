# w0-test-harness—four-layer app test harness

Stand up the four test layers the Definition of Done assumes but the scaffold lacks, and wire the scripts, config, and CI that run them. This is the harness every other app test layer builds on, so it lands first in Wave 0. It exists specifically so `w0-firestore-rules` can assert the honor-system invariants—self-writable `boards`/`players` (ADR 0001) and every Mark publishing to the public Tally (ADR 0002)—against a real Firestore emulator rather than mocks.

The harness is additive: no existing behavior changes, and the pure `src/game/logic.ts` game logic keeps its existing coverage. Each layer below names the command that runs it and the test file that asserts its claims; every claim maps to an assertion in that file (no vacuous coverage).

## Layer 1—Unit (pure game logic)

Runner: `npm test` (Vitest, jsdom project). Test: `src/game/logic.test.ts`.

- `dealBoard` throws when the active prompt pool has fewer than 24 entries, so a caller can never persist a board with blank cells. The test deals from a 23-item pool and asserts the throw (message includes "at least 24 prompts"), covering the guard in `src/game/logic.ts`.
- The pre-existing pure-logic coverage (board deal determinism, 24 unique prompts + free center, win/blackout detection, leaderboard ordering) stays green under the new jsdom environment because the logic is environment-agnostic.

## Layer 2—Component (React Testing Library under jsdom)

Runner: `npm test` (Vitest, jsdom project). Test: `src/test/rtl-smoke.test.tsx`.

- A React component mounts under jsdom via `@testing-library/react`'s `render`, and its rendered output is queryable through Testing Library's `screen` role/text queries.
- `@testing-library/jest-dom` matchers are registered on Vitest's `expect` (via `src/test/setup.ts`), so assertions like `toBeInTheDocument` and `toHaveTextContent` are available to component tests.

## Layer 3—Rules (Firestore emulator)

Runner: `npm run test:rules` (boots the Firestore + Storage emulators via `firebase emulators:exec`, then runs the Node-environment `vitest.rules.config.ts` project). Test: `tests/rules/firestore-harness.test.ts`.

- A signed-in `RulesTestContext` can be constructed against the running Firestore emulator with `firestore.rules` loaded, and it exposes a Firestore instance.
- The emulator enforces `firestore.rules`, not open-by-default access: a read the rules allow (a signed-in context reading a `users/{uid}` profile) succeeds, and the same read from an unauthenticated context fails.

The substantive honor-system invariants are out of scope for this ticket; they are asserted by `w0-firestore-rules` / `w0-storage-rules`, which extend this `tests/rules/` layer.

## Layer 4—End-to-end (Playwright)

Runner: `npm run test:e2e` (Playwright, `playwright.config.ts`). Test: `tests/e2e/smoke.spec.ts`.

- `npm run test:e2e` launches the Playwright runner in a real Chromium browser, drives a page, and a page assertion passes. This layer is a smoke runner only; the full join → mark → BINGO → leaderboard round is `x-e2e-happy-path`, which adds the dev-server `webServer` + `baseURL` wiring on top of this config.
- A fresh checkout can run this layer without manual setup: the `pretest:e2e` script runs `playwright install chromium` before every e2e run (a fast no-op once the browser is cached).

## Harness wiring

- `vite.config.ts` runs the app layers in a jsdom environment scoped to `src/**/*.test.{ts,tsx}` with `src/test/setup.ts` as its setup file, so `npm test` never needs a running emulator or browser.
- `vitest.rules.config.ts` runs the rules layer in a Node environment scoped to `tests/rules/**/*.test.ts`.
- `playwright.config.ts` runs the e2e layer from `tests/e2e/` and matches `*.spec.ts`, so Vitest and Playwright never claim each other's files.
- `firebase.json` carries an `emulators` block (auth, firestore, storage) that pins the ports `test:rules` and `emulator` boot.
- `package.json` exposes the `test:rules`, `test:e2e`, and `emulator` scripts alongside the existing `test`. `firebase-tools` is a devDependency, so `npm install` puts the `firebase` binary on npm's script PATH in a fresh checkout (locally and in CI alike); the only external prerequisite for the rules layer is a Java runtime for the emulator.
- `.github/workflows/app-ci.yml` runs typecheck + the jsdom test suite + build + the Firestore rules tests on every pull request and on pushes to `main`.

## Acceptance criteria

- Given the jsdom Vitest project, when `npm test` runs, then a component mounts under React Testing Library and `src/game/logic.test.ts` passes including the new `dealBoard(<24)` throw.
- Given the `emulators` block and `test:rules` script, when `npm run test:rules` runs, then the Firestore/Storage emulators boot and a rules test executes against them.
- Given `.github/workflows/app-ci.yml`, when a pull request opens, then CI runs typecheck, the jsdom test suite, the build, and the rules tests.
