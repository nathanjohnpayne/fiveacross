import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/dom';

const H = vi.hoisted(() => ({
  user: { uid: 'alice' } as { uid: string } | null,
  ready: vi.fn(), initialize: vi.fn(), server: vi.fn(), drain: vi.fn(),
  terminate: vi.fn(), clear: vi.fn(), replace: vi.fn(), reload: vi.fn(), order: [] as string[],
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
import { privateCacheRecoveryTelemetryKey } from './privateCacheRecoveryTelemetry';

const project = 'demo-recovery-page';
function confirmBoth() {
  const boxes = screen.getAllByRole('checkbox');
  boxes.forEach(box => fireEvent.click(box));
  return finishButton();
}
function failure() { return screen.getByRole('alert'); }
// A hidden button has no accessible name, so query it by its text.
function finishButton() { return screen.getByText('Clear recovered cache', { selector: 'button' }); }
function status() { return screen.getByRole('status'); }
function attendedBoxes() { return screen.getAllByRole('checkbox').slice(0, 2) as HTMLInputElement[]; }
function acceptUnverified() {
  const boxes = screen.getAllByRole('checkbox').slice(2);
  expect(boxes).toHaveLength(2);
  const proceed = screen.getByRole('button', { name: 'Clear cache without verification' });
  expect(proceed).toBeDisabled();
  fireEvent.click(boxes[0]); expect(proceed).toBeDisabled();
  fireEvent.click(boxes[1]); expect(proceed).not.toBeDisabled();
  return proceed;
}
async function failAttended() {
  renderPrivateCacheRecovery(); confirmBoth().click();
  await waitFor(() => expect(failure()).toHaveTextContent('Recovery did not complete'));
}
beforeEach(() => {
  vi.clearAllMocks(); H.user = { uid: 'alice' }; H.order = [];
  document.body.innerHTML = '<div id="root"></div>';
  const browserWindow = window;
  vi.stubGlobal('window', new Proxy(browserWindow, {
    get(target, key) {
      return key === 'location'
        ? { href: 'https://event.example/more?keep=visible&device-cache-recovery=1#old-panel', replace: H.replace, reload: H.reload }
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
  it('installs its own stylesheet once and themes the document', () => {
    renderPrivateCacheRecovery(); renderPrivateCacheRecovery();
    expect(document.querySelectorAll('style#device-cache-recovery-style')).toHaveLength(1);
    expect(document.body).toHaveClass('rec-page');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Finish device recovery');
  });
  it('opens no cache and clears nothing until both attended confirmations', async () => {
    renderPrivateCacheRecovery();
    const finish = finishButton();
    expect(finish).toBeDisabled(); finish.click();
    expect(H.ready).not.toHaveBeenCalled(); expect(H.initialize).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(finish).toBeDisabled(); finish.click();
    expect(H.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('checkbox')[1]); finish.click();
    await waitFor(() => expect(H.replace).toHaveBeenCalledWith('https://event.example/more?keep=visible'));
    expect(H.order).toEqual(['initialize', 'server', 'drain', 'terminate', 'clear']);
    expect(H.server).toHaveBeenCalledWith({ collection: 'users', uid: 'alice' });
    expect(privateCacheRecovered(project)).toBe(true);
  });
  it.each(['ready', 'server', 'drain', 'terminate', 'clear'] as const)('keeps private views closed on %s failure and requires a fresh document', async stage => {
    H[stage].mockRejectedValueOnce(new Error('SDK refusal'));
    renderPrivateCacheRecovery(); confirmBoth().click();
    await waitFor(() => expect(failure()).toHaveTextContent('Recovery did not complete'));
    expect(privateCacheRecovered(project)).toBe(false);
    expect(finishButton()).toBeDisabled();
    expect(attendedBoxes().every(box => box.disabled)).toBe(true);
    expect(failure()).toHaveTextContent('SDK refusal');
    expect(H.replace).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Return to the app' }).click();
    expect(H.replace).toHaveBeenCalledWith('https://event.example/more?keep=visible');
    // A new document starts from unchecked consent, never an in-place clear retry.
    renderPrivateCacheRecovery();
    expect(screen.getAllByRole('checkbox').every(box => !(box as HTMLInputElement).checked)).toBe(true);
    expect(finishButton()).toBeDisabled();
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
  it.each(['resolve', 'reject', 'never'] as const)('quarantines the document until a timed-out clear actually settles (%s)', async outcome => {
    vi.useFakeTimers();
    let resolveClear = () => {};
    let rejectClear = (_error: Error) => {};
    H.clear.mockReturnValue(new Promise<void>((resolve, reject) => {
      resolveClear = resolve; rejectClear = reject;
    }));
    renderPrivateCacheRecovery(); confirmBoth().click();
    await vi.advanceTimersByTimeAsync(10001);
    expect(H.clear).toHaveBeenCalledOnce();
    expect(status()).toHaveTextContent('Still waiting for cache clearing');
    const back = screen.getByRole('button', { name: 'Return to the app' });
    expect(back).toBeDisabled(); back.click();
    expect(H.replace).not.toHaveBeenCalled();
    expect(privateCacheRecovered(project)).toBe(false);
    expect(finishButton()).toBeDisabled();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60000);
    expect(back).toBeDisabled(); expect(H.replace).not.toHaveBeenCalled();
    if (outcome === 'never') return;
    if (outcome === 'resolve') resolveClear(); else rejectClear(new Error('late clear refusal'));
    await vi.advanceTimersByTimeAsync(0);
    expect(failure()).toHaveTextContent('Recovery did not complete');
    expect(privateCacheRecovered(project)).toBe(false);
    expect(H.replace).not.toHaveBeenCalled();
    expect(back).not.toBeDisabled(); back.click();
    expect(H.replace).toHaveBeenCalledOnce();
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

describe('failed recovery offers a warned way forward (#1886)', () => {
  it('names the failure, keeps the attended path closed and retries in a fresh document', async () => {
    H.clear.mockRejectedValueOnce(Object.assign(new Error('held'), { code: 'failed-precondition' }));
    await failAttended();
    expect(failure()).toHaveTextContent('Another tab or window still has the app open');
    expect(finishButton()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Clear cache without verification' })).toBeDisabled();
    expect(document.querySelector('.rec-warn')).toHaveTextContent('for any account used on this device, will be permanently lost.');
    // The verified retry replaces the hidden finish; the escape hatch starts collapsed.
    expect(finishButton().hidden).toBe(true);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    const hatch = document.querySelector('details.rec-hatch') as HTMLDetailsElement;
    expect(hatch.open).toBe(false);
    expect(hatch.querySelector('summary')).toHaveTextContent('Recovery keeps failing?');
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(H.reload).toHaveBeenCalledOnce();
    expect(privateCacheRecovered(project)).toBe(false);
  });
  it('does not offer the unverified path before an attended attempt fails', () => {
    renderPrivateCacheRecovery();
    expect(screen.queryByRole('button', { name: 'Clear cache without verification' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
  it.each(['signed-out', 'offline'] as const)('clears and unlocks %s after explicit loss acceptance', async condition => {
    if (condition === 'signed-out') H.user = null;
    else vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await failAttended();
    expect(failure()).toHaveTextContent('sign in online first');
    expect(H.initialize).not.toHaveBeenCalled();
    acceptUnverified().click();
    await waitFor(() => expect(H.replace).toHaveBeenCalledWith('https://event.example/more?keep=visible'));
    expect(H.order).toEqual(['initialize', 'terminate', 'clear']);
    expect(H.server).not.toHaveBeenCalled(); expect(H.drain).not.toHaveBeenCalled();
    expect(privateCacheRecovered(project)).toBe(true);
  });
  it('reuses the instance a failed attended attempt opened', async () => {
    H.drain.mockRejectedValueOnce(new Error('drain refused'));
    await failAttended();
    acceptUnverified().click();
    await waitFor(() => expect(H.replace).toHaveBeenCalledOnce());
    expect(H.initialize).toHaveBeenCalledOnce();
    expect(H.drain).toHaveBeenCalledOnce();
    expect(H.order).toEqual(['initialize', 'server', 'terminate', 'clear']);
    expect(H.terminate).toHaveBeenCalledWith(H.db); expect(H.clear).toHaveBeenCalledWith(H.db);
    expect(privateCacheRecovered(project)).toBe(true);
  });
  it('keeps private views closed when the unverified clear fails', async () => {
    H.user = null;
    await failAttended();
    H.clear.mockRejectedValueOnce(Object.assign(new Error('held'), { code: 'failed-precondition' }));
    acceptUnverified().click();
    await waitFor(() => expect(failure()).toHaveTextContent('Clearing did not complete'));
    expect(failure()).toHaveTextContent('Another tab or window still has the app open');
    expect(privateCacheRecovered(project)).toBe(false);
    expect(H.replace).not.toHaveBeenCalled();
    // Feedback moves under the pressed button and the hatch is held open.
    const hatch = document.querySelector('details.rec-hatch') as HTMLDetailsElement;
    expect(hatch.open).toBe(true);
    expect(hatch.contains(failure())).toBe(true);
    expect(hatch.contains(document.querySelector('[role=status]'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Clear cache without verification' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Return to the app' })).not.toBeDisabled();
  });
  it('quarantines the document until a timed-out unverified clear settles, then refuses completion', async () => {
    H.user = null;
    await failAttended();
    vi.useFakeTimers();
    let resolveClear = () => {};
    H.clear.mockReturnValue(new Promise<void>(resolve => { resolveClear = resolve; }));
    acceptUnverified().click();
    await vi.advanceTimersByTimeAsync(10001);
    expect(status()).toHaveTextContent('Still waiting for cache clearing');
    const back = screen.getByRole('button', { name: 'Return to the app' });
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(back).toBeDisabled(); expect(retry).toBeDisabled();
    back.click(); retry.click();
    expect(H.replace).not.toHaveBeenCalled(); expect(H.reload).not.toHaveBeenCalled();
    resolveClear(); await vi.advanceTimersByTimeAsync(0);
    expect(failure()).toHaveTextContent('Clearing did not complete');
    expect(privateCacheRecovered(project)).toBe(false);
    expect(back).not.toBeDisabled();
  });
});

describe('recovery outcomes are left for PostHog (#1889)', () => {
  const outcomes = () => (JSON.parse(localStorage.getItem(privateCacheRecoveryTelemetryKey(project)) ?? '[]') as Record<string, unknown>[])
    .map(({ at: _at, id: _id, ...rest }) => rest);
  beforeEach(() => localStorage.clear());
  it.each([
    ['ready', 'auth'], ['server', 'server'], ['drain', 'drain'], ['terminate', 'terminate'], ['clear', 'clear'],
  ] as const)('attributes a %s failure to its stage with a code, never the message', async (mock, stage) => {
    H[mock].mockRejectedValueOnce(new Error('SDK refusal for alice'));
    await failAttended();
    expect(outcomes()).toEqual([{ outcome: 'failed', path: 'verified', stage, reason: 'unknown' }]);
    expect(localStorage.getItem(privateCacheRecoveryTelemetryKey(project))).not.toContain('alice');
  });
  it.each(['server', 'drain', 'terminate', 'clear'] as const)('attributes an account change during %s to auth', async mock => {
    H[mock].mockImplementationOnce(async () => { H.user = { uid: 'bob' }; });
    await failAttended();
    expect(outcomes()).toEqual([{ outcome: 'failed', path: 'verified', stage: 'auth', reason: 'recovery/session-changed' }]);
  });
  it('reports a signed-out attempt and a held cache by code', async () => {
    H.user = null;
    await failAttended();
    H.clear.mockRejectedValueOnce(Object.assign(new Error('held'), { code: 'failed-precondition' }));
    acceptUnverified().click();
    await waitFor(() => expect(failure()).toHaveTextContent('Clearing did not complete'));
    expect(outcomes()).toEqual([
      { outcome: 'failed', path: 'verified', stage: 'auth', reason: 'recovery/signed-out-or-offline' },
      { outcome: 'failed', path: 'unverified', stage: 'clear', reason: 'failed-precondition' },
    ]);
  });
  it('reports completion on either path', async () => {
    renderPrivateCacheRecovery(); confirmBoth().click();
    await waitFor(() => expect(H.replace).toHaveBeenCalledOnce());
    expect(outcomes()).toEqual([{ outcome: 'completed', path: 'verified' }]);
    localStorage.clear(); H.user = null;
    await failAttended();
    acceptUnverified().click();
    await waitFor(() => expect(H.replace).toHaveBeenCalledTimes(2));
    expect(outcomes()).toEqual([
      { outcome: 'failed', path: 'verified', stage: 'auth', reason: 'recovery/signed-out-or-offline' },
      { outcome: 'completed', path: 'unverified' },
    ]);
  });
  it('reports a marker that cannot be stored as the record stage', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
      if (name === privateCacheRecoveryKey(project)) return;
      Object.defineProperty(this, name, { value, configurable: true, enumerable: true, writable: true });
    });
    await failAttended();
    expect(outcomes()).toEqual([{ outcome: 'failed', path: 'verified', stage: 'record', reason: 'recovery/marker-unwritable' }]);
  });
});
