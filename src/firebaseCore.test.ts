import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('pre-auth Firebase boundary', () => {
  it('keeps the callable/App Check runtime free of page Auth and data services', () => {
    const source = readFileSync('src/firebaseCore.ts', 'utf8');

    expect(source).not.toMatch(/firebase\/auth|firebase\/firestore|firebase\/storage|firebase\/analytics/);
    expect(source).not.toMatch(/\bgetAuth\b|\binitializeAuth\b/);
    expect(source).toMatch(/getFunctions/);
    expect(source).toMatch(/initializeAppCheck/);
  });

  it('keeps page Auth in its own module with Firebase browser fallbacks intact', () => {
    const source = readFileSync('src/firebaseAuth.ts', 'utf8');

    expect(source).toMatch(/export const auth = getAuth\(app\)/);
    expect(source).not.toMatch(/initializeAuth\(app|persistence:\s*indexedDBLocalPersistence/);
  });
});

describe('firebaseEmulatorsEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a strict false for an e2e build with no project id (#1074)', async () => {
    // Imported before MODE is stubbed so the module-scope emulator wiring stays
    // off; the predicate itself reads import.meta.env at call time.
    const { firebaseEmulatorsEnabled } = await import('./firebaseCore');

    vi.stubEnv('MODE', 'e2e');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', undefined);

    // `?.startsWith` short-circuits to undefined here, so the declared `boolean`
    // return type only holds if the body coerces it. Strict equality on purpose:
    // a falsy check would pass on undefined and miss the regression.
    expect(firebaseEmulatorsEnabled()).toBe(false);
  });
});
