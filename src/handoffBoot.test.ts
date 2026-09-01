// Covers specs/auth-handoff-client.md § Leg 3 — the capture that has to happen
// before the application's module graph loads (Phase 4b P1).
//
// The property under test is an ORDERING one that line order inside `main.tsx`
// could never provide: ES modules evaluate their static imports before their
// own body, so `firebase.ts` (and with it GA4) was already live on a URL still
// carrying the code. `entry.tsx` captures with nothing else loaded and reaches
// the app through a dynamic import; this file holds the seam they share.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readHandoffCode: vi.fn(),
  clearHandoffFragment: vi.fn(),
}));

vi.mock('./auth/handoffClient', () => ({
  readHandoffCode: mocks.readHandoffCode,
  clearHandoffFragment: mocks.clearHandoffFragment,
}));

const CODE = 'C'.repeat(43);

/** Read a repo file as text. Vitest runs from the repo root. */
function readSource(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

async function freshBoot() {
  vi.resetModules();
  return import('./handoffBoot');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readHandoffCode.mockReturnValue(null);
  mocks.clearHandoffFragment.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handoffBoot', () => {
  it('captures the code and clears it', async () => {
    mocks.readHandoffCode.mockReturnValue(CODE);
    const boot = await freshBoot();
    boot.captureHandoffFromUrl();
    expect(boot.pendingHandoffCode()).toBe(CODE);
    expect(mocks.clearHandoffFragment).toHaveBeenCalledTimes(1);
    expect(boot.isUrlSafeForTelemetry()).toBe(true);
  });

  it('does not touch the fragment on an ordinary load', async () => {
    const boot = await freshBoot();
    boot.captureHandoffFromUrl();
    expect(boot.pendingHandoffCode()).toBeNull();
    expect(mocks.clearHandoffFragment).not.toHaveBeenCalled();
    // An ordinary load has no code to leak, so telemetry is unaffected.
    expect(boot.isUrlSafeForTelemetry()).toBe(true);
  });

  it('marks the URL unsafe when the clear could not be confirmed', async () => {
    mocks.readHandoffCode.mockReturnValue(CODE);
    mocks.clearHandoffFragment.mockReturnValue(false);
    const boot = await freshBoot();
    boot.captureHandoffFromUrl();
    // The code is still returned — sign-in must still complete…
    expect(boot.pendingHandoffCode()).toBe(CODE);
    // …but nothing may read the URL.
    expect(boot.isUrlSafeForTelemetry()).toBe(false);
  });

  // A second call would read an already-cleared URL and overwrite a real
  // capture with null, turning a working sign-in into `transaction-missing`.
  it('is idempotent', async () => {
    mocks.readHandoffCode.mockReturnValueOnce(CODE).mockReturnValue(null);
    const boot = await freshBoot();
    boot.captureHandoffFromUrl();
    boot.captureHandoffFromUrl();
    expect(boot.pendingHandoffCode()).toBe(CODE);
    expect(mocks.readHandoffCode).toHaveBeenCalledTimes(1);
    expect(mocks.clearHandoffFragment).toHaveBeenCalledTimes(1);
  });
});

describe('the entry seam stays free of anything that can read a URL', () => {
  // The guarantee is structural, so it is asserted structurally: if either file
  // ever gains a static import of the app, Firebase, analytics or React, the
  // capture stops happening first and the leak returns silently.
  it('entry.tsx statically imports only the boot seam, and reaches the app dynamically', async () => {
    const src = readSource('src/entry.tsx');
    const staticImports = [
      ...src.matchAll(/^\s*import\s+(?!\()(?:(?!;)[\s\S])*?\sfrom\s+'([^']+)';/gm),
    ].map((m) => m[1]);
    expect(staticImports).toEqual(['./handoffBoot']);
    expect(src).toMatch(/import\('\.\/auth\/handoffReturn'\)/);
    expect(src).toMatch(/import\('\.\/main'\)/);
    expect(src.indexOf("import('./auth/handoffReturn')")).toBeLessThan(
      src.indexOf("import('./main')"),
    );
  });

  it('handoffBoot statically imports only the firebase-free handoff client', async () => {
    const src = readSource('src/handoffBoot.ts');
    const staticImports = [...src.matchAll(/^\s*import\s+[^(].*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(['./auth/handoffClient']);
  });

  it('the handoff client itself pulls in no firebase, analytics or react', () => {
    for (const file of ['src/auth/handoffClient.ts', 'src/auth/handoffTransaction.ts']) {
      const src = readSource(file);
      const staticImports = [...src.matchAll(/^\s*import\s+[^(].*?from\s+'([^']+)'/gm)].map((m) => m[1]);
      for (const dep of staticImports) {
        expect(dep).not.toMatch(/firebase|posthog|analytics|^react/);
      }
    }
  });
});

describe('dependency-free bootstrap failures', () => {
  it('never imports the app after a recovery result', async () => {
    const boot = await freshBoot();
    const loadMain = vi.fn().mockResolvedValue(undefined);
    const renderFailure = vi.fn();

    await boot.runApplicationBootstrap({
      code: CODE,
      completeHandoff: vi.fn().mockResolvedValue({ kind: 'recover' }),
      loadMain,
      renderFailure,
    });

    expect(loadMain).not.toHaveBeenCalled();
    expect(renderFailure).toHaveBeenCalledOnce();
    expect(renderFailure).toHaveBeenCalledWith('handoff-recovery');
  });

  it('never imports the app after an unexpected handoff failure', async () => {
    const boot = await freshBoot();
    const loadMain = vi.fn().mockResolvedValue(undefined);
    const renderFailure = vi.fn();

    await boot.runApplicationBootstrap({
      code: CODE,
      completeHandoff: vi.fn().mockRejectedValue(new Error('return module failed')),
      loadMain,
      renderFailure,
    });

    expect(loadMain).not.toHaveBeenCalled();
    expect(renderFailure).toHaveBeenCalledWith('handoff-recovery');
  });

  it('renders recovery with exactly one reload action', async () => {
    document.body.innerHTML = '<div id="root">Loading</div>';
    const boot = await freshBoot();

    boot.renderBootstrapFailure('handoff-recovery');

    const alert = document.querySelector('[role="alert"]');
    expect(alert).toHaveTextContent('Finish signing in');
    expect(alert).toHaveTextContent('cannot confirm it safely');
    expect(alert?.querySelectorAll('button')).toHaveLength(1);
    expect(alert?.querySelector('button')).toHaveTextContent('Reload');
  });

  it('keeps ordinary chunk failure free of a misleading handoff action', async () => {
    document.body.innerHTML = '<div id="root">Loading</div>';
    const boot = await freshBoot();

    boot.renderBootstrapFailure('app-load');

    const alert = document.querySelector('[role="alert"]');
    expect(alert).toHaveTextContent("This didn't load");
    expect(alert?.querySelector('button')).toBeNull();
  });
});
