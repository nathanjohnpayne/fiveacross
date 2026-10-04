// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ writes: new Map<string, Record<string, unknown>>(), batches: [] as string[][] }));
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
  writeBatch: () => {
    const staged: Array<[{ path: string }, Record<string, unknown>]> = [];
    return {
      set: (ref: { path: string }, value: Record<string, unknown>) => { staged.push([ref, value]); },
      commit: async () => { sdk.batches.push(staged.map(([ref]) => ref.path)); for (const [ref, value] of staged) sdk.writes.set(ref.path, value); },
    };
  },
  setDoc: async (ref: { path: string }, value: Record<string, unknown>) => { sdk.writes.set(ref.path, value); },
}));
vi.mock('@firebase/rules-unit-testing', () => ({
  initializeTestEnvironment: async () => ({
    clearFirestore: async () => {},
    cleanup: async () => {},
    withSecurityRulesDisabled: async (action: (context: { firestore: () => object }) => unknown) => action({ firestore: () => ({}) }),
  }),
}));
vi.mock('@playwright/test', () => ({ expect }));
vi.mock('../../tests/support/emulator-signin', () => ({
  completeEmulatorSignIn: vi.fn(), dismissConsentNotice: vi.fn(), signedInUid: vi.fn(), stubAuthWidgetCdn: vi.fn(),
}));

import { seedHeroEvent } from '../../tests/marketing/support/fixture';
import { seedHbsEvent } from '../../tests/marketing/support/hbs-fixture';
import { coerceAdultContent } from '../adultContent';
import { projectPublicHostname } from '../../functions/src/publicHostnameFields';

describe('marketing fixture public hostname delivery without a Functions emulator', () => {
  beforeEach(() => { sdk.writes.clear(); sdk.batches.length = 0; });
  it.each([['marketing', seedHeroEvent], ['HBS', seedHbsEvent]] as const)('%s fixture seeds the public adult-posture document read by the real app', async (_label, seed) => {
    await seed();
    const canonical = sdk.writes.get('hostnames/127.0.0.1');
    const publicCopy = sdk.writes.get('publicHostnames/127.0.0.1');
    expect(canonical).toMatchObject({ eventId: 'hero-shot', status: 'active', adultContent: false });
    expect(publicCopy).toEqual(projectPublicHostname(canonical));
    expect(sdk.batches).toEqual([['hostnames/127.0.0.1', 'publicHostnames/127.0.0.1']]);
    expect(coerceAdultContent(publicCopy?.adultContent)).toBe(false);
  });
});
