// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildEnvironment, envFileForTarget, requiredViteKeys } from './build-target.mjs';

const REQUIRED_VITE_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_EVENT_ID',
  'VITE_EDITION',
];

describe('build target selection', () => {
  it('uses the target config over a stale ambient local config', () => {
    const environment = buildEnvironment(
      'fiveacross',
      {
        VITE_FIREBASE_PROJECT_ID: 'fiveacross',
        VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
        VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
        VITE_EVENT_ID: 'bodega-bay-2026',
        VITE_EDITION: 'vacay',
      },
      {
        VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
        VITE_FIREBASE_AUTH_DOMAIN: 'gaycruisebingo.com',
        VITE_FIREBASE_API_KEY: 'gcb-web-key',
        VITE_EVENT_ID: 'med-2026',
        VITE_EDITION: 'gcb',
        VITE_FUTURE_VALUE: 'must-not-leak',
        NODE_ENV: 'production',
      },
      REQUIRED_VITE_KEYS,
    );

    expect(environment).toMatchObject({
      VITE_FIREBASE_PROJECT_ID: 'fiveacross',
      VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
      VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
      VITE_EVENT_ID: 'bodega-bay-2026',
      VITE_EDITION: 'vacay',
      NODE_ENV: 'production',
    });
    expect(environment.VITE_FUTURE_VALUE).toBeUndefined();
  });

  it('rejects a config file for the wrong Firebase project', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
          VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
          VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
          VITE_EVENT_ID: 'bodega-bay-2026',
          VITE_EDITION: 'vacay',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('VITE_FIREBASE_PROJECT_ID="fiveacross"');
  });

  it('maps each supported target to its dedicated env file', () => {
    expect(envFileForTarget('gaycruisebingo', '/repo')).toBe('/repo/.env.gaycruisebingo');
    expect(envFileForTarget('fiveacross', '/repo')).toBe('/repo/.env.fiveacross');
  });

  it('rejects a target file that would fall back to .env.local', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          VITE_FIREBASE_PROJECT_ID: 'fiveacross',
          VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
          VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
          VITE_EDITION: 'vacay',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('Missing: VITE_EVENT_ID');
  });

  it('rejects a copied target file with the other Event or Edition', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          VITE_FIREBASE_PROJECT_ID: 'fiveacross',
          VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
          VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
          VITE_EVENT_ID: 'med-2026',
          VITE_EDITION: '',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('VITE_EVENT_ID="bodega-bay-2026", VITE_EDITION="vacay"');
  });

  it('derives the complete Vite-key set from the target template', () => {
    expect(requiredViteKeys({ VITE_ONE: '', NOT_VITE: '', VITE_TWO: '' })).toEqual(['VITE_ONE', 'VITE_TWO']);
  });
});
