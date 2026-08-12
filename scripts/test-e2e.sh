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
created_env=false
created_secret=false
cleanup() {
  [[ "$created_env" == false ]] || rm -f functions/.env.local
  [[ "$created_secret" == false ]] || rm -f functions/.secret.local
}
# Registered before generation (not after, as this used to be) so that a
# failed `node scripts/gen-functions-env.mjs` invocation below — which, via
# shell redirection, still creates an empty/truncated target file even
# though the command itself failed — gets cleaned up rather than left
# behind as a bogus "this file already exists" marker that would make the
# NEXT run silently skip regeneration and feed the emulator an incomplete
# env, recreating the very hang this script exists to prevent (#724).
trap cleanup EXIT INT TERM
# Generated from the params actually declared in functions/src/params.ts
# (scripts/gen-functions-env.mjs), not hand-copied — a declared param with a
# default that this generation step omitted used to leave the Functions
# emulator blocking on an interactive prompt for it forever, even under
# --non-interactive (#724). The generator itself fails loudly (nonzero exit,
# caught by `set -e` above) for any param it cannot safely derive a value
# for, so a future gap surfaces here instead of as a hang.
if [[ ! -e functions/.env.local ]]; then
  created_env=true
  node scripts/gen-functions-env.mjs env functions > functions/.env.local
fi
if [[ ! -e functions/.secret.local ]]; then
  created_secret=true
  node scripts/gen-functions-env.mjs secrets functions > functions/.secret.local
fi
npx firebase --non-interactive emulators:exec --only auth,firestore,storage,functions --project "$PROJECT_ID" "$cmd"
