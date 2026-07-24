import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #335 — the emulator↔production Storage download-URL bridge.
//
// The module's gate (`import.meta.env.MODE === 'e2e' && VITE_FIREBASE_PROJECT_ID
// starts with 'demo-'`) is read ONCE at module load so the production build can
// fold it to `false` and dead-code-eliminate the emulator origins. That means
// both halves have to be exercised by re-importing the module under a stubbed
// env — `loadUnderEmulator()` vs `loadUnderProduction()` below — rather than by
// toggling a runtime flag.

async function loadUnderEmulator() {
  vi.stubEnv('MODE', 'e2e');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'demo-gaycruisebingo-e2e');
  vi.resetModules();
  return await import('./proofMediaUrl');
}

async function loadUnderProduction() {
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'gaycruisebingo');
  vi.resetModules();
  return await import('./proofMediaUrl');
}

const EMULATOR_URL =
  'http://127.0.0.1:9199/v0/b/demo-gaycruisebingo-e2e.appspot.com/o/proofs%2Fe2e%2Fuid1%2Fp1.jpg?alt=media&token=abc-123';
const CANONICAL_URL =
  'https://firebasestorage.googleapis.com/v0/b/demo-gaycruisebingo-e2e.appspot.com/o/proofs%2Fe2e%2Fuid1%2Fp1.jpg?alt=media&token=abc-123';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('proofMediaUrl — under the e2e emulator build', () => {
  it('canonicalizes an emulator download URL to the production host, path and query intact', async () => {
    const { canonicalizeProofMediaUrl } = await loadUnderEmulator();
    expect(canonicalizeProofMediaUrl(EMULATOR_URL)).toBe(CANONICAL_URL);
  });

  it('canonicalizes the localhost spelling of the emulator origin too', async () => {
    const { canonicalizeProofMediaUrl } = await loadUnderEmulator();
    expect(
      canonicalizeProofMediaUrl(EMULATOR_URL.replace('127.0.0.1', 'localhost')),
    ).toBe(CANONICAL_URL);
  });

  it('produces a value that satisfies the shape firestore.rules pins mediaURL to', async () => {
    const { canonicalizeProofMediaUrl } = await loadUnderEmulator();
    // The literal regex from firestore.rules' proof-create rule, with the
    // eventId/uid/proofId placeholders bound to this fixture. THIS is what the
    // whole bridge exists to make reachable from the emulator stack.
    const rulesRegex = new RegExp(
      '^https://firebasestorage[.]googleapis[.]com/v0/b/[^/]+/o/proofs%2Fe2e%2Fuid1%2Fp1[.]jpg([?].*)?$',
    );
    expect(canonicalizeProofMediaUrl(EMULATOR_URL)).toMatch(rulesRegex);
    // …and the raw emulator URL does NOT — the 403 this issue is about.
    expect(EMULATOR_URL).not.toMatch(rulesRegex);
  });

  it('resolves a canonicalized URL back to the emulator origin at render', async () => {
    const { resolveProofMediaUrl } = await loadUnderEmulator();
    expect(resolveProofMediaUrl(CANONICAL_URL)).toBe(EMULATOR_URL);
  });

  it('round-trips losslessly in both directions', async () => {
    const { canonicalizeProofMediaUrl, resolveProofMediaUrl } = await loadUnderEmulator();
    expect(resolveProofMediaUrl(canonicalizeProofMediaUrl(EMULATOR_URL))).toBe(EMULATOR_URL);
    expect(canonicalizeProofMediaUrl(resolveProofMediaUrl(CANONICAL_URL) as string)).toBe(CANONICAL_URL);
  });

  it('leaves a URL that is not the counterpart origin untouched', async () => {
    const { canonicalizeProofMediaUrl, resolveProofMediaUrl } = await loadUnderEmulator();
    // Fixture-seeded emulator URLs (tests/e2e/support/parity.ts writes these
    // directly with rules disabled) must still render.
    expect(resolveProofMediaUrl(EMULATOR_URL)).toBe(EMULATOR_URL);
    expect(canonicalizeProofMediaUrl(CANONICAL_URL)).toBe(CANONICAL_URL);
    expect(resolveProofMediaUrl('blob:http://127.0.0.1:5183/uuid')).toBe('blob:http://127.0.0.1:5183/uuid');
  });

  it('never rewrites a look-alike host (the origin anchor is exact)', async () => {
    const { resolveProofMediaUrl, canonicalizeProofMediaUrl } = await loadUnderEmulator();
    const lookalike = 'https://firebasestorage.googleapis.com.example.test/v0/b/x/o/y.jpg';
    expect(resolveProofMediaUrl(lookalike)).toBe(lookalike);
    // A different port on the loopback is not the Storage emulator.
    const otherPort = 'http://127.0.0.1:9299/v0/b/x/o/y.jpg';
    expect(canonicalizeProofMediaUrl(otherPort)).toBe(otherPort);
    // And the origin must be at the START, never mid-string.
    const embedded = 'https://evil.test/?next=https://firebasestorage.googleapis.com/v0/b/x/o/y.jpg';
    expect(resolveProofMediaUrl(embedded)).toBe(embedded);
  });

  it('passes null/undefined straight through at the render half', async () => {
    const { resolveProofMediaUrl } = await loadUnderEmulator();
    expect(resolveProofMediaUrl(null)).toBeNull();
    expect(resolveProofMediaUrl(undefined)).toBeUndefined();
    expect(resolveProofMediaUrl('')).toBe('');
  });
});

