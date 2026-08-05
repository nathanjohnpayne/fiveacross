import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useClaimSheetOpen, useToastSlot } from '../hooks/useToastStack';
import { buildBelowFloor, fetchBuildFloor } from '../buildFloor';
import { dismissedBuild, isDismissedBuild, readWaitingBuildStamp, rememberDismissedBuild } from '../updateDismissal';

/** How often a long-lived tab asks the browser to re-check `/sw.js` for a new
 *  deploy (`registration.update()`). 60s matches the poll cadence Nathan's other
 *  apps use for their version checks; `sw.js` is served `Cache-Control: no-cache`
 *  (firebase.json), so each check sees a new deploy immediately. */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

/** How often a long-lived tab re-reads `/build-floor.json` (#342) so a floor
 *  bumped after mount still reaches already-open cruise tabs. */
export const FLOOR_RECHECK_INTERVAL_MS = 10 * 60_000;

/** Toggled on <body> while the banner is on screen — index.css keys extra `.app`
 *  bottom clearance off it, same mechanism as InstallPrompt's
 *  `install-prompt-visible` (see specs/w1-pwa.md). */
const VISIBLE_CLASS = 'update-prompt-visible';
/** Toast-stack id (#219, "urgent" priority) — see useToastStack.ts. */
const TOAST_ID = 'update';

/**
 * Update-reload banner (specs/app-update-reload-prompt.md, #178): with
 * `registerType: 'prompt'` (vite.config.ts) the new service worker installs and
 * waits instead of activating under the running page; `useRegisterSW` flips
 * `needRefresh` when that happens, and this banner offers Reload
 * (`updateServiceWorker(true)`) or Not now (dismiss). Mounted at `main.tsx`
 * alongside `ConsentNotice`/`InstallPrompt` (#17).
 *
 * #605: Not now suppresses the DECLINED BUILD, not the session. `needRefresh`
 * is re-raised for the same waiting worker on every registration, so an
 * in-memory dismissal re-prompted at every launch while the client stayed put;
 * the decline is now persisted against the waiting worker's own build stamp
 * (src/updateDismissal.ts) and a genuinely newer build prompts again.
 *
 * #219 (specs/d15-pwa-toasts.md): also checks `useClaimSheetOpen()` (reported
 * by Board.tsx via `setClaimSheetOpen`) so a proof capture in progress is
 * never interrupted by a reload offer; `needRefresh` itself is untouched, so
 * closing the sheet shows the banner immediately. Final visibility is then
 * arbitrated by `useToastSlot` alongside the install nudge ("urgent" always
 * outranks its "invitational" rating).
 */
