import { useEffect } from 'react';
import { setActiveAdultContent } from '../adultContent';

/**
 * Keeps this session's 18+ posture current (Phase 4b).
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
 * A LISTENER, NOT A POLL, and the earlier poll was a mistake worth naming
 * (Phase 4b round 3). I had reasoned that a listener would need `list`, which
 * `firestore.rules` denies on this collection. It does not: `onSnapshot` on an
 * EXACT document path is a `get`, which the rule grants — the `list` denial only
 * blocks queries. The correction matters because the poll lost the race that
 * actually matters: a Player's Prompts arrive over their own live `items`
 * listener the instant an admin approves, so a five-minute posture poll left a
 * window in which explicit content reached the screen minutes before the
 * acknowledgement gating it. The listener puts the gate on the same round trip
 * as the content.
 *
 * The mount / visibility / online triggers the poll needed are GONE with it, not
 * kept as belt-and-braces: a Firestore listener already re-delivers on
 * reconnect and after a backgrounded tab wakes, so they would be three extra
 * moving parts firing redundant reads. The adult posture is monotone, but the
 * listener stays mounted after it latches because the same document is the
 * env-pinned sign-in postcard's only live preview channel; the posture store
 * itself refuses every later attempt to lower a proven adult state.
 *
 * Renders nothing. Mounted beside the other shell-level watchers in
 * `AuthProvider` — and, unlike those, NOT gated on a signed-in user: the posture
 * decides what the signed-OUT gate renders, so it has to be tracked before there
 * is a user.
 *
 * The Firestore seam is imported DYNAMICALLY, inside the effect. `AuthProvider`
 * mounts this component, so a static import would put `data/hostnames` — and
 * through it the `db` singleton — into the module graph of every consumer of the
 * auth context, which is very nearly the whole app. `cardCache.ts` keeps its own
 * copy of the Event id for exactly this reason ("it must stay free of the
 * Firebase import graph"); same discipline, same seam. The module is already
 * loaded by `main.tsx`'s bootstrap, so the import resolves on a microtask and
 * costs nothing at runtime.
 */
export default function AdultContentWatcher(): null {
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import('../data/hostnames')
      .then(({ watchAdultContent }) => {
        if (cancelled) return;
        stop = watchAdultContent();
      })
      // If the watcher cannot even be STARTED, this session has no way to
      // observe a flip — which is the same state as a listener that errors, and
      // gets the same answer. Provisional, so a later success can lower it.
      .catch(() => setActiveAdultContent(true, { proven: false }));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return null;
}
