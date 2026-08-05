import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import UpdatePrompt, { FLOOR_RECHECK_INTERVAL_MS } from './UpdatePrompt';
import { __resetToastStackForTests, __resetClaimSheetOpenForTests, setClaimSheetOpen } from '../hooks/useToastStack';
import { BUILD_STAMP_REPLY, DISMISSED_BUILD_KEY } from '../updateDismissal';

// Covers specs/app-update-reload-prompt.md: the needRefresh-driven reload banner
// (Reload activates the waiting service worker via updateServiceWorker(true),
// Not now declines the waiting BUILD), the periodic registration.update() check
// that lets a long-lived tab discover a new deploy (skipped while offline), and
// the update-prompt-visible body class that reserves .app's bottom clearance
// while the banner is up (mirroring InstallPrompt's mechanism, specs/w1-pwa.md).

const VISIBLE_CLASS = 'update-prompt-visible';

type RegisterSWOptions = {
  onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
};

// Stateful stand-in for virtual:pwa-register/react (a Vite virtual module —
// nothing real to import under Vitest). Backing needRefresh with real useState
// lets "Not now" actually hide the banner instead of only asserting a setter
// was called with false.
const { swState } = vi.hoisted(() => ({
  swState: {
    initialNeedRefresh: false,
    updateServiceWorker: vi.fn<(reloadPage?: boolean) => Promise<void>>(),
    capturedOptions: undefined as RegisterSWOptions | undefined,
    // Last rendered value of needRefresh. The #342 force path keys off this
    // flag, so "Not now" clearing it would silently disarm the emergency lever
    // (Phase 4b P1 on #605) — recording it makes that invariant assertable
    // rather than merely argued.
    lastNeedRefresh: false,
  },
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: RegisterSWOptions) => {
    swState.capturedOptions = options;
    const [needRefresh, setNeedRefresh] = useState(swState.initialNeedRefresh);
    swState.lastNeedRefresh = needRefresh;
    const [offlineReady, setOfflineReady] = useState(false);
    return {
      needRefresh: [needRefresh, setNeedRefresh],
      offlineReady: [offlineReady, setOfflineReady],
      updateServiceWorker: swState.updateServiceWorker,
    };
  },
}));

/**
 * A registration whose update() resolves. Also carries the lifecycle surface
 * the component now uses to notice a REPLACEMENT waiting worker (#605):
 * `addEventListener('updatefound')`, a mutable `installing`/`waiting`, and a
 * `__fire` helper to dispatch. `__fire` dispatches at the listener directly —
 * it proves the component's reaction, not that a browser fires `updatefound`.
 */
function makeRegistration() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    update: vi.fn().mockResolvedValue(undefined),
    waiting: null,
    installing: null,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    }),
    __fire: (type: string) => (listeners.get(type) ?? []).forEach((fn) => fn()),
  } as unknown as ServiceWorkerRegistration & {
    update: ReturnType<typeof vi.fn>;
    waiting: ServiceWorker | null;
    installing: ServiceWorker | null;
    __fire: (type: string) => void;
  };
}

/** A worker in `installing`, whose statechange listeners can be dispatched. */
function makeInstallingWorker() {
  const listeners: Array<() => void> = [];
  return {
    state: 'installing',
    addEventListener: vi.fn((_type: string, fn: () => void) => void listeners.push(fn)),
    __fire: () => listeners.forEach((fn) => fn()),
  } as unknown as ServiceWorker & { state: string; __fire: () => void };
}

/** Minimal in-memory localStorage stand-in — same stub + rationale as
 *  src/components/w1-pwa.test.tsx. The per-build decline (#605) lives here. */
function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

/**
 * Stubs `navigator.serviceWorker` with a waiting worker that names itself
 * (#605). jsdom has no service workers, so this is a stand-in for the
 * `GET_BUILD_STAMP` round trip, not proof that a real waiting worker is
 * reachable — see the honesty note in `src/updateDismissal.test.ts`.
 */
function stubWaitingBuild(stamp: string, replyDelayMs = 0) {
  vi.stubGlobal('navigator', {
    ...window.navigator,
    serviceWorker: {
      getRegistration: async () => ({
        waiting: {
          postMessage: (_message: unknown, ports: MessagePort[]) =>
            setTimeout(() => ports[0].postMessage({ type: BUILD_STAMP_REPLY, stamp }), replyDelayMs),
        },
      }),
    },
  });
}

