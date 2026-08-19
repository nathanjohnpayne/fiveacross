// @vitest-environment jsdom
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEnvironment, DEPLOY_TARGETS } from './build-target.mjs';

const mocks = vi.hoisted(() => ({
  applyResolvedCanonicalHost: vi.fn(),
  getDocFromServer: vi.fn(),
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal()),
  doc: (_db, ...path) => ({ path: path.join('/') }),
  getDocFromServer: mocks.getDocFromServer,
}));
vi.mock('../src/canonicalHost', () => ({
  applyResolvedCanonicalHost: mocks.applyResolvedCanonicalHost,
}));

import { adultContentRequired, adultContentSettledAdult, resetAdultContentForTests } from '../src/adultContent';
import { activeEdition, setActiveEdition } from '../src/editions';
import { resolveSignInStrategy } from '../src/auth/authMode';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fiveAcrossTargetEnv = {
  ...DEPLOY_TARGETS.fiveacross.identity,
  VITE_POSTHOG_KEY: 'phc_test',
  VITE_RECAPTCHA_SITE_KEY: '',
};
const requiredViteKeys = Object.keys(fiveAcrossTargetEnv).filter((key) => key.startsWith('VITE_'));
const targetEnvironment = buildEnvironment(
  'fiveacross',
  fiveAcrossTargetEnv,
  { ...process.env, GITHUB_SHA: '1111111111111111111111111111111111111111' },
  requiredViteKeys,
);

let bootstrapEventResolution;
let cardCache;
let firebaseIdentity;
let localValues;

const hostnameDocs = {
  'bodega-bay.fiveacross.app': {
    eventId: 'bodega-bay-2026',
    canonicalHost: 'bodega-bay.vacaybingo.com',
    edition: 'vacay',
    adultContent: false,
    status: 'active',
  },
  'bodega-bay.vacaybingo.com': {
    eventId: 'bodega-bay-2026',
    canonicalHost: 'bodega-bay.vacaybingo.com',
    edition: 'vacay',
    adultContent: false,
    status: 'active',
  },
  'fiveacross.app': {
    eventId: 'bodega-bay-2026',
    canonicalHost: 'bodega-bay.vacaybingo.com',
    edition: 'vacay',
    adultContent: false,
    status: 'active',
  },
  'reunion.fiveacross.app': {
    eventId: 'reunion-2027',
    canonicalHost: 'reunion.fiveacross.app',
    edition: 'fiveacross',
    adultContent: true,
    status: 'active',
  },
};

const snap = (data) => ({ exists: () => data != null, data: () => data });

beforeAll(async () => {
  for (const [key, value] of Object.entries(targetEnvironment)) {
    if (key.startsWith('VITE_')) vi.stubEnv(key, value);
  }
  ({ bootstrapEventResolution } = await import('../src/data/hostnames'));
  cardCache = await import('../src/data/cardCache');
  firebaseIdentity = await import('../src/firebase');
});

beforeEach(() => {
  vi.clearAllMocks();
  localValues = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => localValues.get(key) ?? null,
    setItem: (key, value) => localValues.set(key, value),
    removeItem: (key) => localValues.delete(key),
  });
  setActiveEdition('gcb');
  resetAdultContentForTests();
  mocks.getDocFromServer.mockImplementation(({ path }) => {
    const hostname = path.slice('hostnames/'.length);
    return Promise.resolve(snap(hostnameDocs[hostname] ?? null));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('Five Across production origin', () => {
  it('emits Vacay static chrome without a baked Bodega Event id', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'fiveacross-origin-'));
    try {
      const vite = resolve(repoRoot, 'node_modules', '.bin', 'vite');
      const build = spawnSync(vite, ['build', '--mode', 'production', '--outDir', outDir], {
        cwd: repoRoot,
        env: targetEnvironment,
        encoding: 'utf8',
      });
      expect(build.status, build.stderr || build.stdout).toBe(0);

      const html = readFileSync(join(outDir, 'index.html'), 'utf8');
      const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.webmanifest'), 'utf8'));
      expect(html).toContain('<title>Vacay Bingo</title>');
      expect(html).toContain('content="Vacay Bingo"');
      expect(manifest).toMatchObject({ name: 'Vacay Bingo', short_name: 'Vacay Bingo' });

      const bundledJavaScript = readdirSync(join(outDir, 'assets'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => readFileSync(join(outDir, 'assets', name), 'utf8'))
        .join('\n');
      expect(bundledJavaScript).not.toContain('bodega-bay-2026');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(Object.entries(hostnameDocs))(
    'installs the hostname document before mounting %s',
    async (hostname, doc) => {
      const resolution = await bootstrapEventResolution(hostname);

      expect(resolution).toMatchObject({ kind: 'event', eventId: doc.eventId, edition: doc.edition });
      expect(firebaseIdentity.EVENT_ID).toBe(doc.eventId);
      cardCache.saveCardSnapshot({
        uid: 'identity-probe',
        dayIndex: null,
        cells: [{ index: 0 }],
        bingoCount: 0,
        day: null,
      });
      const cardKey = `gcb:card-snapshot:${doc.eventId}:identity-probe:legacy`;
      expect(localValues.has(cardKey)).toBe(true);
      expect(JSON.parse(localValues.get(cardKey)).eventId).toBe(doc.eventId);
      expect(activeEdition()).toBe(doc.edition);
      expect(adultContentRequired()).toBe(doc.adultContent);
      if (doc.adultContent) expect(adultContentSettledAdult()).toBe(true);
    },
  );

  it('routes a newly provisioned wildcard host through the production central auth origin', async () => {
    const hostname = 'reunion.fiveacross.app';
    const resolution = await bootstrapEventResolution(hostname);

    expect(resolution).toMatchObject({
      kind: 'event',
      eventId: 'reunion-2027',
      edition: 'fiveacross',
    });
    expect(
      resolveSignInStrategy({
        mode: targetEnvironment.VITE_AUTH_MODE,
        configuredAuthDomain: targetEnvironment.VITE_FIREBASE_AUTH_DOMAIN,
        hostname,
        handoffOrigin: targetEnvironment.VITE_AUTH_HANDOFF_ORIGIN,
        currentOrigin: `https://${hostname}`,
        returnPath: '/',
      }),
    ).toEqual({
      kind: 'handoff',
      authOrigin: 'https://auth.fiveacross.app',
      targetOrigin: 'https://reunion.fiveacross.app',
      returnPath: '/',
    });
  });
});
