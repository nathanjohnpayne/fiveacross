import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIENT_BUILD_MESSAGE,
  __resetUpdateReloadForTests,
  armUncontrolledUpdateReload,
  postClientBuild,
} from './swClientBridge';

const OLD_SHELL = '2026-07-20T14:17:04.539Z';

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
});

afterEach(() => {
  document.body.innerHTML = '';
});

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
  async function armed(controller: unknown = null) {
    const registration = fakeRegistration();
    const container = fakeContainer(registration, controller);
    const reload = vi.fn();
    await armUncontrolledUpdateReload(container, reload);
    return { registration, reload };
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

  it('reloads when a deploy activates underneath the running page', async () => {
    const { registration, reload } = await armed();
    deployLands(registration);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does NOT reload on the first-ever worker, which is not an update', async () => {
    const { registration, reload } = await armed();
    const installing = fakeWorker();
    registration.installing = installing; // registration.active stays null
    registration.emit('updatefound');
    installing.become('activated');
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not arm on a CONTROLLED page, whose reload vite-plugin-pwa already drives', async () => {
    // Arming both is a double reload, and #621 warns this path is racy.
    const { registration, reload } = await armed({ scriptURL: '/sw.js' });
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
