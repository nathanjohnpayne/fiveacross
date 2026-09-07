// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOOKUP_TIMEOUT_MS,
  DEFAULT_ROUTER_VERSION,
  registryFromEnv,
  routerConfigFromEnv,
  type RouterEnv,
} from './config';
import { handleRequest, isRouterConfigured, type RouterDeps } from './router';
import type { RegistryLookupService } from './resolve';

const REGISTRY: RegistryLookupService = { lookup: async () => ({ kind: 'unknown-host' }) };

const FULL: RouterEnv = {
  ORIGIN_HOST: 'fiveacross.web.app',
  ROUTER_VERSION: 'v9',
  REGISTRY,
};

describe('routerConfigFromEnv', () => {
  it('carries every bound value through', () => {
    expect(routerConfigFromEnv({ ...FULL, LOOKUP_TIMEOUT_MS: '750' })).toEqual({
      originHost: 'fiveacross.web.app',
      lookupTimeoutMs: 750,
      version: 'v9',
    });
  });

  it('carries no Firebase project id or api key, because the reader that needed them is gone', () => {
    // The removal is the deliverable (#972 / ADR 0014): with no Firebase
    // binding at all, the router is compatible with enforced App Check rather
    // than dependent on an exemption from it.
    const config = routerConfigFromEnv(FULL);
    expect(Object.keys(config).sort()).toEqual(['lookupTimeoutMs', 'originHost', 'version']);
    expect(JSON.stringify(config)).not.toMatch(/api ?key|firebase|project/i);
  });

  it('defaults the optional numeric and version bindings', () => {
    expect(routerConfigFromEnv(FULL).lookupTimeoutMs).toBe(DEFAULT_LOOKUP_TIMEOUT_MS);
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

  it.each(['1e3', '750.5', '2000ms', '2_000', '0x10', ' 12 34 '])(
    'refuses the PREFIX of a malformed binding (%s) rather than silently honouring it',
    (raw) => {
      // `Number.parseInt` accepts a valid prefix and discards the rest. `750.5`
      // becoming 750 merely looks like getting away with it; `1e3` becoming 1
      // is a ONE-MILLISECOND lookup timeout that fails closed on every host
      // while the binding reads as if it said one second.
      expect(routerConfigFromEnv({ ...FULL, LOOKUP_TIMEOUT_MS: raw }).lookupTimeoutMs).toBe(
        DEFAULT_LOOKUP_TIMEOUT_MS,
      );
    },
  );

  it('accepts a plain integer with incidental surrounding whitespace', () => {
    expect(routerConfigFromEnv({ ...FULL, LOOKUP_TIMEOUT_MS: ' 1500 ' }).lookupTimeoutMs).toBe(1500);
  });

  it('turns an UNBOUND string binding into an empty string, never undefined', () => {
    // The P1 this closes. A binding typed `string` while the runtime hands over
    // `undefined` is a lie the type checker cannot catch, and the first
    // `.length` read on it throws a Worker runtime error instead of rendering
    // the documented fail-closed response.
    const config = routerConfigFromEnv({});
    expect(config).toMatchObject({ originHost: '' });
    expect(typeof config.originHost).toBe('string');
  });
});

describe('registryFromEnv', () => {
  it('passes a bound service binding through untouched', () => {
    expect(registryFromEnv(FULL)).toBe(REGISTRY);
  });

  it('normalises an unbound binding to null rather than leaving it undefined', () => {
    // Same reason a string binding becomes `''`: the router ANSWERS an unbound
    // registry with `lookup-unavailable`, and an `undefined` that reaches a
    // method call answers with a runtime error instead.
    expect(registryFromEnv({})).toBeNull();
  });
});

describe('isRouterConfigured', () => {
  it('accepts a fully bound environment', () => {
    expect(isRouterConfigured(routerConfigFromEnv(FULL), { registry: registryFromEnv(FULL) })).toBe(true);
  });

  it('refuses an environment missing ORIGIN_HOST', () => {
    const env: RouterEnv = { ...FULL };
    delete env.ORIGIN_HOST;
    expect(isRouterConfigured(routerConfigFromEnv(env), { registry: registryFromEnv(env) })).toBe(false);
  });

  it('refuses an environment missing the REGISTRY binding', () => {
    const env: RouterEnv = { ...FULL };
    delete env.REGISTRY;
    expect(isRouterConfigured(routerConfigFromEnv(env), { registry: registryFromEnv(env) })).toBe(false);
  });
});

describe('an entirely unbound Worker', () => {
  it.each([
    'https://bodega-bay.fiveacross.app/',
    'https://bodega-bay.fiveacross.app/__/auth/handler',
    'https://fiveacross.app/',
    'https://bodega-bay.fiveacross.app/.well-known/fiveacross-path-capability',
  ])('renders the fail-closed response for %s instead of throwing', async (url) => {
    const fetchImpl = vi.fn(async () => new Response('should never be reached'));
    const deps: RouterDeps = {
      fetch: fetchImpl as unknown as RouterDeps['fetch'],
      // `{}` is exactly what the runtime hands over before the registry service
      // exists beside this Worker.
      registry: registryFromEnv({}),
    };

    const response = await handleRequest(new Request(url), routerConfigFromEnv({}), deps);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('lookup-unavailable');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