export default function UpdatePrompt() {
  // WHICH worker is waiting, tracked by object identity (Phase 4b P1 on #605).
  // `needRefresh` is a boolean, and a REPLACEMENT worker installing mid-session
  // re-raises a flag that is already true — React sees no change, so nothing
  // keyed off that flag re-runs. A tab that had declined build A would then keep
  // suppressing the offer for build B for the rest of its life. The waiting
  // ServiceWorker object is a per-build identity the boolean cannot express, so
  // a bump here is what re-opens the identity question below.
  const waitingWorker = useRef<ServiceWorker | null>(null);
  const [waitingEpoch, setWaitingEpoch] = useState(0);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const noteWaitingWorker = useCallback(() => {
    const waiting = registrationRef.current?.waiting ?? null;
    if (waiting === waitingWorker.current) return;
    waitingWorker.current = waiting;
    setWaitingEpoch((epoch) => epoch + 1);
  }, []);

  const {
    // `setNeedRefresh` is deliberately NOT used: dismissal must not clear this
    // flag (Phase 4b P1 on #605) — see the Not now handler below.
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      registrationRef.current = registration;
      // The worker that was already waiting at registration time — the ordinary
      // relaunch case, and the one that made the toast a fixture of every launch.
      noteWaitingWorker();
      // A worker that installs LATER in this same tab. `updatefound` fires when
      // it starts installing, so the identity is only settled once that worker
      // reaches `installed` (i.e. lands in `waiting`); both are observed because
      // `registration.waiting` is what the check above compares.
      registration.addEventListener?.('updatefound', () => {
        const installing = registration.installing;
        noteWaitingWorker();
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed') noteWaitingWorker();
        });
      });
      setInterval(() => {
        // Offline (common mid-cruise) — skip the round trip; the next tick retries.
        if (navigator.onLine === false) return;
        registration
          .update()
          // Belt and braces for the event above: a worker installed by ANOTHER
          // tab, or an `updatefound` this tab missed, still shows up here as a
          // changed `registration.waiting`.
          .then(noteWaitingWorker)
          .catch(() => {
            /* transient network failure — the next tick retries */
          });
      }, UPDATE_CHECK_INTERVAL_MS);
    },
  });
  const claimSheetOpen = useClaimSheetOpen();

  // Remote force-reload floor (#342): when the RUNNING build is older than the
  // served public/build-floor.json, skip the offer and activate+reload as soon
  // as a newer SW is waiting. Gated on a waiting SW actually existing — so a
  // misconfigured floor (newer than every build) can never reload-loop a
  // current client: its update check finds no new SW, nothing fires. Floor
  // fetch failures resolve null → `buildBelowFloor` is false → normal prompt.
  const [floorStale, setFloorStale] = useState(false);
  // Holds the banner until the FIRST floor read settles (Codex P2 on #342): a
  // stale client that showed the dismissible banner while /build-floor.json was
  // still in flight could be "Not now"-ed before the force decision arrived.
  // Bounded by fetchBuildFloor's own timeout, and a failed read still settles
  // (null floor), so the offer is delayed by at most a few seconds.
  const [floorChecked, setFloorChecked] = useState(false);
  // Latches "a newer SW is waiting": the force must still fire when a floor bump
  // arrives long after the offer was made or declined (Codex P2 on #342), so it
  // keys off this latch, never the dismissible state. Since #605 the dismissal
  // no longer clears `needRefresh` at all, so the latch is now a belt-and-braces
  // record rather than the only surviving evidence, and it is kept as one.
  // Latched in an effect, not during render
  // (CodeRabbit on #342): render work can be replayed and discarded without
  // committing, so a render-phase ref write could leak from work that never
  // showed. Declared BEFORE the force effect below so the latch commits first.
  const sawWaitingSW = useRef(false);
  useEffect(() => {
    if (needRefresh) sawWaitingSW.current = true;
  }, [needRefresh]);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      void fetchBuildFloor().then((floor) => {
        if (cancelled) return;
        setFloorChecked(true);
        if (buildBelowFloor(__BUILD_STAMP__, floor)) setFloorStale(true);
      });
    };
    check();
    // Re-read on a slow cadence (Codex P2 on #342): a cruise tab left open for
    // days must still observe a floor bumped AFTER it mounted. Ten minutes is
    // responsive enough for an emergency lever and negligible traffic (a tiny
    // static file, no-store).
    const timer = setInterval(check, FLOOR_RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (floorStale && sawWaitingSW.current) void updateServiceWorker(true);
    // `needRefresh` is a dep so a waiting SW that appears AFTER the floor was
    // already known stale still triggers the force on its flip to true.
  }, [floorStale, needRefresh, updateServiceWorker]);

  // Per-build dismissal (#605). `needRefresh` reports a STATE — "a worker is
  // waiting" — and workbox-window re-announces that same waiting worker on every
  // registration, so an in-memory `setNeedRefresh(false)` could only ever hide
  // the toast until the next launch. The suppression therefore has to name the
  // build the player declined; `src/updateDismissal.ts` explains how that
  // identity is obtained and why null means "prompt anyway".
  //
  // The in-flight identity query, held as the PROMISE rather than its settled
  // value: the banner is offered immediately when no decline is on record, so a
  // player can tap "Not now" while the query is still out, and a click that read
  // a not-yet-settled `null` would record nothing and re-ask at the next launch.
  // Awaiting the same promise makes the decline race-free without a second
  // round trip. Reset per waiting worker, so a decline can never name the
  // previous one.
  const stampQuery = useRef<Promise<string | null> | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  // Whether the suppression answer is in. Gating the offer on it prevents a
  // dismissed build from flashing up before the answer lands — but ONLY when a
  // dismissal is actually on record, because otherwise no answer can suppress
  // anything and waiting on a worker that may never reply (a pre-#605 waiting
  // worker, which has no handler for the query) would delay the banner for
  // nothing.
  const [suppressionSettled, setSuppressionSettled] = useState(true);
  useEffect(() => {
    if (!needRefresh) return;
    let cancelled = false;
    setSuppressed(false);
    setSuppressionSettled(dismissedBuild() === null);
    const query = readWaitingBuildStamp();
    stampQuery.current = query;
    void query.then((stamp) => {
      if (cancelled) return;
      setSuppressed(isDismissedBuild(stamp));
      setSuppressionSettled(true);
    });
    return () => {
      cancelled = true;
    };
    // `waitingEpoch` is the load-bearing dep (Phase 4b P1 on #605): it changes
    // whenever a DIFFERENT worker is waiting, including while `needRefresh` is
    // already true — the mid-session replacement that a boolean edge cannot
    // report. Without it, a tab that declined build A would keep A's verdict
    // over build B for as long as it stays open.
  }, [needRefresh, waitingEpoch]);

  const wantsToShow =
    needRefresh && !claimSheetOpen && !floorStale && floorChecked && suppressionSettled && !suppressed;
  const { visible, stackIndex, visibleCount } = useToastSlot(TOAST_ID, 'urgent', wantsToShow);

  useEffect(() => {
    document.body.classList.toggle(VISIBLE_CLASS, visible);
    return () => {
      document.body.classList.remove(VISIBLE_CLASS);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      className="update-prompt"
      role="status"
      style={{ '--toast-index': stackIndex, '--toast-count': visibleCount } as CSSProperties}
    >
      {/* The wireframes' toast lead-in (#308) — emoji, per the spec's
          iconography rule ("toast lead-ins stay emoji"). */}
      <span className="toast-icon" aria-hidden="true">
        🚢
      </span>
      {/* Wrapped so the shared row-flex toast shell stacks the two lines
          vertically instead of splitting them into columns (Codex P2 on
          #281) — same body-wrapper pattern as the install toast. */}
      <div className="install-prompt-body">
        <p className="toast-title">A fresh build just docked</p>
        <p>Your marks are safe&mdash;reload takes two seconds</p>
      </div>
      <button className="btn primary" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button
        className="btn"
        onClick={() => {
          // Hide via the dismissal state ALONE. Clearing `needRefresh` here —
          // which is what vite-pwa's own example does, and what this component
          // did — disarms the #342 floor force: the force effect keys off
          // `needRefresh` to fire when a waiting worker appears after the floor
          // was already known stale, so a declined tab would stop responding to
          // an emergency floor bump that lands later (Phase 4b P1 on #605).
          // Leaving the flag true costs nothing: `suppressed` hides the offer,
          // and the identity effect re-opens the question when a DIFFERENT
          // worker starts waiting.
          setSuppressed(true);
          setSuppressionSettled(true);
          // Persist the decline against the build being declined, so it
          // survives the launch that would otherwise re-ask (#605). An
          // unidentifiable build records nothing — see updateDismissal.ts.
          // The waiting worker is deliberately still left untouched: it is
          // released by Reload, by every window closing, or by the floor lever.
          void (stampQuery.current ?? readWaitingBuildStamp()).then(rememberDismissedBuild);
        }}
      >
        Not now
      </button>
    </div>
  );
}
