#!/usr/bin/env bash
set -euo pipefail

# Emulator-backed Playwright runner with argument forwarding (Codex P3 on
# PR #114 round 2). `firebase emulators:exec` takes ONE script string, so the
# previous inline form — `firebase emulators:exec ... "playwright test"` —
# dropped anything after `npm run test:e2e --` onto emulators:exec itself,
# where it either errored or was ignored; targeted runs like
# `npm run test:e2e -- tests/e2e/foo.spec.ts --grep "title"` never reached
# Playwright. This wrapper shell-quotes every forwarded argument (printf %q,
# space-safe) into that one script string, so CLI args reach Playwright
# intact.
#
# `npm run test:e2e` is the emulator-backed, self-contained entry point; a
# bare `npx playwright test` requires emulators already running (see
# specs/x-e2e-happy-path.md).

# The emulator's project id MUST match the browser bundle and the seed helper's
# PROJECT_ID (tests/e2e/support/env.ts: demo-gaycruisebingo-e2e). Without
# --project, emulators:exec adopts the .firebaserc default (gaycruisebingo, a
# real project), so the emulator would evaluate Auth-backed Firestore rules
# under a DIFFERENT project than the signed-in app writes as — inviting
# permission-denied / unauthenticated rule evaluations on the app's own
# board/player writes. Made explicit rather than trusting emulator leniency
# (Codex P2 on PR #114 round 3). Keep this literal in lockstep with env.ts.
PROJECT_ID='demo-gaycruisebingo-e2e'

cmd="npx playwright test"
for arg in "$@"; do
  cmd+=" $(printf '%q' "$arg")"
done

# Callable flows need the compiled Functions entrypoint as well as the emulator.
npm --prefix functions run build

# The emulator prompts — and then blocks forever — for any param declared in
# functions/src/params.ts that these two throwaway dotenv files do not name,
# whatever `--non-interactive` says, and whether or not the param has a default
# (#724). So the file contents are DERIVED from params.ts rather than restated
# here: scripts/e2e-functions-env.mjs fails loudly naming an uncovered param
# instead of letting the next added one hang the suite. It also holds a
# developer's own pre-existing file to the same rule, which is the case that
# never surfaces on its own — whoever has one is precisely who cannot reproduce
# the fresh-checkout hang.
#
# Ownership is decided here, before the generator runs, so the trap can clean up
# whatever this run creates even if a later step dies: a file that already
# existed belongs to the developer and is left alone.
created_env=false
created_secret=false
[[ -e functions/.env.local ]] || created_env=true
[[ -e functions/.secret.local ]] || created_secret=true
cleanup() {
  [[ "$created_env" == false ]] || rm -f functions/.env.local
  [[ "$created_secret" == false ]] || rm -f functions/.secret.local
}
trap cleanup EXIT INT TERM
node scripts/e2e-functions-env.mjs \
  functions/src/index.ts functions/.env.local functions/.secret.local "$PROJECT_ID"
npx firebase --non-interactive emulators:exec --only auth,firestore,storage,functions --project "$PROJECT_ID" "$cmd"
