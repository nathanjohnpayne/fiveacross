import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetClaimSheetOpenForTests, setClaimSheetOpen } from './hooks/useToastStack';
import {
  CLIENT_BUILD_MESSAGE,
  __resetUpdateReloadForTests,
  armUncontrolledUpdateReload,
  postClientBuild,
} from './swClientBridge';

const OLD_SHELL = '2026-07-20T14:17:04.539Z';
/** What the PAGE is executing in these tests, and the two builds either side. */
const PAGE_BUILD = '2026-08-01T09:00:00.000Z';
const NEWER_BUILD = '2026-08-09T18:30:00.000Z';

/** A ServiceWorker whose `statechange` listeners can be driven by hand. */
function fakeWorker() {
  const listeners: Array<() => void> = [];
  return {
    state: 'installing',
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
    become(state: string) {
      this.state = state;
      listeners.forEach((fn) => fn());
    },
  };
}

function fakeEmitter() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    emit: (type: string) => (listeners.get(type) ?? []).slice().forEach((fn) => fn()),
  };
}

function fakeRegistration() {
  return { ...fakeEmitter(), active: null as unknown, installing: null as ReturnType<typeof fakeWorker> | null };
}

function fakeContainer(registration: ReturnType<typeof fakeRegistration>, controller: unknown = null) {
  const container = { ...fakeEmitter(), controller, ready: Promise.resolve(registration) };
  return container as unknown as ServiceWorkerContainer & { emit(type: string): void };
}

beforeEach(() => {
  __resetUpdateReloadForTests();
  __resetClaimSheetOpenForTests();
});

afterEach(() => {
  document.body.innerHTML = '';
  hideTab(false);
});

/** jsdom reports `visible` and offers no way to change it. */
function hideTab(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
}

describe('postClientBuild (#516)', () => {
  it('names this page`s build to the controlling worker', () => {
    const controller = { postMessage: vi.fn() };
    const container = fakeContainer(fakeRegistration(), controller);
    postClientBuild(OLD_SHELL, container);
    expect(controller.postMessage).toHaveBeenCalledWith({ type: CLIENT_BUILD_MESSAGE, stamp: OLD_SHELL });
  });

  it('registers as soon as a worker takes over an UNCONTROLLED page', () => {
    // Nothing to post to at module scope, which is exactly the page the rescue
    // most needs to know about — so the post is retried on `controllerchange`.
    const container = fakeContainer(fakeRegistration());
    postClientBuild(OLD_SHELL, container);
    const controller = { postMessage: vi.fn() };
    (container as unknown as { controller: unknown }).controller = controller;
    container.emit('controllerchange');
    expect(controller.postMessage).toHaveBeenCalledWith({ type: CLIENT_BUILD_MESSAGE, stamp: OLD_SHELL });
  });

  it('is a no-op where service workers do not exist', () => {
    expect(() => postClientBuild(OLD_SHELL, undefined)).not.toThrow();
  });
});

