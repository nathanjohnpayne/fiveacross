import { useEffect } from 'react';
import { adultContentSettledAdult } from '../adultContent';
import { revalidateAdultContent } from '../data/hostnames';

/**
 * Keeps this session's 18+ posture current (Phase 4b P1).
 *
 * WHAT IT FIXES. `hostnames/{host}.adultContent` is resolved once, before React
 * mounts. But the Event's pool can turn adult while a tab is open — an admin
 * approves the first explicit Prompt, the derivation stamps the routing
 * document — and a tab that only ever resolved at launch would serve the rest of
 * that session with no acknowledgement. Worse, a launch that lands INSIDE the
 * derivation's asynchronous window reads the old `false` and stays ungated for
 * the whole session even though the Event was already adult when it started.
 * #608's re-prompt path ("the existing re-prompt gate does the rest") only works
 * if something re-asks. This is that something.
 *
 * WHY POLLING AND NOT A LISTENER. A Firestore `onSnapshot` on
 * `hostnames/{host}` would be live and cheaper per client — but it is a
 * long-lived listener on a collection whose rule grants `get` and denies `list`
 * precisely so it can stay world-readable pre-auth, and the whole point of that
 * carve-out is that it serves single reads to anonymous clients. A poll keeps
 * this on the same `get` the resolver already uses, and it is trivially
 * bounded: the flag is monotone, so the poll STOPS the first time a live read
 * says `true` (`adultContentSettledAdult`). The steady state for an adult Event
 * is zero reads, not one per interval forever.
 *
 * CADENCE. Five minutes, plus an immediate read whenever the tab becomes
 * visible or the network returns — which is what actually covers the real
 * cases, since the device that matters here is a phone that has been in a
 * pocket. The interval alone would be a read per client per five minutes for
 * a never-adult Event; the event-driven reads make the interval a backstop
 * rather than the mechanism, so it is set long rather than tight.
 *
 * Renders nothing. Mounted beside the other shell-level watchers in
 * `AuthProvider` (`ConfirmWinMoments`, `PoolRecoveryWatcher`), and — unlike
 * those — NOT gated on a signed-in user: the posture decides what the
 * signed-OUT gate renders, so it has to be tracked before there is a user.
 */
export const ADULT_CONTENT_POLL_MS = 5 * 60 * 1000;

export default function AdultContentWatcher(): null {
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      // Monotone: once a live read has said `true`, nothing can change the
      // answer, so tear the whole watcher down rather than keep a dead timer.
      if (adultContentSettledAdult()) {
        stop();
        return;
      }
      if (!cancelled) void revalidateAdultContent();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    let timer: ReturnType<typeof setInterval> | null = setInterval(check, ADULT_CONTENT_POLL_MS);
    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', check);
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', check);
    // One read on mount: this is the launch-inside-the-trigger-window case, and
    // the case where startup resolution fell back to the provisional gate
    // because the network was briefly unreachable. Both want an answer now
    // rather than in five minutes.
    check();
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
  return null;
}
