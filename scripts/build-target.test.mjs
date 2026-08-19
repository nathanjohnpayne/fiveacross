// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  buildEnvironment,
  DEPLOY_TARGETS,
  envFileForTarget,
  requiredViteKeys,
  validateTargetOperationalMetadata,
} from './build-target.mjs';

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
  VITE_FIREBASE_API_KEY: DEPLOY_TARGETS.fiveacross.identity.VITE_FIREBASE_API_KEY,
  VITE_EVENT_ID: '',
  VITE_EDITION: 'vacay',
  VITE_ADULT_CONTENT: 'false',
  VITE_POSTHOG_KEY: 'shared-production-posthog-key',
  VITE_POSTHOG_HOST: '',
  VITE_RECAPTCHA_SITE_KEY: '',
};

const GAY_CRUISE_BINGO_TARGET_ENV = {
  VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
  VITE_FIREBASE_AUTH_DOMAIN: 'gaycruisebingo.com',
  VITE_FIREBASE_STORAGE_BUCKET: 'gaycruisebingo.firebasestorage.app',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '849798007162',
  VITE_FIREBASE_APP_ID: '1:849798007162:web:70dffafa77cc65a8306ec3',
  VITE_FIREBASE_MEASUREMENT_ID: 'G-42N7WYDYT5',
  VITE_FIREBASE_API_KEY: DEPLOY_TARGETS.gaycruisebingo.identity.VITE_FIREBASE_API_KEY,
  VITE_EVENT_ID: 'med-2026',
  VITE_EDITION: 'gcb',
  VITE_ADULT_CONTENT: 'true',
  VITE_POSTHOG_KEY: 'shared-production-posthog-key',
  VITE_POSTHOG_HOST: '',
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
        VITE_FIREBASE_API_KEY: DEPLOY_TARGETS.gaycruisebingo.identity.VITE_FIREBASE_API_KEY,
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
      VITE_FIREBASE_API_KEY: DEPLOY_TARGETS.fiveacross.identity.VITE_FIREBASE_API_KEY,
      VITE_EVENT_ID: '',
      VITE_EDITION: 'vacay',
      VITE_ADULT_CONTENT: 'false',
      VITE_RECAPTCHA_SITE_KEY: '',
      NODE_ENV: 'production',
      DEPLOY_TARGET_BUILD: '1',
      DEPLOY_TARGET_STATIC_EDITION: 'vacay',
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

  it('rejects a Five Across target file that pins any Event', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          ...FIVEACROSS_TARGET_ENV,
          VITE_EVENT_ID: 'bodega-bay-2026',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('VITE_EVENT_ID=""');
  });

  it('takes the shared target static fallback from trusted registry metadata', () => {
    const environment = buildEnvironment(
      'fiveacross',
      FIVEACROSS_TARGET_ENV,
      { DEPLOY_TARGET_STATIC_EDITION: 'gcb' },
      REQUIRED_VITE_KEYS,
    );

    expect(environment.DEPLOY_TARGET_STATIC_EDITION).toBe('vacay');
  });

  it('does not let a target without a static fallback inherit one', () => {
    const environment = buildEnvironment(
      'gaycruisebingo',
      GAY_CRUISE_BINGO_TARGET_ENV,
      { DEPLOY_TARGET_STATIC_EDITION: 'vacay' },
      REQUIRED_VITE_KEYS,
    );

    expect(environment.DEPLOY_TARGET_STATIC_EDITION).toBe('');
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

  it('rejects an API key copied from the other Firebase project', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          ...FIVEACROSS_TARGET_ENV,
          VITE_FIREBASE_API_KEY: DEPLOY_TARGETS.gaycruisebingo.identity.VITE_FIREBASE_API_KEY,
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow(`VITE_FIREBASE_API_KEY=${JSON.stringify(DEPLOY_TARGETS.fiveacross.identity.VITE_FIREBASE_API_KEY)}`);
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

  it('rejects a production PostHog host override', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          ...FIVEACROSS_TARGET_ENV,
          VITE_POSTHOG_HOST: 'https://us.i.posthog.com',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('VITE_POSTHOG_HOST=""');
  });

  it('requires a production PostHog key for every named target', () => {
    expect(() =>
      buildEnvironment(
        'fiveacross',
        {
          ...FIVEACROSS_TARGET_ENV,
          VITE_POSTHOG_KEY: '',
        },
        {},
        REQUIRED_VITE_KEYS,
      ),
    ).toThrow('VITE_POSTHOG_KEY');
  });

  it('requires every registered target to name its synthetic and purge choice', () => {
    expect(() =>
      validateTargetOperationalMetadata('future', { skipCloudflarePurge: true }),
    ).toThrow('syntheticUrl');
    expect(() =>
      validateTargetOperationalMetadata('future', {
        syntheticUrl: 'https://future.example/',
        skipCloudflarePurge: false,
        skipInvokerReconcile: false,
      }),
    ).toThrow('cloudflareZoneId');
    expect(() =>
      validateTargetOperationalMetadata('future', {
        syntheticUrl: 'https://future.example/',
        skipCloudflarePurge: true,
        skipInvokerReconcile: true,
        staticFallbackEdition: '',
      }),
    ).toThrow('staticFallbackEdition');
  });

  it('requires every registered target to state its invoker-reconciliation choice (#768)', () => {
    // Omitting it reads as `false`, which points scripts/deploy.sh at
    // gaycruisebingo's Cloud Run services with the new target's own
    // project-scoped credential and fails the deploy on a permissions error.
    // A silently-wrong default is exactly what this refuses.
    expect(() =>
      validateTargetOperationalMetadata('future', {
        syntheticUrl: 'https://future.example/',
        skipCloudflarePurge: true,
      }),
    ).toThrow('skipInvokerReconcile');
    expect(() =>
      validateTargetOperationalMetadata('future', {
        syntheticUrl: 'https://future.example/',
        skipCloudflarePurge: true,
        skipInvokerReconcile: 'true',
      }),
    ).toThrow('skipInvokerReconcile');
    expect(() =>
      validateTargetOperationalMetadata('future', {
        syntheticUrl: 'https://future.example/',
        skipCloudflarePurge: true,
        skipInvokerReconcile: true,
      }),
    ).not.toThrow();
  });

  it('states the invoker-reconciliation choice on every shipped target (#768)', () => {
    for (const [target, config] of Object.entries(DEPLOY_TARGETS)) {
      expect(typeof config.skipInvokerReconcile, target).toBe('boolean');
    }
  });

  it('ignores future target files without hiding the committed template', () => {
    expect(spawnSync('git', ['check-ignore', '--quiet', '.env.future-event']).status).toBe(0);
    expect(spawnSync('git', ['check-ignore', '--quiet', '.env.example']).status).toBe(1);
    expect(spawnSync('git', ['check-ignore', '--quiet', '.env.tpl']).status).toBe(1);
  });

  it('derives the complete Vite-key set from the target template', () => {
    expect(requiredViteKeys({ VITE_ONE: '', NOT_VITE: '', VITE_TWO: '' })).toEqual(['VITE_ONE', 'VITE_TWO']);
  });
});