// #621. `vite-plugin-pwa` reloads on `controlling` only when `event.isUpdate`,
// and workbox-window fixes that flag at REGISTER time from
// `Boolean(navigator.serviceWorker.controller)`. A page uncontrolled then — a
// first-ever visit, or the load right after `shellRecovery.clearShell()` — never
// reloads, and because an uncontrolled page controls nothing, a worker installed
// after a deploy does not even stop in `waiting`: it activates straight away and
// leaves the tab executing the previous build with no banner at all.
describe('armUncontrolledUpdateReload (#621)', () => {
  async function armed(options: { controller?: unknown; active?: unknown; workerStamp?: string | null } = {}) {
    const registration = fakeRegistration();
    registration.active = options.active ?? null;
    const container = fakeContainer(registration, options.controller ?? null);
    const reload = vi.fn();
    const askStamp = vi.fn(async () => options.workerStamp ?? null);
    await armUncontrolledUpdateReload(container, reload, PAGE_BUILD, askStamp);
    return { registration, reload, askStamp };
  }

  /** A deploy taking over: a worker reaches `activated` while one was already active. */
  function deployLands(registration: ReturnType<typeof fakeRegistration>) {
    registration.active = {};
    const installing = fakeWorker();
    registration.installing = installing;
    registration.emit('updatefound');
    installing.become('installed');
    installing.become('activated');
  }

  /** The FIRST worker for this registration reaching `activated`: nothing was
   *  active before it, so it is not self-evidently an update. */
  function firstWorkerActivates(registration: ReturnType<typeof fakeRegistration>) {
    const installing = fakeWorker();
    registration.installing = installing; // registration.active stays null
    registration.emit('updatefound');
    installing.become('activated');
  }

  it('reloads when a deploy activates underneath the running page', async () => {
    const { registration, reload } = await armed();
    deployLands(registration);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does NOT reload on a first worker that carries the build this page is running', async () => {
    const { registration, reload } = await armed({ workerStamp: PAGE_BUILD });
    firstWorkerActivates(registration);
    await vi.waitFor(() => expect(reload).not.toHaveBeenCalled());
  });

  it('does not arm on a CONTROLLED page, whose reload vite-plugin-pwa already drives', async () => {
    // Arming both is a double reload, and #621 warns this path is racy.
    const { registration, reload } = await armed({ controller: { scriptURL: '/sw.js' } });
    deployLands(registration);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads at most once per page lifetime', async () => {
    const { registration, reload } = await armed();
    deployLands(registration);
    deployLands(registration);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('waits rather than yanking a tab with a modal sheet on screen', async () => {
    const { registration, reload } = await armed();
    document.body.innerHTML = '<div role="dialog" aria-modal="true">proof capture</div>';
    deployLands(registration);
    expect(reload).not.toHaveBeenCalled();
    document.body.innerHTML = '';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reload).toHaveBeenCalledOnce();
  });
});

// Codex P1. `ProofSheet` renders as `.sheet.claim-sheet` and carries NEITHER
// `role="dialog"` nor `aria-modal="true"`, so the generic modal query never saw
// the one sheet whose contents a reload actually DESTROYS: a selected photo, a
// recorded audio clip, or typed callout text, all React state and nothing else
// until the player submits. An uncontrolled page can be reloaded by this module
// without `UpdatePrompt` ever appearing, so its own claim-sheet defer is no
// protection here.
describe('the automatic reload defers to a proof capture in progress', () => {
  async function armedWithDeploy() {
    const registration = fakeRegistration();
    const container = fakeContainer(registration);
    const reload = vi.fn();
    await armUncontrolledUpdateReload(container, reload, PAGE_BUILD, async () => null);
    return {
      reload,
      land() {
        registration.active = {};
        const installing = fakeWorker();
        registration.installing = installing;
        registration.emit('updatefound');
        installing.become('activated');
      },
    };
  }

  it('waits while the claim sheet is open, and reloads once it closes', async () => {
    const { reload, land } = await armedWithDeploy();
    setClaimSheetOpen(true);
    land();
    expect(reload).not.toHaveBeenCalled();
    setClaimSheetOpen(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('waits even on a HIDDEN tab, because taking the photo is what hid it', async () => {
    // The visibility gate is right for an ordinary modal and wrong here: the
    // camera and the file picker take the foreground, and that in-flight
    // capture is exactly the work a reload would throw away.
    const { reload, land } = await armedWithDeploy();
    setClaimSheetOpen(true);
    hideTab(true);
    land();
    expect(reload).not.toHaveBeenCalled();
    setClaimSheetOpen(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('still reloads a hidden tab with no capture in progress', async () => {
    const { reload, land } = await armedWithDeploy();
    hideTab(true);
    land();
    expect(reload).toHaveBeenCalledOnce();
  });
});

// Codex P1. A first worker is not guaranteed to be the build the page is
// running: `UpdatePrompt` registers only once React mounts, and hostname
// resolution or a slow bundle download leaves room for a deploy to land between
// this document and the `/sw.js` fetch.
describe('the first worker is only trusted once it names the page`s build', () => {
  async function armed(options: { active?: unknown; workerStamp?: string | null }) {
    const registration = fakeRegistration();
    registration.active = options.active ?? null;
    const container = fakeContainer(registration);
    const reload = vi.fn();
    const askStamp = vi.fn(async () => options.workerStamp ?? null);
    await armUncontrolledUpdateReload(container, reload, PAGE_BUILD, askStamp);
    return { registration, reload, askStamp };
  }

  it('reloads when the worker already active at arm time serves a NEWER build', async () => {
    // `container.ready` does not resolve until some worker is active, so on a
    // first-ever registration that worker's `updatefound` is already history —
    // the stamp comparison is the only thing left that can notice.
    const { reload, askStamp } = await armed({ active: { id: 'sw-b' }, workerStamp: NEWER_BUILD });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(askStamp).toHaveBeenCalledWith({ id: 'sw-b' });
  });

  it('leaves the page alone when that worker carries the same build', async () => {
    const { reload } = await armed({ active: { id: 'sw-a' }, workerStamp: PAGE_BUILD });
    await vi.waitFor(() => expect(reload).not.toHaveBeenCalled());
  });

  it('leaves the page alone when the worker cannot name its build', async () => {
    // A pre-#605 worker, a dropped port, a worker killed mid-question: silence
    // is not evidence of a mismatch, and a needless reload discards the work
    // the player did while the first precache installed.
    const { reload } = await armed({ active: { id: 'sw-?' }, workerStamp: null });
    await vi.waitFor(() => expect(reload).not.toHaveBeenCalled());
  });

  it('never walks the page BACKWARDS onto an older worker', async () => {
    // The reload is served by that worker's precache, so "different" is not
    // enough — only strictly newer is a repair.
    const { reload } = await armed({ active: { id: 'sw-old' }, workerStamp: OLD_SHELL });
    await vi.waitFor(() => expect(reload).not.toHaveBeenCalled());
  });

  it('reloads when a first worker ACTIVATES carrying a newer build than the page', async () => {
    // The branch Codex flagged: `registration.active` is null at `updatefound`,
    // so the old code declined to listen at all and the build-A page stayed
    // stale indefinitely under build B.
    const { registration, reload } = await armed({ workerStamp: NEWER_BUILD });
    const installing = fakeWorker();
    registration.installing = installing;
    registration.emit('updatefound');
    installing.become('activated');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });
});
