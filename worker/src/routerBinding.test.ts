// @vitest-environment node
//
// The router's CAPABILITY contract, read off the artifacts that actually decide
// it: `wrangler.toml`, Wrangler's own generated binding types, and the router
// sources. Everything here is a configuration fact rather than a behaviour, and
// each one is the kind that is invisible in a diff review and total at runtime
// — an omitted `entrypoint` line binds the registry's signed control plane to a
// public edge Worker, and a surviving Firebase binding falsifies the App Check
// posture the whole change exists to establish.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateRouterServiceBinding } from '../../scripts/event-router-registry/harness-config.mjs';
import type { RegistryLookupService } from './resolve';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER_CONFIG = resolve(HERE, '../wrangler.toml');
const GENERATED_TYPES = resolve(HERE, '../router-configuration.d.ts');
const ROUTER_SOURCES = ['index.ts', 'router.ts', 'resolve.ts', 'config.ts', 'host.ts', 'notFound.ts'];
const DEPLOY_WRAPPER = resolve(HERE, '../../scripts/worker-deploy.sh');

/**
 * A compile-time proof, not a runtime one: whatever Wrangler generates for the
 * `REGISTRY` binding must satisfy the one-method seam `config.ts` declares. If
 * the entrypoint ever grew a second method, or the binding were repointed at
 * the default export, this line would stop compiling under
 * `npm run typecheck` — before any test ran.
 */
type GeneratedBinding = Service<typeof import('./registry/registryWorker').RegistryLookupEntrypoint>;
const bindingSatisfiesRouterSeam: GeneratedBinding extends RegistryLookupService ? true : false = true;

