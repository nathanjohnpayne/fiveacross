import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visionModerationEnabled, shouldScanProof } from '../../functions/src/visionGate';

// firebase-admin only lives in functions/node_modules (not the repo root).
// A plain `import ... from 'firebase-admin/app'` in this file resolves node
// lookup from tests/functions/, which never finds it — so resolve it the way
// functions/src does, rooted at functions/package.json, via Node's own
// package-exports-aware resolver (createRequire), not a hand-built file path.
const functionsRequire = createRequire(fileURLToPath(new URL('../../functions/package.json', import.meta.url)));
const { getApps, deleteApp } = functionsRequire('firebase-admin/app') as typeof import('firebase-admin/app');

// Issue #126: moderateProof (Cloud Vision) is gated behind
// ENABLE_VISION_MODERATION (default OFF). The gate must flip the EXPORT at
// deploy TRIGGER DISCOVERY, where firebase-tools spawns this module in a
// subprocess whose env it seals — it does NOT load functions/.env into it, so
// a raw `process.env.ENABLE_VISION_MODERATION` read (and equally a
// defineBoolean().value(), which reads the same key) is `undefined` at
// discovery regardless of functions/.env.<projectId>. firebase-tools DOES run
// discovery with cwd = the functions source dir and sets FUNCTIONS_CONTROL_API
// + GCLOUD_PROJECT, so `visionModerationEnabled` reads the .env files itself at
// discovery. These tests drive both seams:
//   1. The pure `visionModerationEnabled(env, cwd)` gate — process.env path
//      (runtime) and the discovery .env-file path.
//   2. The real module export: with the gate on, moderateProof is a CloudFunction
//      (an __endpoint-bearing function — exactly what firebase-functions'
//      loader.js extractStack() registers) pinned to region us-east1 to match
//      the default bucket; off, it is undefined (skipped by discovery, never
//      deployed). The notifiers are always exported.

describe('visionModerationEnabled gate (#126)', () => {
  it('honors process.env.ENABLE_VISION_MODERATION (runtime path): only the literal "true" enables', () => {
    expect(visionModerationEnabled({ ENABLE_VISION_MODERATION: 'true' })).toBe(true);
    expect(visionModerationEnabled({ ENABLE_VISION_MODERATION: 'false' })).toBe(false);
    expect(visionModerationEnabled({ ENABLE_VISION_MODERATION: 'TRUE' })).toBe(false);
    expect(visionModerationEnabled({ ENABLE_VISION_MODERATION: '1' })).toBe(false);
  });

  it('is OFF when the flag is unset outside discovery (no filesystem read)', () => {
    // Runtime/emulator with the flag unset, or any non-discovery context:
    // FUNCTIONS_CONTROL_API is not "true", so no .env file is consulted.
    expect(visionModerationEnabled({}, '/nonexistent')).toBe(false);
    expect(visionModerationEnabled({ FUNCTIONS_CONTROL_API: 'false' }, '/nonexistent')).toBe(false);
  });

  describe('deploy trigger-discovery: reads functions/.env[.<projectId>] from cwd', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gcb-vision-gate-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    // The exact discovery marker firebase-tools sets on the subprocess.
    const discovery = (projectId = 'gaycruisebingo') => ({
      FUNCTIONS_CONTROL_API: 'true',
      GCLOUD_PROJECT: projectId,
    });

    it('enables from .env.<projectId> at discovery — the operator enable-Vision path', () => {
      writeFileSync(join(dir, '.env.gaycruisebingo'), 'ENABLE_VISION_MODERATION=true\n');
      expect(visionModerationEnabled(discovery(), dir)).toBe(true);
    });

    it('enables from the plain .env at discovery', () => {
      writeFileSync(join(dir, '.env'), 'EMAIL_FROM=x\nENABLE_VISION_MODERATION=true\n');
      expect(visionModerationEnabled(discovery(), dir)).toBe(true);
    });

    it('lets .env.<projectId> override .env (mirrors firebase-tools precedence)', () => {
      writeFileSync(join(dir, '.env'), 'ENABLE_VISION_MODERATION=true\n');
      writeFileSync(join(dir, '.env.gaycruisebingo'), 'ENABLE_VISION_MODERATION=false\n');
      expect(visionModerationEnabled(discovery(), dir)).toBe(false);
    });

    it('resolves the projectId from FIREBASE_CONFIG when GCLOUD_PROJECT is absent', () => {
      writeFileSync(join(dir, '.env.gaycruisebingo'), 'ENABLE_VISION_MODERATION=true\n');
      expect(
        visionModerationEnabled(
          { FUNCTIONS_CONTROL_API: 'true', FIREBASE_CONFIG: JSON.stringify({ projectId: 'gaycruisebingo' }) },
          dir,
        ),
      ).toBe(true);
    });

    it('honors quotes and a trailing comment, and is OFF for a non-"true" value', () => {
      writeFileSync(join(dir, '.env.gaycruisebingo'), 'ENABLE_VISION_MODERATION="true" # enable Vision\n');
      expect(visionModerationEnabled(discovery(), dir)).toBe(true);
      writeFileSync(join(dir, '.env.gaycruisebingo'), 'ENABLE_VISION_MODERATION=false\n');
      expect(visionModerationEnabled(discovery(), dir)).toBe(false);
    });

    it('is OFF (default) when no .env file declares the flag', () => {
      writeFileSync(join(dir, '.env'), 'EMAIL_FROM=x\n');
      expect(visionModerationEnabled(discovery(), dir)).toBe(false);
    });
  });
});

