import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/dom';

const H = vi.hoisted(() => ({
  user: { uid: 'alice' } as { uid: string } | null,
  ready: vi.fn(), initialize: vi.fn(), server: vi.fn(), drain: vi.fn(),
  terminate: vi.fn(), clear: vi.fn(), replace: vi.fn(), order: [] as string[],
  db: { name: 'legacy-persistent' },
}));
vi.mock('../firebaseCore', () => ({
  app: { name: 'gameplay' }, firebaseConfig: { projectId: 'demo-recovery-page' },
  firebaseEmulatorsEnabled: () => false,
}));
vi.mock('../firebaseAuth', () => ({ auth: {
  get currentUser() { return H.user; }, authStateReady: H.ready,
} }));
vi.mock('firebase/firestore', () => ({
  initializeFirestore: H.initialize, persistentLocalCache: (options: unknown) => options,
  persistentMultipleTabManager: () => ({ kind: 'multi-tab' }), connectFirestoreEmulator: vi.fn(),
  doc: (_db: unknown, collection: string, uid: string) => ({ collection, uid }),
  getDocFromServer: H.server, waitForPendingWrites: H.drain,
  terminate: H.terminate, clearIndexedDbPersistence: H.clear,
}));
import { renderPrivateCacheRecovery } from './privateCacheRecoveryPage';
import { privateCacheRecovered, privateCacheRecoveryKey } from './privateCacheRecoveryMarker';

const project = 'demo-recovery-page';
function confirmBoth() {
  const boxes = screen.getAllByRole('checkbox');
  boxes.forEach(box => fireEvent.click(box));
  return screen.getByRole('button', { name: 'Clear recovered cache' });
}
function failure() { return screen.getByRole('status'); }
beforeEach(() => {
  vi.clearAllMocks(); H.user = { uid: 'alice' }; H.order = [];
  document.body.innerHTML = '<div id="root"></div>';
  const browserWindow = window;
  vi.stubGlobal('window', new Proxy(browserWindow, {
    get(target, key) {
      return key === 'location'
        ? { href: 'https://event.example/#device-cache-recovery', replace: H.replace }
        : Reflect.get(target, key, target);
    },
  }));
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  H.ready.mockResolvedValue(undefined);
  H.initialize.mockImplementation(() => { H.order.push('initialize'); return H.db; });
  H.server.mockImplementation(async () => { H.order.push('server'); });
  H.drain.mockImplementation(async () => { H.order.push('drain'); });
  H.terminate.mockImplementation(async () => { H.order.push('terminate'); });
  H.clear.mockImplementation(async () => { H.order.push('clear'); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('attended recovery document DOM (#1411)', () => {
  it('opens no cache and clears nothing until both attended confirmations', async () => {
    renderPrivateCacheRecovery();
    const finish = screen.getByRole('button', { name: 'Clear recovered cache' });
    expect(finish).toBeDisabled(); finish.click();
    expect(H.ready).not.toHaveBeenCalled(); expect(H.initialize).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(finish).toBeDisabled(); finish.click();
    expect(H.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('checkbox')[1]); finish.click();
    await waitFor(() => expect(H.replace).toHaveBeenCalledWith('https://event.example/'));
    expect(H.order).toEqual(['initialize', 'server', 'drain', 'terminate', 'clear']);
    expect(H.server).toHaveBeenCalledWith({ collection: 'users', uid: 'alice' });
    expect(privateCacheRecovered(project)).toBe(true);
  });
  it.each(['ready', 'server', 'drain', 'terminate', 'clear'] as const)('keeps private views closed on %s failure and requires a fresh document', async stage => {
    H[stage].mockRejectedValueOnce(new Error('SDK refusal'));
    renderPrivateCacheRecovery(); confirmBoth().click();
    await waitFor(() => expect(failure()).toHaveTextContent('Recovery did not complete'));
    expect(privateCacheRecovered(project)).toBe(false);
    expect(screen.getByRole('button', { name: 'Clear recovered cache' })).toBeDisabled();
    expect(screen.getAllByRole('checkbox').every(box => (box as HTMLInputElement).disabled)).toBe(true);
    expect(H.replace).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Return to the app' }).click();
    expect(H.replace).toHaveBeenCalledWith('https://event.example/');
    // A new document starts from unchecked consent, never an in-place clear retry.
    renderPrivateCacheRecovery();
    expect(screen.getAllByRole('checkbox').every(box => !(box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Clear recovered cache' })).toBeDisabled();
  });
  it('refuses an account switch after server proof without draining or recording', async () => {
    H.server.mockImplementation(async () => { H.user = { uid: 'bob' }; });
    renderPrivateCacheRecovery(); confirmBoth().click();
    await waitFor(() => expect(failure()).toHaveTextContent('Recovery did not complete'));
    expect(H.drain).not.toHaveBeenCalled(); expect(H.clear).not.toHaveBeenCalled();
    expect(privateCacheRecovered(project)).toBe(false);
  });
  it('bounds Auth readiness before opening the legacy cache', async () => {
    vi.useFakeTimers(); H.ready.mockReturnValue(new Promise(() => {}));
    renderPrivateCacheRecovery(); confirmBoth().click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(failure()).toHaveTextContent('Recovery did not complete');
    expect(H.initialize).not.toHaveBeenCalled(); expect(privateCacheRecovered(project)).toBe(false);
  });
  it('ignores late drain completion after timeout and leaves retry to a fresh document', async () => {
    vi.useFakeTimers(); let settle = () => {};
    H.drain.mockReturnValue(new Promise<void>(resolve => { settle = resolve; }));
    renderPrivateCacheRecovery(); confirmBoth().click();
    await vi.advanceTimersByTimeAsync(10001);
    expect(failure()).toHaveTextContent('Recovery did not complete');
    settle(); await vi.advanceTimersByTimeAsync(0);
    expect(H.terminate).not.toHaveBeenCalled(); expect(H.clear).not.toHaveBeenCalled();
    expect(privateCacheRecovered(project)).toBe(false);
  });
  it.each(['throw', 'silent-noop'] as const)('refuses completion when recovery marker storage is %s', async mode => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      if (mode === 'throw') throw new Error('Storage denied');
    });
    renderPrivateCacheRecovery(); confirmBoth().click();
    await waitFor(() => expect(failure()).toHaveTextContent('Recovery did not complete'));
    expect(H.clear).toHaveBeenCalledOnce(); expect(H.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(privateCacheRecoveryKey(project))).toBeNull();
    expect(privateCacheRecovered(project)).toBe(false);
  });
});