describe('the Event router’s registry service binding', () => {
  it('binds REGISTRY explicitly to the named lookup-only entrypoint', async () => {
    const config = await readFile(ROUTER_CONFIG, 'utf8');
    expect(validateRouterServiceBinding(config)).toEqual({
      binding: 'REGISTRY',
      service: 'five-across-event-registry',
      entrypoint: 'RegistryLookupEntrypoint',
    });
    expect(bindingSatisfiesRouterSeam).toBe(true);
  });

  it.each([
    ['an omitted entrypoint', '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"'],
    [
      'the default entrypoint',
      '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"\nentrypoint="default"',
    ],
    [
      'a different entrypoint',
      '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"\nentrypoint="HostRegistryObject"',
    ],
    [
      'a second service block',
      '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"\nentrypoint="RegistryLookupEntrypoint"\n[[services]]\nbinding="OTHER"\nservice="five-across-event-registry"',
    ],
    [
      // Wrangler would bind the default control-plane export here: the
      // `entrypoint` key belongs to `[vars]`, not to the service. A validator
      // that scanned to end of file would read it as the service's own and
      // wave the deploy through.
      'an entrypoint that belongs to a LATER table',
      '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"\n\n[vars]\nentrypoint="RegistryLookupEntrypoint"',
    ],
    [
      'a service key that belongs to a later table',
      '[[services]]\nbinding="REGISTRY"\nentrypoint="RegistryLookupEntrypoint"\n\n[vars]\nservice="five-across-event-registry"',
    ],
    [
      // Comments are text, not configuration. One that looks like the binding
      // must not stand in for the binding.
      'an entrypoint that is only present in a comment',
      '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"\n# entrypoint="RegistryLookupEntrypoint"',
    ],
  ])('rejects %s', (_label, config) => {
    // Each of these is a one-word difference that silently hands the public
    // router the registry's default export — the signed sync/audit/recovery
    // control plane — instead of `lookup(host)`.
    expect(() => validateRouterServiceBinding(config)).toThrow('RegistryLookupEntrypoint');
  });

  it('exposes only `lookup` in Wrangler’s generated binding type', async () => {
    const generated = await readFile(GENERATED_TYPES, 'utf8');
    expect(generated).toContain(
      'REGISTRY: Service<typeof import("./src/registry/registryWorker").RegistryLookupEntrypoint>;',
    );
    // A bare `Service` (no type argument) is what an omitted entrypoint
    // generates, and it types the binding as the default export's `fetch`.
    expect(generated).not.toMatch(/REGISTRY:\s*Service\s*(?:\/\*|;)/);
    expect(generated).not.toMatch(/\bfetch\s*\(/);
    expect(generated).not.toContain('DurableObjectNamespace');
    expect(generated).not.toContain('KVNamespace');
    expect(generated).not.toMatch(/FIREBASE/);
  });
});

describe('what the router’s configuration no longer declares', () => {
  it('carries no Durable Object, KV, cache or Firebase binding', async () => {
    const config = await readFile(ROUTER_CONFIG, 'utf8');
    const declarations = config
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(declarations).not.toContain('durable_objects');
    expect(declarations).not.toContain('HOST_REGISTRY');
    expect(declarations).not.toContain('kv_namespaces');
    expect(declarations).not.toMatch(/FIREBASE_API_KEY|FIREBASE_PROJECT_ID/);
    expect(declarations).not.toContain('HOSTNAME_CACHE_TTL_MS');
  });

  it('keeps BOTH wildcard route blocks commented out', async () => {
    const config = await readFile(ROUTER_CONFIG, 'utf8');
    // Attaching a route IS the cutover, and #529 keeps exclusive authority over
    // it. A registry consumer change must never be able to perform one.
    expect(config).not.toMatch(/^\s*routes\s*=/m);
    expect(config).toContain('# routes = [');
    expect(config).toContain('#   { pattern = "*.fiveacross.app/*", zone_name = "fiveacross.app" },');
    expect(config).toContain('#   { pattern = "*.vacaybingo.com/*", zone_name = "vacaybingo.com" },');
  });

  it('no longer verifies a Firebase secret at deploy time, and refuses a leftover one', async () => {
    // The registry spec's acceptance names the Worker's Firestore code, its
    // bindings AND its deploy checks together, because a deploy gate that still
    // requires an edge Firebase credential would keep the credential alive
    // after the code that read it was deleted.
    const wrapper = await readFile(DEPLOY_WRAPPER, 'utf8');
    expect(wrapper).not.toContain('REQUIRED_SECRET');
    expect(wrapper).toContain('FORBIDDEN_SECRET="FIREBASE_API_KEY"');
    expect(wrapper).toContain('verify_registry_lookup_binding');
    expect(wrapper).toContain('wrangler secret delete');
  });
});

/**
 * Comments are stripped before matching, deliberately.
 *
 * These modules document what they REMOVED and why — the Firestore reader, the
 * `caches.default` envelope, the `FIREBASE_API_KEY` binding — because a
 * deletion with no record of itself gets reintroduced by the next person who
 * wonders why the lookup has no cache. Matching prose would make writing that
 * record impossible; matching code is the assertion that was wanted.
 */
function executableSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('what the router sources no longer reach for', () => {
  it.each(ROUTER_SOURCES)('has no Firestore, Firebase or Cache API surface in %s', async (file) => {
    const source = executableSource(await readFile(resolve(HERE, file), 'utf8'));
    expect(source).not.toContain('firestore.googleapis.com');
    expect(source).not.toMatch(/\bcaches\b/);
    expect(source).not.toMatch(/\bFIREBASE_[A-Z_]+/);
    expect(source).not.toContain('HOST_REGISTRY');
    // The seam is `lookup`, and only `lookup`: no default-fetch, list or
    // mutation call may appear against the registry binding.
    expect(source).not.toMatch(/registry\.(fetch|list|sync|recover|audit)\s*\(/);
  });

  it('reaches the registry through exactly one call site', async () => {
    const source = executableSource(await readFile(resolve(HERE, 'resolve.ts'), 'utf8'));
    expect([...source.matchAll(/registry\.\w+\(/g)].map((match) => match[0])).toEqual(['registry.lookup(']);
  });
});

/**
 * The validator reads TOML, not lines that look like TOML.
 *
 * Every case below is a spelling Wrangler honours, and the ones that must be
 * REFUSED are refused because the guard's claim is "exactly one lookup-only
 * binding" — a claim it can only make about headers it actually saw. A
 * line-shaped counter that matched `[[services]]` as a whole line missed the
 * commented and spaced forms entirely, which meant a second block written that
 * way bound the registry's default control-plane export while the deploy gate
 * reported a clean single binding.
 *
 * The ACCEPTED cases matter just as much and in the other direction: a
 * `[[services]]` written inside a multi-line string or a comment is text, and a
 * validator that counted those would refuse a configuration that is in fact
 * correct — which is how a capability gate ends up switched off.
 */
describe('the shared binding validator, read as TOML', () => {
  const ONLY_BINDING = [
    '[[services]]',
    'binding = "REGISTRY"',
    'service = "five-across-event-registry"',
    'entrypoint = "RegistryLookupEntrypoint"',
  ].join('\n');

  it.each([
    [
      // The exact bypass: `[[services]] # …` is a valid header, so Wrangler
      // uploads a SECOND binding — to the default control-plane export, with
      // no `entrypoint` — while a whole-line match sees only the first.
      'a second services header carrying a trailing comment',
      `${ONLY_BINDING}\n\n[[services]] # control plane\nbinding = "CONTROL"\nservice = "five-across-event-registry"\n`,
    ],
    [
      'a second services header written with interior whitespace',
      `${ONLY_BINDING}\n\n[[ services ]]\nbinding = "CONTROL"\nservice = "five-across-event-registry"\n`,
    ],
    [
      // Wrangler resolves an environment's own services array for that
      // environment's upload, so it is a binding this guard has to have seen.
      'a services array under an environment',
      `${ONLY_BINDING}\n\n[[env.staging.services]]\nbinding = "CONTROL"\nservice = "five-across-event-registry"\n`,
    ],
    [
      // The inline spelling is a shape this validator does not read. Refused
      // rather than skipped: "unrecognised" and "absent" must not be the same
      // answer in a capability check.
      'the inline array spelling beside the block one',
      `services = [{ binding = "CONTROL", service = "five-across-event-registry" }]\n\n${ONLY_BINDING}\n`,
    ],
  ])('refuses %s', (_label, config) => {
    expect(() => validateRouterServiceBinding(config)).toThrow('RegistryLookupEntrypoint');
  });

  it.each([
    [
      'a services header inside a multi-line basic string',
      `${ONLY_BINDING}\n\n[vars]\nNOTE = """\n[[services]]\nbinding = "CONTROL"\n"""\n`,
    ],
    [
      'a services header inside a multi-line literal string',
      `${ONLY_BINDING}\n\n[vars]\nNOTE = '''\n[[services]]\nbinding = "CONTROL"\n'''\n`,
    ],
    [
      'a services header inside a comment',
      `${ONLY_BINDING}\n\n# [[services]]\n# binding = "CONTROL"\n# service = "five-across-event-registry"\n`,
    ],
    [
      'the one real header written with interior whitespace and a trailing comment',
      '[[ services ]] # the router’s only dependency\nbinding = "REGISTRY"\nservice = "five-across-event-registry"\nentrypoint = "RegistryLookupEntrypoint"\n',
    ],
  ])('accepts %s', (_label, config) => {
    expect(validateRouterServiceBinding(config)).toEqual({
      binding: 'REGISTRY',
      service: 'five-across-event-registry',
      entrypoint: 'RegistryLookupEntrypoint',
    });
  });

  it('attributes keys to the table they were written under, not to the file', () => {
    // The #628-round-4 finding, kept: `entrypoint` in a LATER table is that
    // table's key, and reading it as the service's would wave through a
    // control-plane binding.
    expect(() =>
      validateRouterServiceBinding(
        '[[services]]\nbinding = "REGISTRY"\nservice = "five-across-event-registry"\n\n[vars]\nentrypoint = "RegistryLookupEntrypoint"\n',
      ),
    ).toThrow('RegistryLookupEntrypoint');
  });

  it('refuses a services block that names the key twice', () => {
    // Two answers is not an answer a capability check may pick between, and
    // Wrangler's own resolution of a duplicate key is not this guard's to
    // guess at.
    expect(() =>
      validateRouterServiceBinding(
        '[[services]]\nbinding = "REGISTRY"\nservice = "five-across-event-registry"\nentrypoint = "RegistryLookupEntrypoint"\nentrypoint = "default"\n',
      ),
    ).toThrow('RegistryLookupEntrypoint');
  });
});
