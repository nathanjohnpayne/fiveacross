// Per-build dismissal for the update-reload toast (#605).
//
// THE BUG THIS EXISTS FOR. `registerType: 'prompt'` (vite.config.ts) leaves a
// newly installed worker in `waiting` until the page releases it, and
// `workbox-window` re-announces that waiting worker on EVERY registration:
// `Workbox.register()` dispatches a `waiting` event carrying
// `wasWaitingBeforeRegister: true` whenever `registration.waiting` already
// exists, which `vite-plugin-pwa` turns straight into `onNeedRefresh()`. So
// `needRefresh` reports a STATE ("a build is waiting"), not a transition ("a
// build just arrived") — and the old dismissal was `setNeedRefresh(false)`,
// React state with no storage behind it. Every launch re-registered, saw the
// same waiting worker, and re-prompted; a player who kept tapping "Not now" was
// re-asked at every launch while staying on the same stale build. That is
// exactly the report on #605 (a client still on the 2026-07-31 build four days
// and many deploys later, prompted every launch).
//
// So the dismissal has to name a BUILD, not a session — suppress the build the
// player declined, and let the next one through. The waiting worker's identity
// is not visible from the page (its `scriptURL` is always `/sw.js`, and its
// build stamp lives inside the script), so we ask it directly: the worker
// answers `GET_BUILD_STAMP` with its baked-in `__BUILD_STAMP__` (src/sw.ts).
//
// HONEST LIMIT — the transition deploy. A worker that installed BEFORE this
// change carries no reply handler, so the query times out and resolves null.
// Null is fail-open: nothing is suppressed and nothing is recorded, i.e. the
// pre-#605 behaviour, for exactly one more prompt. From the first build that
// carries the handler onward, every waiting worker can name itself.
//
// Every storage and service-worker touch is guarded the way
// `src/shellRecovery.ts` guards its own: these APIs throw in some privacy modes
// and are absent under SSR and in unit tests, and a dismissal path that can
// throw is worse than no dismissal path.

/** Message the page sends a waiting worker to ask which build it carries. */
export const BUILD_STAMP_REQUEST = 'GET_BUILD_STAMP';
/** Reply type `src/sw.ts` posts back on the caller's `MessagePort`. */
export const BUILD_STAMP_REPLY = 'BUILD_STAMP';

/** localStorage slot holding the `__BUILD_STAMP__` of the last declined build.
 *  One slot, overwritten: only the most recent decline can still be waiting. */
export const DISMISSED_BUILD_KEY = 'gcb.update.dismissedBuild';

/** Ceiling on the worker round trip. Reached only when nothing answers — a
 *  pre-#605 waiting worker, most likely — and the answer then is null, which
 *  suppresses nothing. `UpdatePrompt` only makes the player WAIT on this when a
 *  dismissal is actually on record, so an unanswerable query cannot delay the
 *  banner for someone who has never tapped "Not now". */
export const BUILD_STAMP_TIMEOUT_MS = 2_000;

/**
 * The `__BUILD_STAMP__` of the worker currently in `waiting`, or null when
 * there is none, when it does not answer, or when service workers are
 * unavailable at all (SSR, jsdom, a browser with SW disabled).
 *
 * Null is always the fail-open answer: an unidentifiable build can neither be
 * suppressed nor be recorded as declined, so the player gets the prompt.
 */
export async function readWaitingBuildStamp(timeoutMs = BUILD_STAMP_TIMEOUT_MS): Promise<string | null> {
  try {
    const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!container?.getRegistration) return null;
    const registration = await container.getRegistration();
    return await askWorkerBuildStamp(registration?.waiting ?? null, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * The round trip itself, against ANY worker rather than the waiting one.
 *
 * Split out for `src/swClientBridge.ts` (Codex P1 on #621), which has to ask the
 * worker that just ACTIVATED whether it is serving the build this page is
 * executing — the first worker on an uncontrolled page is not guaranteed to
 * match, because a deploy can land between the document load and the `/sw.js`
 * fetch. Same null-is-fail-open contract as above: an unanswerable worker
 * (a pre-#605 build, a dropped port, a worker killed mid-question) is not
 * evidence of anything, and each caller reads null as "change nothing".
 */
export async function askWorkerBuildStamp(
  worker: Pick<ServiceWorker, 'postMessage'> | null | undefined,
  timeoutMs = BUILD_STAMP_TIMEOUT_MS,
): Promise<string | null> {
  try {
    if (!worker) return null;
    return await new Promise<string | null>((resolve) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (stamp: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          channel.port1.close();
        } catch {
          /* already closed — nothing to do */
        }
        resolve(stamp);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      channel.port1.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: unknown; stamp?: unknown } | null;
        finish(data?.type === BUILD_STAMP_REPLY && typeof data.stamp === 'string' ? data.stamp : null);
      };
      worker.postMessage({ type: BUILD_STAMP_REQUEST }, [channel.port2]);
    });
  } catch {
    return null;
  }
}

/** The build stamp the player last declined, or null (including when storage
 *  refuses to be read — an unreadable store suppresses nothing). */
export function dismissedBuild(): string | null {
  try {
    return localStorage.getItem(DISMISSED_BUILD_KEY);
  } catch {
    return null;
  }
}

/**
 * Whether this waiting build is the one already declined. Exact match, so a
 * GENUINELY newer build — a different stamp — always prompts again, which is
 * the whole point: the suppression covers one build, not the offer itself.
 */
export function isDismissedBuild(stamp: string | null): boolean {
  if (!stamp) return false;
  return dismissedBuild() === stamp;
}

/** Record a decline. A null stamp records nothing: with no identity to key on,
 *  a persisted dismissal could only be an indefinite one. */
export function rememberDismissedBuild(stamp: string | null): void {
  if (!stamp) return;
  try {
    localStorage.setItem(DISMISSED_BUILD_KEY, stamp);
  } catch {
    /* storage refused — the dismissal still holds for this session */
  }
}
