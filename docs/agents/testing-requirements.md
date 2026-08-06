# Testing Requirements

- Update tests when behavior changes.
- Do not delete tests to make a build pass.
- Every spec file should have a corresponding test file or a documented exception explaining why one does not exist.

## Coverage in this repo

- **Unit + component** (`npm test`—Vitest, jsdom): the pure game logic (`src/game/logic.ts`—deal, BINGO/blackout, leaderboard sort) and React components. This is the load-bearing suite.
- **Security rules** (`npm run test:rules`): Firestore/Storage rules exercised against the Firebase emulators (`@firebase/rules-unit-testing`). Run whenever `firestore.rules` / `storage.rules` change.
- **Cloud Functions** (`npm run test:functions`): the Phase-1 notifier suite under `tests/functions/`; installs `functions/` deps first, no emulator.
- **Offline durability** (`npm run test:offline`): the ADR 0006 layer under `tests/offline/`—a real Firestore client under jsdom + `fake-indexeddb` driving the auth + firestore emulators, covering the offline mutation queue, Echo Marks offline, the cells-map merge, and the `#387` / `#409` regressions. Each file runs against its own per-run demo project id (`tests/offline/runScope.ts`), and files run serially (`fileParallelism: false`) because they share one emulator.
- **End-to-end** (`npm run test:e2e`): Playwright smoke, **local only**—intentionally not run in CI.
- **Static gates**: `npm run typecheck` (`tsc --noEmit`, strict) and `npm run build` must pass.

CI (`.github/workflows/app-ci.yml`) runs typecheck → unit/component → build → functions → rules → offline on every PR and on pushes to `main`; e2e is the local smoke layer. The two emulator-backed steps (rules, offline) each boot their own `firebase emulators:exec` and must stay separate sequential steps—never two live emulator instances in one job. Spec↔test alignment is enforced by `scripts/ci/check_spec_test_alignment`, with per-spec test mappings in `.repo-template.yml` (`spec_test_map`) for the cases where a test filename doesn't match its spec basename.
