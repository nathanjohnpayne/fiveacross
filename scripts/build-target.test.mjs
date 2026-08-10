// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { buildEnvironment, envFileForTarget, requiredViteKeys } from './build-target.mjs';

const REQUIRED_VITE_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_EVENT_ID',
  'VITE_EDITION',
];

const FIVEACROSS_TARGET_ENV = {
  VITE_FIREBASE_PROJECT_ID: 'fiveacross',
  VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
  VITE_FIREBASE_STORAGE_BUCKET: 'fiveacross.firebasestorage.app',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '5297095641',
  VITE_FIREBASE_APP_ID: '1:5297095641:web:aff3537cf7c95dec220fc8',
  VITE_FIREBASE_MEASUREMENT_ID: 'G-42N7WYDYT5',
  VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
  VITE_EVENT_ID: 'bodega-bay-2026',
  VITE_EDITION: 'vacay',
  VITE_ADULT_CONTENT: 'false',
  VITE_RECAPTCHA_SITE_KEY: '',
};

const GAY_CRUISE_BINGO_TARGET_ENV = {
  VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
  VITE_FIREBASE_AUTH_DOMAIN: 'gaycruisebingo.com',
  VITE_FIREBASE_STORAGE_BUCKET: 'gaycruisebingo.firebasestorage.app',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '849798007162',
  VITE_FIREBASE_APP_ID: '1:849798007162:web:70dffafa77cc65a8306ec3',
  VITE_FIREBASE_MEASUREMENT_ID: 'G-42N7WYDYT5',
  VITE_FIREBASE_API_KEY: 'gcb-web-key',
  VITE_EVENT_ID: 'med-2026',
  VITE_EDITION: 'gcb',
  VITE_ADULT_CONTENT: 'true',
  VITE_RECAPTCHA_SITE_KEY: '',
};

describe('build target selection', () => {
  it('uses the target config over a stale ambient local config', () => {
    const environment = buildEnvironment(
      'fiveacross',
      FIVEACROSS_TARGET_ENV,
      {
        VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
        VITE_FIREBASE_AUTH_DOMAIN: 'gaycruisebingo.com',
        VITE_FIREBASE_API_KEY: 'gcb-web-key',
        VITE_EVENT_ID: 'med-2026',
        VITE_EDITION: 'gcb',
        VITE_RECAPTCHA_SITE_KEY: 'gcb-recaptcha-key',
        VITE_FUTURE_VALUE: 'must-not-leak',
        NODE_ENV: 'development',
        DEPLOY_TARGET_BUILD: '0',
      },
      REQUIRED_VITE_KEYS,
    );

    expect(environment).toMatchObject({
      VITE_FIREBASE_PROJECT_ID: 'fiveacross',
      VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
      VITE_FIREBASE_API_KEY: 'fiveacross-web-key',
      VITE_EVENT_ID: 'bodega-bay-2026',
      VITE_EDITION: 'vacay',
      VITE_ADULT_CONTENT: 'false',
      VITE_RECAPTCHA_SITE_KEY: '',
      NODE_ENV: 'production',
      DEPLOY_TARGET_BUILD: '1',
    });
    expect(environment.VITE_FUTURE_VALUE).toBeUndefined();
  });

  it('rejects a config file for the wrong Firebase project', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          ...FIVEACROSS_TARGET_ENV,
          VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
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
    const targetEnv = { ...FIVEACROSS_TARGET_ENV };
    delete targetEnv.VITE_EVENT_ID;

    expect(() =>
      buildEnvironment(
        'fiveacross',
        targetEnv,
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
          ...FIVEACROSS_TARGET_ENV,
          VITE_EVENT_ID: 'med-2026',
          VITE_EDITION: '',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('VITE_EVENT_ID="bodega-bay-2026", VITE_EDITION="vacay"');
  });

  it('requires Gay Cruise Bingo to name its Edition explicitly', () => {
    expect(() =>
      buildEnvironment(
        'gaycruisebingo',
        {
          ...GAY_CRUISE_BINGO_TARGET_ENV,
          VITE_EDITION: '',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('VITE_EDITION="gcb"');
  });

  it('rejects Firebase web-app fields copied from the other project', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          ...FIVEACROSS_TARGET_ENV,
          VITE_FIREBASE_STORAGE_BUCKET: 'gaycruisebingo.firebasestorage.app',
          VITE_FIREBASE_APP_ID: '1:849798007162:web:70dffafa77cc65a8306ec3',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow(
      'VITE_FIREBASE_STORAGE_BUCKET="fiveacross.firebasestorage.app", VITE_FIREBASE_APP_ID="1:5297095641:web:aff3537cf7c95dec220fc8"',
    );
  });

  it('requires Five Across to name the shared GA4 stream explicitly', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          ...FIVEACROSS_TARGET_ENV,
          VITE_FIREBASE_MEASUREMENT_ID: '',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('VITE_FIREBASE_MEASUREMENT_ID="G-42N7WYDYT5"');
  });

  it('ignores future target files without hiding the committed template', () => {
    expect(spawnSync('git', ['check-ignore', '--quiet', '.env.future-event']).status).toBe(0);
    expect(spawnSync('git', ['check-ignore', '--quiet', '.env.example']).status).toBe(1);
  });

  it('derives the complete Vite-key set from the target template', () => {
    expect(requiredViteKeys({ VITE_ONE: '', NOT_VITE: '', VITE_TWO: '' })).toEqual(['VITE_ONE', 'VITE_TWO']);
  });
});
