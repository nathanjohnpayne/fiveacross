import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';

// ADR 0006 source guard: prove src/firebase.ts wires a PERSISTENT (durable
// IndexedDB) local cache, not the default in-memory cache that loses queued
// Marks on reload. The offline round-trip behavior this enables is proved
// against the emulator in tests/offline/w0-offline-persistence.test.ts.
//
// firebase.ts runs getAuth(app) at import; the node build of firebase/auth
// (which vitest resolves even under jsdom) rejects an empty apiKey, so stub a
// non-empty placeholder before importing. No network call is made.

// Firestore does not expose its settings publicly; reach through the internal
// field to read the *configured* cache kind ('persistent' | 'memory'; undefined
// for a default getFirestore instance).
function configuredCacheKind(fs: Firestore): string | undefined {
  return (fs as unknown as { _settings?: { localCache?: { kind?: string } } })._settings
    ?.localCache?.kind;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('src/firebase.ts (ADR 0006 offline persistence)', () => {
  it('exports a Firestore db backed by a persistent local cache', async () => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'demo-api-key');
    const { db } = await import('./firebase');

    // The db symbol is a real Firestore instance (unchanged export, so no call
    // site needs editing) …
    expect(db.type).toBe('firestore');
    // … and it requests the durable persistent cache, not memory or the default.
    // getFirestore(app) would leave this undefined; 'memory' would be a
    // regression to a queue that cannot survive a reload.
    expect(configuredCacheKind(db)).toBe('persistent');
  });

  it('uses the Firebase emulators only for an e2e build on a demo project', async () => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'demo-api-key');
    const { firebaseEmulatorsEnabled } = await import('./firebase');

    vi.stubEnv('MODE', 'e2e');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'demo-fiveacross');
    expect(firebaseEmulatorsEnabled()).toBe(true);

    vi.stubEnv('MODE', 'production');
    expect(firebaseEmulatorsEnabled()).toBe(false);

    vi.stubEnv('MODE', 'e2e');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'fiveacross');
    expect(firebaseEmulatorsEnabled()).toBe(false);
  });

  it('pins the multi-tab manager in the production config (source guard)', () => {
    // The SDK exposes no runtime handle on the configured tab manager (the
    // cache object carries only kind + opaque component providers), so the
    // multi-tab requirement is pinned at the source level: swapping to
    // persistentSingleTabManager or dropping the option fails this test.
    // (cwd-relative: under jsdom import.meta.url is http-scheme, and Vitest
    // runs with the project root as cwd.)
    const source = readFileSync('src/firebase.ts', 'utf8');
    expect(source).toMatch(/tabManager:\s*persistentMultipleTabManager\(\)/);
  });
});

describe('src/firebase.ts (#722 Firestore poison-latch watchdog)', () => {
  it('installs the b815 recovery watchdog for the instance it creates (source guard)', () => {
    // Pinned at the source level for the same reason the tab manager above is:
    // the watchdog registers global listeners as a side effect and exposes no
    // runtime handle, so nothing else would notice it quietly disappearing —
    // and without it a poisoned tab is unrecoverable, which is the whole of
    // #722. The behaviour itself is covered in src/firestoreRecovery.test.ts.
    const source = readFileSync('src/firebase.ts', 'utf8');
    expect(source).toMatch(/installFirestorePoisonRecovery\(\)/);
    // Guarded so an uptime probe never turns into a page reload (#142).
    expect(source).toMatch(/if\s*\(!isSyntheticProbe\(\)\)\s*installFirestorePoisonRecovery\(\)/);
  });
});
