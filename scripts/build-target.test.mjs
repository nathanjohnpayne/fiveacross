// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildEnvironment, envFileForTarget } from './build-target.mjs';

describe('build target selection', () => {
  it('uses the target config over a stale ambient local config', () => {
    const environment = buildEnvironment(
      'fiveacross',
      {
        VITE_FIREBASE_PROJECT_ID: 'fiveacross',
        VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
        VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
      },
      {
        VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
        VITE_FIREBASE_AUTH_DOMAIN: 'gaycruisebingo.com',
        VITE_FIREBASE_API_KEY: 'gcb-web-key',
      },
    );

    expect(environment).toMatchObject({
      VITE_FIREBASE_PROJECT_ID: 'fiveacross',
      VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
      VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
    });
  });

  it('rejects a config file for the wrong Firebase project', () => {
    expect(() => buildEnvironment('fiveacross', { VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo' })).toThrow(
      'VITE_FIREBASE_PROJECT_ID must be "fiveacross"',
    );
  });

  it('maps each supported target to its dedicated env file', () => {
    expect(envFileForTarget('gaycruisebingo', '/repo')).toBe('/repo/.env.gaycruisebingo');
    expect(envFileForTarget('fiveacross', '/repo')).toBe('/repo/.env.fiveacross');
  });
});
