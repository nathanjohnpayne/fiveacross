import { defineConfig } from 'vitest/config';

// Vitest "origin" layer (#965): the Five Across production-origin integration
// seam in scripts/fiveacross-origin.integration.test.mjs. It spawns a full
// `vite build --mode production` under the real fiveacross deploy environment
// and then boots the hostname resolution against a mocked Firestore, so it is
// an integration layer, not a unit test. Kept out of the default `npm test`
// run so the suite developers run most often does not carry a hard dependency
// on a working production build; app-ci runs it as its own step so a failure
// names this layer. Boot it via `npm run test:origin`.
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['scripts/fiveacross-origin.integration.test.mjs'],
    // The production build inside the first case is the slow part; the test
    // carries its own 120 s budget and this leaves headroom for a cold cache.
    testTimeout: 150_000,
    hookTimeout: 60_000,
  },
});
