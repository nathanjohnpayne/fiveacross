import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';

const H = vi.hoisted(() => ({
  order: [] as string[], main: vi.fn(), handoff: vi.fn(), initialize: vi.fn(),
  forbidden: vi.fn(), firestore: vi.fn(), clear: vi.fn(), drain: vi.fn(),
}));
vi.mock('./main', () => { H.main(); H.order.push('main'); return {}; });
vi.mock('./auth/handoffReturn', () => ({ completeHandoffReturn: H.handoff }));
// Evaluate the real recovery page/Core/Auth graph. Any forbidden runtime import
// or gameplay writer invocation fails the test rather than passing a source grep.
vi.mock('./firebase', () => { H.forbidden('gameplay singleton'); throw new Error('Game graph loaded'); });
vi.mock('./data/api', () => { H.forbidden('gameplay writers'); throw new Error('Game writers loaded'); });
vi.mock('firebase/analytics', () => { H.forbidden('analytics'); throw new Error('Analytics loaded'); });
vi.mock('firebase/app', () => ({ initializeApp: H.initialize }));
vi.mock('firebase/functions', () => ({ getFunctions: () => ({}), connectFunctionsEmulator: vi.fn() }));
vi.mock('firebase/app-check', () => ({ initializeAppCheck: () => ({}), ReCaptchaEnterpriseProvider: class {} }));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: null, authStateReady: async () => {} }),
  GoogleAuthProvider: class {}, connectAuthEmulator: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  initializeFirestore: H.firestore, clearIndexedDbPersistence: H.clear,
  waitForPendingWrites: H.drain, connectFirestoreEmulator: vi.fn(), doc: vi.fn(),
  getDocFromServer: vi.fn(), persistentLocalCache: vi.fn(), persistentMultipleTabManager: vi.fn(),
  terminate: vi.fn(),
}));

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); H.order = [];
  document.body.innerHTML = '<div id="root"></div>';
  H.initialize.mockImplementation(() => { H.order.push('firebase-core'); return {}; });
  H.handoff.mockImplementation(async () => {
    expect(window.location.hash).toBe(''); H.order.push('handoff'); return { kind: 'continue' };
  });
  const boot = await import('./handoffBoot');
  const capture = boot.captureUrlCredentialsFromUrl;
  vi.spyOn(boot, 'captureUrlCredentialsFromUrl').mockImplementation(() => {
    capture(); H.order.push('credentials-captured');
  });
});
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

describe('credential-safe dedicated recovery entry (#1411)', () => {
  it('captures first, loads the actual recovery document, and never opens the gameplay or analytics graph', async () => {
    window.history.replaceState(null, '', '/#device-cache-recovery');
    await import('./entry');
    await waitFor(() => expect(document.querySelector('h1')).toHaveTextContent('Finish device recovery'));
    expect(H.order).toEqual(['credentials-captured', 'firebase-core']);
    expect(H.main).not.toHaveBeenCalled(); expect(H.forbidden).not.toHaveBeenCalled();
    expect(H.firestore).not.toHaveBeenCalled(); expect(H.clear).not.toHaveBeenCalled();
    expect(H.drain).not.toHaveBeenCalled();
  });
  it('removes a real URL handoff credential before deferred handoff and main evaluation', async () => {
    const code = 'C'.repeat(43);
    window.history.replaceState(null, '', `/#fa_handoff=${code}`);
    await import('./entry');
    await waitFor(() => expect(H.main).toHaveBeenCalledOnce());
    expect(H.handoff).toHaveBeenCalledWith({ code, origin: window.location.origin });
    expect(window.location.hash).toBe('');
    expect(H.order).toEqual(['credentials-captured', 'handoff', 'main']);
    expect(H.forbidden).not.toHaveBeenCalled();
  });
  it('never mounts application or recovery after a failed handoff', async () => {
    H.handoff.mockResolvedValue({ kind: 'recover' });
    window.history.replaceState(null, '', `/#fa_handoff=${'C'.repeat(43)}`);
    await import('./entry');
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toHaveTextContent('Finish signing in'));
    expect(H.order).toEqual(['credentials-captured']);
    expect(H.main).not.toHaveBeenCalled(); expect(H.initialize).not.toHaveBeenCalled();
    expect(H.forbidden).not.toHaveBeenCalled(); expect(H.clear).not.toHaveBeenCalled();
  });
});
