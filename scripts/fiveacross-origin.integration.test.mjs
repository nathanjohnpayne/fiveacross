// @vitest-environment jsdom
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEnvironment, DEPLOY_TARGETS } from './build-target.mjs';

const mocks = vi.hoisted(() => ({
  applyResolvedCanonicalHost: vi.fn(),
  applyResolvedEventId: vi.fn(),
  getDocFromServer: vi.fn(),
  setCardCacheEventId: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  doc: (_db, ...path) => ({ path: path.join('/') }),
  getDocFromServer: mocks.getDocFromServer,
}));
vi.mock('../src/firebase', () => ({ db: {}, applyResolvedEventId: mocks.applyResolvedEventId }));
vi.mock('../src/data/cardCache', () => ({ setCardCacheEventId: mocks.setCardCacheEventId }));
vi.mock('../src/canonicalHost', () => ({
  applyResolvedCanonicalHost: mocks.applyResolvedCanonicalHost,
}));

import { adultContentRequired, adultContentSettledAdult, resetAdultContentForTests } from '../src/adultContent';
import { bootstrapEventResolution } from '../src/data/hostnames';
import { activeEdition, setActiveEdition } from '../src/editions';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fiveAcrossTargetEnv = {
  ...DEPLOY_TARGETS.fiveacross.identity,
  VITE_EVENT_ID: '',
  VITE_POSTHOG_KEY: 'phc_test',
  VITE_RECAPTCHA_SITE_KEY: '',
};
const requiredViteKeys = Object.keys(fiveAcrossTargetEnv).filter((key) => key.startsWith('VITE_'));

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_EVENT_ID', '');
  vi.stubEnv('VITE_EDITION', 'vacay');
  vi.stubEnv('VITE_ADULT_CONTENT', 'false');
  setActiveEdition('gcb');
  resetAdultContentForTests();
  mocks.getDocFromServer.mockImplementation(({ path }) => {
    const hostname = path.slice('hostnames/'.length);
    return Promise.resolve(snap(hostnameDocs[hostname] ?? null));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Five Across production origin', () => {
  it('emits Vacay static chrome without a baked Bodega Event id', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'fiveacross-origin-'));
    const environment = buildEnvironment(
      'fiveacross',
      fiveAcrossTargetEnv,
      { ...process.env, GITHUB_SHA: '1111111111111111111111111111111111111111' },
      requiredViteKeys,
    );

    try {
      const vite = resolve(repoRoot, 'node_modules', '.bin', 'vite');
      const build = spawnSync(vite, ['build', '--mode', 'production', '--outDir', outDir], {
        cwd: repoRoot,
        env: environment,
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
      expect(mocks.applyResolvedEventId).toHaveBeenCalledWith(doc.eventId);
      expect(mocks.setCardCacheEventId).toHaveBeenCalledWith(doc.eventId);
      expect(activeEdition()).toBe(doc.edition);
      expect(adultContentRequired()).toBe(doc.adultContent);
      if (doc.adultContent) expect(adultContentSettledAdult()).toBe(true);
    },
  );
});
