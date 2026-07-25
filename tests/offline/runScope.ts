// PER-RUN emulator isolation for the offline layer (#473).
//
// Every offline suite talks to a LIVE Firestore + Auth emulator and, before
// this helper, pinned a FIXED demo project id and sign-in email. That is fine
// for a one-shot CI job (a fresh emulator per run), but it means the data a
// run writes survives into the NEXT `vitest run` against the same long-lived
// local emulator process — and the suites assert over freshly-seeded state.
// A second run therefore fails: the join-idempotency proof sees a player row
// that already exists (both overlapping joins resolve false, #473), the w0
// reload proof sees the previous run's board already on the server, and the
// mark suites accumulate cells/marks until `firestore.rules` blows the
// emulator's 1000-expression evaluation ceiling and denies the write.
//
// Scoping the project id and email to the RUN gives each `vitest run` a
// pristine Firestore namespace and a fresh auth uid, so reruns are independent
// without anyone having to clear the emulator between them. Vitest runs each
// test FILE in its own worker process, so the id is unique per file per run —
// the existing per-file `demo-*` base names stay the readable prefix.
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

/**
 * Scope a `demo-*` emulator project id to this run.
 * Keeps the `demo-` prefix (the Firebase convention for credential-free
 * emulator projects) and stays within the lowercase-alphanumeric-and-hyphen
 * shape project ids require.
 */
export function runScopedProject(base: string): string {
  return `${base}-${RUN_ID}`;
}

/** Scope a sign-in email to this run, so each run creates its own auth user. */
export function runScopedEmail(localPart: string): string {
  return `${localPart}-${RUN_ID}@offline.test`;
}