// index.ts has module-level side effects (initializeApp, getFirestore, a
// Vision client) that run on every import; vi.resetModules() forces a fresh
// evaluation of index.ts's top-level `const VISION_ENABLED = ...`. firebase-admin
// is a heavy CJS dep Vitest externalizes (loaded once via Node's native require,
// not reset by vi.resetModules()), so its app registry is a real singleton for
// the whole worker — explicitly tear down the default app between imports or a
// second initializeApp() throws "the default Firebase app already exists".
const importIndex = async () => {
  for (const app of getApps()) {
    await deleteApp(app);
  }
  vi.resetModules();
  return import('../../functions/src/index');
};

describe('moderateProof export gating (#126)', () => {
  // onObjectFinalized({ memory: '512MiB', region: 'us-east1' }, ...) (no explicit
  // bucket) resolves the default bucket from FIREBASE_CONFIG, exactly as the real
  // firebase CLI sets it during deploy-plan discovery. Fixed here so the enabled
  // cases can actually construct the trigger. Also drive the gate via process.env
  // (the runtime seam), which the module reads first.
  process.env.FIREBASE_CONFIG = JSON.stringify({
    storageBucket: 'gaycruisebingo-test.appspot.com',
    projectId: 'gaycruisebingo-test',
  });
  process.env.GCLOUD_PROJECT = 'gaycruisebingo-test';

  afterEach(() => {
    delete process.env.ENABLE_VISION_MODERATION;
  });

  it('is undefined (not exported) when the flag is absent — default OFF', async () => {
    delete process.env.ENABLE_VISION_MODERATION;
    const mod = await importIndex();
    expect(mod.moderateProof).toBeUndefined();
  });

  it('is undefined when the flag is set to anything other than the literal string "true"', async () => {
    process.env.ENABLE_VISION_MODERATION = 'TRUE';
    const mod = await importIndex();
    expect(mod.moderateProof).toBeUndefined();
  });

  it('is a defined CloudFunction when the flag is "true"', async () => {
    process.env.ENABLE_VISION_MODERATION = 'true';
    const mod = await importIndex();
    expect(mod.moderateProof).toBeDefined();
    expect(typeof mod.moderateProof).toBe('function');
    // A firebase-functions v2 CloudFunction carries a __endpoint manifest
    // marker — the exact thing loader.js's extractStack() checks for.
    expect(mod.moderateProof).toHaveProperty('__endpoint');
    expect(typeof mod.moderateProof.__endpoint).toBe('object');
    // Pinned to us-east1 to match the default Storage bucket (#132): a
    // us-central1 trigger on a us-east1 bucket fails deploy-plan validation.
    expect(mod.moderateProof.__endpoint.region).toContain('us-east1');
  });

  it('leaves the #101 notifiers exported and unaffected regardless of the flag', async () => {
    delete process.env.ENABLE_VISION_MODERATION;
    const off = await importIndex();
    expect(typeof off.notifyProofModeration).toBe('function');
    expect(typeof off.notifyItemModeration).toBe('function');

    process.env.ENABLE_VISION_MODERATION = 'true';
    const on = await importIndex();
    expect(typeof on.notifyProofModeration).toBe('function');
    expect(typeof on.notifyItemModeration).toBe('function');
  });

  it('pins bug-report intake to the Firebase Admin runtime identity', async () => {
    const mod = await importIndex();
    // Of the DEPLOYING project — this harness deploys as `gaycruisebingo-test`.
    expect(mod.submitBugReport.__endpoint.serviceAccountEmail).toBe(
      'firebase-adminsdk-fbsvc@gaycruisebingo-test.iam.gserviceaccount.com',
    );
  });

  // ADR 0008: this repo deploys to two Firebase projects. A Service Account only
  // exists inside its own project, so a hardcoded `gaycruisebingo` pin failed the
  // `fiveacross` deploy outright with `iam.serviceaccounts.actAs` on a
  // cross-project resource — and would have been wrong even if it had succeeded,
  // running Bodega's functions under an identity holding gaycruisebingo's
  // Firestore data-plane access. Every Admin-SDK-pinned export must follow the
  // deploying project.
  it('derives the Admin runtime identity from the DEPLOYING project, so the second Firebase project deploys (ADR 0008)', async () => {
    const priorConfig = process.env.FIREBASE_CONFIG;
    const priorProject = process.env.GCLOUD_PROJECT;
    process.env.FIREBASE_CONFIG = JSON.stringify({
      storageBucket: 'fiveacross.appspot.com',
      projectId: 'fiveacross',
    });
    process.env.GCLOUD_PROJECT = 'fiveacross';
    try {
      const mod = await importIndex();
      const expected = 'firebase-adminsdk-fbsvc@fiveacross.iam.gserviceaccount.com';
      expect(mod.submitBugReport.__endpoint.serviceAccountEmail).toBe(expected);
      // unlockDay is the one the Bodega event actually depends on.
      expect(mod.unlockDay.__endpoint.serviceAccountEmail).toBe(expected);
      expect(mod.unlockDayNow.__endpoint.serviceAccountEmail).toBe(expected);
    } finally {
      process.env.FIREBASE_CONFIG = priorConfig;
      process.env.GCLOUD_PROJECT = priorProject;
    }
  });
});

describe('shouldScanProof — the RUNTIME admin toggle (#268)', () => {
  const dbWith = (settings: Record<string, unknown> | undefined) => ({
    doc: (_path: string) => ({
      get: () =>
        Promise.resolve({
          get: (field: string) => (field === 'settings.visionGate' ? settings?.visionGate : undefined),
        }),
    }),
  });

  it('scans by default (setting absent) and when explicitly true', async () => {
    await expect(shouldScanProof(dbWith(undefined), 'e')).resolves.toBe(true);
    await expect(shouldScanProof(dbWith({ visionGate: true }), 'e')).resolves.toBe(true);
  });

  it('skips the scan only on an EXPLICIT settings.visionGate === false — the console toggle works without a redeploy', async () => {
    await expect(shouldScanProof(dbWith({ visionGate: false }), 'e')).resolves.toBe(false);
  });

  it('fails OPEN on a read error — moderation never silently disables on a transient hiccup', async () => {
    const failing = { doc: () => ({ get: () => Promise.reject(new Error('unavailable')) }) };
    await expect(shouldScanProof(failing, 'e')).resolves.toBe(true);
  });
});
