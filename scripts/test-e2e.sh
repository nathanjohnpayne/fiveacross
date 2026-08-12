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
if [[ ! -e functions/.env.local ]]; then
  printf '%s\n' \
    'EMAIL_FROM=Gay Cruise Bingo <e2e@example.invalid>' \
    'ADMIN_NOTIFY_EMAIL=' \
    'APP_BASE_URL=http://127.0.0.1:4173' \
    'BUG_REPORT_APP_CHECK=false' > functions/.env.local
  created_env=true
fi
if [[ ! -e functions/.secret.local ]]; then
  printf '%s\n' 'RESEND_API_KEY=e2e-not-used' > functions/.secret.local
  created_secret=true
fi
cleanup() {
  [[ "$created_env" == false ]] || rm -f functions/.env.local
  [[ "$created_secret" == false ]] || rm -f functions/.secret.local
}
trap cleanup EXIT INT TERM
npx firebase --non-interactive emulators:exec --only auth,firestore,storage,functions --project "$PROJECT_ID" "$cmd"