/** Lets the floor read and the (MessagePort-delivered) stamp reply land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

describe('UpdatePrompt', () => {
  beforeEach(() => {
    swState.initialNeedRefresh = false;
    swState.updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    swState.capturedOptions = undefined;
    // Shared module singletons (#219) — reset between tests.
    __resetToastStackForTests();
    __resetClaimSheetOpenForTests();
    // The per-build decline (#605) is localStorage-backed; the runtime's own
    // global is not usable under Vitest, so every test gets a fresh stand-in.
    vi.stubGlobal('localStorage', createStorageStub());
    // Inert floor by default (#342): the banner holds until the first
    // /build-floor.json read settles, so every banner test needs a floor
    // response. Individual tests re-stub for stale-floor scenarios.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ floor: '1970-01-01T00:00:00.000Z' }),
      } as unknown as Response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // Defensive: the component's effect cleanup already removes this on unmount
    // (RTL auto-cleanup), but a leaked body class would poison later tests.
    document.body.classList.remove(VISIBLE_CLASS);
  });

  it('renders nothing (and never sets the body class) while no update is pending', () => {
    render(<UpdatePrompt />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.classList.contains(VISIBLE_CLASS)).toBe(false);
  });

  it('shows the banner when a new version is waiting, and Reload activates it with a page reload', async () => {
    swState.initialNeedRefresh = true;
    const user = userEvent.setup();
    render(<UpdatePrompt />);
    // findByRole: the banner now waits for the first /build-floor.json read
    // (#342) before offering; the inert-floor stub settles it immediately.
    expect(await screen.findByRole('status')).toHaveTextContent(/fresh build just docked/i);
    await user.click(screen.getByRole('button', { name: /reload/i }));
    expect(swState.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('defers while a claim sheet is open, and shows once it closes (#219)', async () => {
    swState.initialNeedRefresh = true;
    act(() => setClaimSheetOpen(true));
    render(<UpdatePrompt />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => setClaimSheetOpen(false));
    expect(await screen.findByRole('status')).toHaveTextContent(/fresh build just docked/i);
  });

  it('"Not now" hides the banner without touching the waiting worker', async () => {
    swState.initialNeedRefresh = true;
    const user = userEvent.setup();
    render(<UpdatePrompt />);
    await user.click(await screen.findByRole('button', { name: /not now/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(swState.updateServiceWorker).not.toHaveBeenCalled();
  });

  it('toggles update-prompt-visible on <body> while the banner is up, and clears it on dismiss', async () => {
    swState.initialNeedRefresh = true;
    const user = userEvent.setup();
    render(<UpdatePrompt />);
    await screen.findByRole('status');
    expect(document.body.classList.contains(VISIBLE_CLASS)).toBe(true);
    await user.click(screen.getByRole('button', { name: /not now/i }));
    expect(document.body.classList.contains(VISIBLE_CLASS)).toBe(false);
  });

  it('arms a periodic registration.update() check so a long-lived tab discovers a new deploy', () => {
    vi.useFakeTimers();
    render(<UpdatePrompt />);
    const registration = makeRegistration();
    swState.capturedOptions?.onRegisteredSW?.('/sw.js', registration);
    expect(registration.update).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(registration.update).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(registration.update).toHaveBeenCalledTimes(3);
  });

  it('skips the update check while offline (navigator.onLine === false)', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { ...window.navigator, onLine: false });
    render(<UpdatePrompt />);
    const registration = makeRegistration();
    swState.capturedOptions?.onRegisteredSW?.('/sw.js', registration);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(registration.update).not.toHaveBeenCalled();
  });

  it('tolerates a registration.update() rejection (transient network failure) without unhandled errors', async () => {
    vi.useFakeTimers();
    render(<UpdatePrompt />);
    const registration = {
      update: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as ServiceWorkerRegistration;
    swState.capturedOptions?.onRegisteredSW?.('/sw.js', registration);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      // let the rejected promise's catch handler run
      await Promise.resolve();
    });
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it('does nothing when registration is unavailable (no SW support)', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(<UpdatePrompt />);
    swState.capturedOptions?.onRegisteredSW?.('/sw.js', undefined);
    // The SW-update poll (60s cadence) must not arm without a registration.
    // The component's OWN floor-recheck interval (#342) is expected and
    // registration-independent, so the assertion pins the cadence, not "any".
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 60_000);
    setIntervalSpy.mockRestore();
  });

  it('force-activates a waiting SW without offering the banner when the running build is below the served floor (#342)', async () => {
    swState.initialNeedRefresh = true;
    // Served floor far in the future ⇒ the test build's __BUILD_STAMP__ is below it.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ floor: '2999-01-01T00:00:00.000Z' }),
      } as unknown as Response),
    );
    render(<UpdatePrompt />);
    await waitFor(() => expect(swState.updateServiceWorker).toHaveBeenCalledWith(true));
    // No offer, no body class — the stale client reloads instead of being asked.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.classList.contains(VISIBLE_CLASS)).toBe(false);
  });

  it('keeps the normal offer when the served floor is inert (older than the build) (#342)', async () => {
    swState.initialNeedRefresh = true;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ floor: '1970-01-01T00:00:00.000Z' }),
      } as unknown as Response),
    );
    render(<UpdatePrompt />);
    expect(await screen.findByRole('status')).toHaveTextContent(/fresh build just docked/i);
    expect(swState.updateServiceWorker).not.toHaveBeenCalled();
  });

  it('a floor bump observed AFTER "Not now" still forces the reload — dismissal cannot defeat the floor (#342)', async () => {
    swState.initialNeedRefresh = true;
    vi.useFakeTimers();
    // First read: inert (normal offer). Every later read: bumped above the build.
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        reads += 1;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              floor: reads === 1 ? '1970-01-01T00:00:00.000Z' : '2999-01-01T00:00:00.000Z',
            }),
        } as unknown as Response);
      }),
    );
    render(<UpdatePrompt />);
    // Settle the first floor read (microtasks only — no timers involved).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(swState.updateServiceWorker).not.toHaveBeenCalled();
    // The operator bumps the floor; the periodic re-read observes it and the
    // force fires off the waiting-SW latch, dismissal notwithstanding.
    await act(async () => {
      vi.advanceTimersByTime(FLOOR_RECHECK_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(swState.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  // --- Per-build dismissal (#605) -------------------------------------------
  //
  // WHAT THESE CANNOT PROVE, stated rather than implied (the #513/#517 lesson).
  // A "relaunch" here is an unmount and a fresh mount with `needRefresh` true
  // again — a faithful model of what the browser does, because workbox-window
  // re-dispatches `waiting` for an already-waiting worker on every
  // registration, but a MODEL nonetheless. jsdom runs no service worker, so
  // nothing below proves the browser delivers `GET_BUILD_STAMP` to a worker in
  // the `waiting` state; only a real browser can. What they do prove is the
  // decision this component makes once an identity is (or is not) available.

  it('"Not now" declines the WAITING BUILD, so the same build does not re-ask on the next launch (#605)', async () => {
    swState.initialNeedRefresh = true;
    stubWaitingBuild('2026-08-04T12:00:00.000Z');
    const user = userEvent.setup();
    const first = render(<UpdatePrompt />);
    await user.click(await screen.findByRole('button', { name: /not now/i }));
    expect(localStorage.getItem(DISMISSED_BUILD_KEY)).toBe('2026-08-04T12:00:00.000Z');
    first.unmount();

    // The relaunch: the same worker is still waiting, so needRefresh is true
    // again from the first render — which is exactly why the old in-memory
    // dismissal re-prompted every launch.
    render(<UpdatePrompt />);
    await settle();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.classList.contains(VISIBLE_CLASS)).toBe(false);
  });

  it('a genuinely NEWER waiting build prompts again after a decline (#605)', async () => {
    swState.initialNeedRefresh = true;
    stubWaitingBuild('2026-08-04T12:00:00.000Z');
    const user = userEvent.setup();
    const first = render(<UpdatePrompt />);
    await user.click(await screen.findByRole('button', { name: /not now/i }));
    first.unmount();

    // Next deploy: a different worker is waiting, and the decline named the
    // previous one — so the toast is back to marking a transition.
    stubWaitingBuild('2026-08-05T09:00:00.000Z');
    render(<UpdatePrompt />);
    expect(await screen.findByRole('status')).toHaveTextContent(/fresh build just docked/i);
  });

  it('declining a build the waiting worker cannot name suppresses nothing — the pre-#605 transition (#605)', async () => {
    // No serviceWorker stub at all: the query resolves null, exactly as it does
    // against a worker built before the GET_BUILD_STAMP handler existed. Fail
    // open — one more prompt is the honest outcome, not a silent forever-mute.
    swState.initialNeedRefresh = true;
    const user = userEvent.setup();
    const first = render(<UpdatePrompt />);
    await user.click(await screen.findByRole('button', { name: /not now/i }));
    expect(localStorage.length).toBe(0);
    first.unmount();

    render(<UpdatePrompt />);
    expect(await screen.findByRole('status')).toHaveTextContent(/fresh build just docked/i);
  });

  it('records the decline even when the player taps "Not now" before the build is identified (#605)', async () => {
    // Nothing has been declined yet, so the banner is offered WITHOUT waiting
    // on the identity query — which means the tap can beat the answer. The
    // handler awaits the same in-flight query rather than reading a
    // not-yet-settled value, so the decline still names the right build.
    swState.initialNeedRefresh = true;
    stubWaitingBuild('2026-08-04T12:00:00.000Z', 40);
    const user = userEvent.setup();
    render(<UpdatePrompt />);
    await user.click(await screen.findByRole('button', { name: /not now/i }));
    expect(localStorage.getItem(DISMISSED_BUILD_KEY)).toBeNull(); // the answer is still out
    await waitFor(() => expect(localStorage.getItem(DISMISSED_BUILD_KEY)).toBe('2026-08-04T12:00:00.000Z'));
  });

  it('re-opens the offer when a REPLACEMENT worker starts waiting mid-session (#605)', async () => {
    // The mid-session case a boolean cannot report. `needRefresh` is ALREADY
    // true while build A is suppressed, so workbox re-raising it when build B
    // installs is a React no-op — only the change of waiting-worker identity
    // can re-open the question. Without that, a tab that declined A would
    // suppress B for the rest of its life.
    swState.initialNeedRefresh = true;
    stubWaitingBuild('2026-08-04T12:00:00.000Z');
    localStorage.setItem(DISMISSED_BUILD_KEY, '2026-08-04T12:00:00.000Z');
    const registration = makeRegistration();
    render(<UpdatePrompt />);
    act(() => swState.capturedOptions?.onRegisteredSW?.('/sw.js', registration));
    await settle();
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); // A is declined

    // The next deploy installs while this tab stays open.
    stubWaitingBuild('2026-08-05T09:00:00.000Z');
    const installing = makeInstallingWorker();
    registration.installing = installing;
    act(() => registration.__fire('updatefound'));
    // ...and reaches `waiting`, which is when its identity is settled.
    registration.waiting = {} as ServiceWorker;
    (installing as unknown as { state: string }).state = 'installed';
    act(() => installing.__fire());

    expect(await screen.findByRole('status')).toHaveTextContent(/fresh build just docked/i);
    expect(swState.lastNeedRefresh).toBe(true);
  });

  it('"Not now" leaves needRefresh true, so a floor bump AFTER the decline still forces (#605/#342)', async () => {
    // The invariant, asserted rather than argued: the decline hides the offer
    // through its OWN state and leaves `needRefresh` — which the #342 force
    // path keys off — true, because a worker really is still waiting. Honest
    // about what each half proves: the force below also survives a cleared
    // flag, since #342's `sawWaitingSW` ref latch was added for exactly the old
    // dismissal behaviour, so it is the `lastNeedRefresh` assertion that pins
    // the flag itself and stops the lever resting on that latch alone.
    // Distinct from the stored-dismissal case below, which starts from a
    // decline made in an earlier session.
    swState.initialNeedRefresh = true;
    vi.useFakeTimers();
    stubWaitingBuild('2026-08-04T12:00:00.000Z');
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        reads += 1;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              floor: reads === 1 ? '1970-01-01T00:00:00.000Z' : '2999-01-01T00:00:00.000Z',
            }),
        } as unknown as Response);
      }),
    );
    render(<UpdatePrompt />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(swState.updateServiceWorker).not.toHaveBeenCalled();
    expect(swState.lastNeedRefresh).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(FLOOR_RECHECK_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(swState.updateServiceWorker).toHaveBeenCalledWith(true);
    // Deliberately not asserted here: whether the decline reached storage. This
    // test drives a 10-minute clock forward while the identity reply is still in
    // flight, and jsdom queues MessagePort delivery outside the faked clock, so
    // the query's own timeout wins the race — an artifact of the fake clock, not
    // of the component. Persistence is covered by the three tests above.
  });

  it('a DECLINED build is still force-activated when the floor condemns the running one (#605/#342)', async () => {
    // The decline hides the offer; it must not disarm the emergency lever.
    // `needRefresh` stays true underneath, so the waiting-SW latch still arms.
    swState.initialNeedRefresh = true;
    stubWaitingBuild('2026-08-04T12:00:00.000Z');
    localStorage.setItem(DISMISSED_BUILD_KEY, '2026-08-04T12:00:00.000Z');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ floor: '2999-01-01T00:00:00.000Z' }),
      } as unknown as Response),
    );
    render(<UpdatePrompt />);
    await waitFor(() => expect(swState.updateServiceWorker).toHaveBeenCalledWith(true));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