describe('proofMediaUrl — outside the e2e emulator build', () => {
  it('is the identity in both directions under a production build', async () => {
    const { canonicalizeProofMediaUrl, resolveProofMediaUrl } = await loadUnderProduction();
    expect(canonicalizeProofMediaUrl(EMULATOR_URL)).toBe(EMULATOR_URL);
    expect(canonicalizeProofMediaUrl(CANONICAL_URL)).toBe(CANONICAL_URL);
    expect(resolveProofMediaUrl(CANONICAL_URL)).toBe(CANONICAL_URL);
    expect(resolveProofMediaUrl(EMULATOR_URL)).toBe(EMULATOR_URL);
  });

  it('stays inert when MODE is e2e but the project id is a REAL one', async () => {
    // The belt-and-suspenders half of the gate: an `e2e` mode that somehow
    // pointed at a real project must never rewrite a media URL.
    vi.stubEnv('MODE', 'e2e');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'gaycruisebingo');
    vi.resetModules();
    const { canonicalizeProofMediaUrl, resolveProofMediaUrl } = await import('./proofMediaUrl');
    expect(canonicalizeProofMediaUrl(EMULATOR_URL)).toBe(EMULATOR_URL);
    expect(resolveProofMediaUrl(CANONICAL_URL)).toBe(CANONICAL_URL);
  });

  it('is the identity under the plain unit-test build (MODE === "test") with no stubbing', async () => {
    const { canonicalizeProofMediaUrl, resolveProofMediaUrl } = await import('./proofMediaUrl');
    expect(canonicalizeProofMediaUrl(EMULATOR_URL)).toBe(EMULATOR_URL);
    expect(resolveProofMediaUrl(CANONICAL_URL)).toBe(CANONICAL_URL);
  });
});

describe('proofMediaUrl — source guards', () => {
  it('the literal match patterns still cover the exported origin constants', async () => {
    // The two rewrites match on LITERAL regexes rather than patterns assembled
    // from the constants (a dynamically-built hostname pattern is the shape
    // CodeQL's js/incomplete-hostname-regexp and js/incomplete-sanitization
    // rules flag, and it flagged this module before that change). This closes
    // the drift that literal-vs-constant split opens: the fixtures are DERIVED
    // from the constants, so changing a constant without the pattern fails here.
    const {
      STORAGE_EMULATOR_HOST,
      STORAGE_EMULATOR_PORT,
      PRODUCTION_DOWNLOAD_ORIGIN,
      canonicalizeProofMediaUrl,
      resolveProofMediaUrl,
    } = await loadUnderEmulator();
    const tail = 'v0/b/bucket/o/proofs%2Fe%2Fu%2Fp.jpg?alt=media&token=t';
    const fromConstants = `http://${STORAGE_EMULATOR_HOST}:${STORAGE_EMULATOR_PORT}/${tail}`;
    expect(canonicalizeProofMediaUrl(fromConstants)).toBe(`${PRODUCTION_DOWNLOAD_ORIGIN}/${tail}`);
    expect(resolveProofMediaUrl(`${PRODUCTION_DOWNLOAD_ORIGIN}/${tail}`)).toBe(fromConstants);
  });

  it('pins the emulator host/port to the connectStorageEmulator call in src/firebase.ts', async () => {
    // The two literals are duplicated ON PURPOSE (each module's gate must fold
    // locally at build time — see the module header), so pin them against
    // drift rather than sharing a symbol.
    const { STORAGE_EMULATOR_HOST, STORAGE_EMULATOR_PORT } = await import('./proofMediaUrl');
    const firebaseSource = readFileSync('src/firebase.ts', 'utf8');
    expect(firebaseSource).toContain(
      `connectStorageEmulator(storage, '${STORAGE_EMULATOR_HOST}', ${STORAGE_EMULATOR_PORT})`,
    );
  });

  it('keeps the render half composed INSIDE safeMediaUrl, never around it', async () => {
    // The ordering that keeps safeMediaUrl the last barrier before the DOM
    // (the CodeQL js/xss-through-dom sanitizer from PR #95). A future edit that
    // flipped these — `resolveProofMediaUrl(safeMediaUrl(...))` — would put a
    // rewrite between the barrier and the `src` attribute and re-open the class.
    const feedSource = readFileSync('src/components/ProofFeed.tsx', 'utf8');
    expect(feedSource).toContain('safeMediaUrl(resolveProofMediaUrl(proof.mediaURL))');
    expect(feedSource).not.toMatch(/resolveProofMediaUrl\(\s*safeMediaUrl\(/);
  });
});
