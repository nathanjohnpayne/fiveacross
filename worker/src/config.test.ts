// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_LOOKUP_TIMEOUT_MS,
  DEFAULT_ROUTER_VERSION,
  routerConfigFromEnv,
  type RouterEnv,
} from './config';
import { handleRequest, isRouterConfigured, type RouterDeps } from './router';
import type { HostnameCache } from './resolve';

const FULL: RouterEnv = {
  ORIGIN_HOST: 'fiveacross.web.app',
  FIREBASE_PROJECT_ID: 'fiveacross',
  FIREBASE_API_KEY: 'web-key',
  ROUTER_VERSION: 'v9',
};

describe('routerConfigFromEnv', () => {
  it('carries every bound value through', () => {
    expect(routerConfigFromEnv({ ...FULL, LOOKUP_TIMEOUT_MS: '750', HOSTNAME_CACHE_TTL_MS: '60000' })).toEqual({
      originHost: 'fiveacross.web.app',
      projectId: 'fiveacross',
      apiKey: 'web-key',
      lookupTimeoutMs: 750,
      cacheTtlMs: 60_000,
      version: 'v9',
    });
  });

  it('defaults the optional numeric and version bindings', () => {
    const config = routerConfigFromEnv(FULL);
    expect(config.lookupTimeoutMs).toBe(DEFAULT_LOOKUP_TIMEOUT_MS);
    expect(config.cacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS);
    expect(routerConfigFromEnv({}).version).toBe(DEFAULT_ROUTER_VERSION);
  });

  it.each(['', 'not-a-number', '0', '-5', 'NaN'])(
    'falls back rather than propagating %s as a timeout',
    (raw) => {
      // A NaN here would make every timeout comparison silently false.
      expect(routerConfigFromEnv({ ...FULL, LOOKUP_TIMEOUT_MS: raw }).lookupTimeoutMs).toBe(
        DEFAULT_LOOKUP_TIMEOUT_MS,
      );
    },
  );

  it('turns an UNBOUND string binding into an empty string, never undefined', () => {
    // The P1 this closes. `wrangler.toml` deliberately does not commit
    // FIREBASE_API_KEY, so "deployed but not yet configured" is a state the
    // cutover procedure passes through on purpose. Typed as `string` while the
    // runtime hands over `undefined`, the first `.length` read threw a Worker
    // runtime error instead of rendering the documented fail-closed response.
    const config = routerConfigFromEnv({});
    expect(config).toMatchObject({ originHost: '', projectId: '', apiKey: '' });
    for (const value of [config.originHost, config.projectId, config.apiKey]) {
      expect(typeof value).toBe('string');
    }
  });
});

describe('isRouterConfigured', () => {
  it('accepts a fully bound environment', () => {
    expect(isRouterConfigured(routerConfigFromEnv(FULL))).toBe(true);
  });

  it.each(['ORIGIN_HOST', 'FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY'] as const)(
    'refuses an environment missing %s',
    (missing) => {
      const env: RouterEnv = { ...FULL };
      delete env[missing];
      expect(isRouterConfigured(routerConfigFromEnv(env))).toBe(false);
    },
  );
});

describe('an entirely unbound Worker', () => {
  const cache: HostnameCache = {
    read: async () => null,
    write: async () => {},
    drop: async () => {},
  };

  it.each([
    'https://bodega-bay.fiveacross.app/',
    'https://bodega-bay.fiveacross.app/__/auth/handler',
    'https://fiveacross.app/',
  ])('renders the fail-closed response for %s instead of throwing', async (url) => {
    let fetched = 0;
    const deps: RouterDeps = {
      fetch: (async () => {
        fetched += 1;
        return new Response('should never be reached');
      }) as RouterDeps['fetch'],
      cache,
      now: () => 0,
    };

    // `{}` is exactly what the runtime hands over before `wrangler secret put`.
    const response = await handleRequest(new Request(url), routerConfigFromEnv({}), deps);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('lookup-unavailable');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(fetched).toBe(0);
  });
});
