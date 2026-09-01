import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
