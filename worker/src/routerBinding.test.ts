// @vitest-environment node
//
// The router's CAPABILITY contract, read off the artifacts that actually decide
// it: `wrangler.toml`, Wrangler's own generated binding types, and the router
// sources. Everything here is a configuration fact rather than a behaviour, and
// each one is the kind that is invisible in a diff review and total at runtime
// — an omitted `entrypoint` line binds the registry's signed control plane to a
// public edge Worker, and a surviving Firebase binding falsifies the App Check
// posture the whole change exists to establish.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  declaresRoutes,
  validateRouterServiceBinding,
} from '../../scripts/event-router-registry/harness-config.mjs';
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

  it('is deployed by a plain `wrangler deploy`, with no configuration of its own', async () => {
    // The gate certifies the CONFIGURATION; the wrapper then runs
    // `npm --prefix worker run deploy`, so this script is the one place a
    // different configuration could still be selected — `-c alt.json`, an
    // `--env`, or a predeploy hook — without any flag reaching the wrapper.
    const manifest = JSON.parse(await readFile(resolve(HERE, '../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.deploy).toBe('wrangler deploy');
    expect(manifest.scripts.predeploy).toBeUndefined();
    expect(manifest.scripts.postdeploy).toBeUndefined();
  });

  it('is the configuration Wrangler would actually read', async () => {
    // Wrangler resolves `wrangler.json`, then `wrangler.jsonc`, then
    // `wrangler.toml`. A committed `worker/wrangler.json` would pass the
    // clean-tree guard, the deploy gate and CI while being the file that
    // actually uploads — the whole validator would be certifying a document
    // Wrangler never reads. `check-router-binding.mjs` refuses the same way.
    for (const outranking of ['wrangler.json', 'wrangler.jsonc']) {
      expect(existsSync(resolve(HERE, '..', outranking)), outranking).toBe(false);
      // The repo root is on the same ancestor chain: Wrangler searches every
      // ancestor for `wrangler.json` BEFORE it looks anywhere for a `.toml`.
      expect(existsSync(resolve(HERE, '../..', outranking)), outranking).toBe(false);
    }
    // And the gitignored redirect, which `git status` cannot see either.
    expect(existsSync(resolve(HERE, '../.wrangler/deploy/config.json'))).toBe(false);
  });

  it('keeps BOTH wildcard route blocks commented out', async () => {
    const config = await readFile(ROUTER_CONFIG, 'utf8');
    // Attaching a route IS the cutover, and #529 keeps exclusive authority over
    // it. A registry consumer change must never be able to perform one.
    expect(declaresRoutes(config)).toBe(false);
    expect(config).toContain('# [[routes]]');
    expect(config).toContain('# pattern = "*.fiveacross.app/*"');
    expect(config).toContain('# pattern = "*.vacaybingo.com/*"');

    // And uncommenting them EXACTLY WHERE THEY SIT attaches both, which is the
    // whole reason they are an array-of-tables. This block is the last thing in
    // the file, below the `[[services]]` header, and in TOML every key after a
    // header belongs to that table — so `routes = [ … ]` uncommented here would
    // become a key of the service binding. Wrangler accepts that without a
    // warning and resolves no top-level routes, so the documented cutover would
    // report success and change nothing.
    const uncommented = config
      .split('\n')
      .map((line) => (/^# (\[\[routes\]\]|pattern = |zone_name = )/.test(line) ? line.slice(2) : line))
      .join('\n');
    expect(declaresRoutes(uncommented)).toBe(true);
    expect(validateRouterServiceBinding(uncommented)).toEqual({
      binding: 'REGISTRY',
      service: 'five-across-event-registry',
      entrypoint: 'RegistryLookupEntrypoint',
    });
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
 * The validator PARSES TOML. It does not scan text that looks like TOML.
 *
 * Every case below is a spelling Wrangler honours, and the ones that must be
 * REFUSED are refused because the guard's claim is "exactly one lookup-only
 * binding in this file" — a claim it can only make about bindings it actually
 * saw. The predecessor of this validator hand-read the configuration line by
 * line, and a hand reader is only as strong as the spellings its author
 * pictured: `[env.staging]` with a quoted `"services"` key, a dotted
 * `env.staging.services = […]`, and an inline `env = { staging = { … } }` each
 * declared a second, control-plane binding it never counted. None of the three
 * needs a CLI flag to reach a deploy — `scripts/worker-deploy.sh` refuses
 * Wrangler arguments, but Wrangler also selects an environment from
 * `CLOUDFLARE_ENV`, which the wrapper forwards like any other variable.
 *
 * The ACCEPTED cases matter just as much and in the other direction. A
 * `[[services]]` or `[env.staging]` written inside a multi-line string or a
 * comment is text, and a `[vars]` entry named `services` or `env` is an
 * ordinary Worker var. A validator that refused those would refuse
 * configurations that are in fact correct — which is how a capability gate
 * ends up switched off.
 */
describe('the shared binding validator, read as TOML', () => {
  const ONLY_BINDING = [
    '[[services]]',
    'binding = "REGISTRY"',
    'service = "five-across-event-registry"',
    'entrypoint = "RegistryLookupEntrypoint"',
  ].join('\n');
  // A control-plane binding: same service, NO entrypoint, so Wrangler binds the
  // registry's default export. This is the payload every bypass below smuggles
  // in, and the reason each one has to be counted rather than skipped.
  const CONTROL_PLANE = '{ binding = "CONTROL", service = "five-across-event-registry" }';
  // A dotted or inline root key must be written BEFORE the `[[services]]`
  // header, because everything after a table header belongs to that table. Get
  // it wrong and the smuggled `env` lands inside the services entry, where
  // Wrangler would never read it — a fixture that proves nothing.
  const beforeTheBinding = (root: string) => `${root}\n\n${ONLY_BINDING}\n`;

  /**
   * Why EVERY named environment is refused, not merely the ones that smuggle a
   * binding.
   *
   * Wrangler does not inherit service bindings into a named environment, so an
   * `[env.<name>]` has only two possible contents and neither is certifiable.
   * Declare a binding there and it is a second copy of this capability
   * boundary, selectable through `CLOUDFLARE_ENV`, that no reviewer of the
   * top-level block would see. Declare none and `CLOUDFLARE_ENV=<name>`
   * publishes a router with no registry binding at all, which answers
   * `lookup-unavailable` on every address while reporting a clean deploy.
   * `specs/event-router-registry.md` authorises no routed environment; wanting
   * one changes what this gate claims and belongs in the spec first.
   *
   * Refusing the KEY rather than its spellings is what makes it total: a table
   * header, a dotted key, an inline table and a quoted key all parse to the
   * same root `env`, so there is no fourth spelling to have missed.
   */

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
      // Reproduced bypass 1. A quoted key is the same key; a reader comparing
      // raw key text saw `"services"` and `services` as two different names.
      'an environment whose services key is written quoted',
      `${ONLY_BINDING}\n\n[env.staging]\n"services" = [${CONTROL_PLANE}]\n`,
    ],
    [
      // Reproduced bypass 2. A dotted key names a nested table; a reader that
      // only understood table HEADERS saw an ordinary root assignment.
      'an environment declared with a dotted key',
      beforeTheBinding(`env.staging.services = [${CONTROL_PLANE}]`),
    ],
    [
      // Reproduced bypass 3. An inline table is a table.
      'an environment declared as an inline table',
      beforeTheBinding(`env = { staging = { services = [${CONTROL_PLANE}] } }`),
    ],
    [
      // The spellings compose: a quoted environment name inside a dotted
      // array-of-tables header is still `env.staging.services`.
      'an environment named by a quoted segment of a table header',
      `${ONLY_BINDING}\n\n[["env"."staging".services]]\nbinding = "CONTROL"\nservice = "five-across-event-registry"\n`,
    ],
    [
      // TOML decodes a quoted key's escapes, so `[["services"]]` NAMES the
      // services array. A reader comparing raw bytes would see a differently
      // named table, skip it, and let the second binding through — the same
      // bypass class as an uncounted trailing comment, one escape lower.
      'a second services header written with an escaped quoted key',
      `${ONLY_BINDING}\n\n[["serv\\u0069ces"]]\nbinding = "CONTROL"\nservice = "five-across-event-registry"\n`,
    ],
    [
      // Repeating the IDENTICAL lookup-only binding under an environment is
      // refused too, and deliberately — see the environment note above the
      // `it.each` below.
      'an environment that repeats the same lookup-only binding',
      `${ONLY_BINDING}\n\n[env.staging]\nservices = [{ binding = "REGISTRY", service = "five-across-event-registry", entrypoint = "RegistryLookupEntrypoint" }]\n`,
    ],
    [
      // A named environment does not inherit top-level bindings, so this is
      // not "the same binding, elsewhere" — it is a plain `wrangler deploy`
      // with no registry binding at all.
      'a lookup binding declared only under an environment',
      '[[env.staging.services]]\nbinding = "REGISTRY"\nservice = "five-across-event-registry"\nentrypoint = "RegistryLookupEntrypoint"\n',
    ],
    [
      // The other half of the environment hazard, and the one a "count the
      // bindings" rule would wave through: an environment that declares NO
      // binding. `CLOUDFLARE_ENV=staging` then publishes a router with no
      // registry binding at all, answering `lookup-unavailable` on every
      // address while reporting a clean deploy.
      'an environment that declares no service binding at all',
      `${ONLY_BINDING}\n\n[env.staging]\n[env.staging.vars]\nROUTER_VERSION = "staging"\n`,
    ],
    [
      'an environment declared with a dotted key that adds no service binding',
      beforeTheBinding('env.staging.vars.ROUTER_VERSION = "staging"'),
    ],
    [
      'an environment declared as an inline table that adds no service binding',
      beforeTheBinding('env = { staging = { vars = { ROUTER_VERSION = "staging" } } }'),
    ],
    [
      'an environment named by a quoted segment that adds no service binding',
      `${ONLY_BINDING}\n\n[env."staging".vars]\nROUTER_VERSION = "staging"\n`,
    ],
    ['an env that is not a table', beforeTheBinding('env = "staging"')],
    ['an environment that is not a table', `${ONLY_BINDING}\n\n[env]\nstaging = "x"\n`],
    [
      'a nested environment',
      `${ONLY_BINDING}\n\n[env.staging.env.production]\nname = "five-across-event-router"\n`,
    ],
    [
      // `[[unsafe.bindings]]` uploads bindings Wrangler's schema does not
      // model, and `type = "service"` is a service binding like any other —
      // a second one, with no environment and no CLI flag involved. A gate
      // that counted only `services` would certify a file that uploads two.
      'an unsafe service binding beside the real one',
      `${ONLY_BINDING}\n\n[[unsafe.bindings]]\nname = "CONTROL"\ntype = "service"\nservice = "five-across-event-registry"\n`,
    ],
    [
      'an unsafe binding written as an inline table',
      beforeTheBinding(
        'unsafe = { bindings = [{ name = "CONTROL", type = "service", service = "five-across-event-registry" }] }',
      ),
    ],
    [
      // Not every binding is a `services` entry. A cross-script Durable Object
      // binding reaches the registry's `HOST_REGISTRY` namespace directly —
      // the exact capability the named entrypoint exists to withhold — and it
      // adds nothing for a `services` count to find.
      'a cross-script Durable Object binding into the registry',
      `${ONLY_BINDING}\n\n[[durable_objects.bindings]]\nname = "HOST_REGISTRY"\nclass_name = "HostRegistryObject"\nscript_name = "five-across-event-registry"\n`,
    ],
    [
      'a KV namespace beside the binding',
      `${ONLY_BINDING}\n\n[[kv_namespaces]]\nbinding = "CACHE"\nid = "${'0'.repeat(32)}"\n`,
    ],
    [
      'an R2 bucket beside the binding',
      `${ONLY_BINDING}\n\n[[r2_buckets]]\nbinding = "ARCHIVE"\nbucket_name = "five-across"\n`,
    ],
    [
      'a dispatch namespace beside the binding',
      `${ONLY_BINDING}\n\n[[dispatch_namespaces]]\nbinding = "DISPATCH"\nnamespace = "five-across"\n`,
    ],
    [
      // The allowlist is what makes the four above total rather than a list
      // that Cloudflare's next binding type would outgrow.
      'a top-level key this configuration has no reviewed use for',
      `${ONLY_BINDING}\n\nplacement = { mode = "smart" }\n`,
    ],
    [
      // `environment` binds a named environment of the TARGET service — a
      // different deployment of the registry, whose `RegistryLookupEntrypoint`
      // is whatever that deployment exports.
      'a binding that names an environment of the registry service',
      '[[services]]\nbinding = "REGISTRY"\nservice = "five-across-event-registry"\nentrypoint = "RegistryLookupEntrypoint"\nenvironment = "control"\n',
    ],
    ['a services value that is not an array', 'services = "five-across-event-registry"\n'],
    ['a services array whose entry is not a table', 'services = ["five-across-event-registry"]\n'],
    ['a configuration that declares no service binding at all', '[vars]\nROUTER_VERSION = "v1"\n'],
    [
      // Defining `services` twice is a TOML error, and a parse error refuses:
      // "unreadable" and "absent" must not be the same answer here.
      'the inline array spelling beside the block one',
      `services = [${CONTROL_PLANE}]\n\n${ONLY_BINDING}\n`,
    ],
    [
      // An escape TOML does not define makes the whole document unreadable.
      'a table header carrying an undefined escape',
      `${ONLY_BINDING}\n\n["va\\qrs"]\nx = "1"\n`,
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
    [
      // `services` under `[vars]` is an ordinary Worker var, in a scope
      // Wrangler reads no binding from. Refusing it would be the false
      // positive that gets a capability gate switched off.
      'a [vars] entry that happens to be named services',
      `${ONLY_BINDING}\n\n[vars]\nservices = "human-readable note"\n`,
    ],
    [
      // Decoding runs in the accepting direction too: the one real binding
      // written with an escaped key is still that binding.
      'the one real header written with an escaped quoted key',
      '[["serv\\u0069ces"]]\nbinding = "REGISTRY"\nservice = "five-across-event-registry"\nentrypoint = "RegistryLookupEntrypoint"\n',
    ],
    [
      'an entrypoint value written with an escape',
      '[[services]]\nbinding = "REGISTRY"\nservice = "five-across-event-registry"\nentrypoint = "RegistryLookupEntrypoin\\u0074"\n',
    ],
    [
      // The inline array is now READ rather than refused for being inline. It
      // is one lookup-only binding written a second way, and judging it on its
      // contents is the whole difference between parsing and pattern-matching.
      'the one real binding written as an inline array',
      'services = [{ binding = "REGISTRY", service = "five-across-event-registry", entrypoint = "RegistryLookupEntrypoint" }]\n',
    ],
    // The positive controls for the environment refusals above. The rule is
    // structural — a root `env` TABLE — not a search for the letters `env`, and
    // without these a validator that refused any document merely mentioning one
    // would pass every environment case for the wrong reason.
    [
      'an env table header written inside a comment',
      `${ONLY_BINDING}\n\n# [env.staging]\n# services = [{ binding = "CONTROL" }]\n`,
    ],
    [
      'an env table header written inside a multi-line string',
      `${ONLY_BINDING}\n\n[vars]\nNOTE = """\n[env.staging]\nservices = []\n"""\n`,
    ],
    [
      // `vars.env` is a Worker variable named `env`, not a named environment.
      'a [vars] entry that happens to be named env',
      `${ONLY_BINDING}\n\n[vars]\nenv = "staging"\n`,
    ],
    [
      'a [vars] entry that happens to be named unsafe',
      `${ONLY_BINDING}\n\n[vars]\nunsafe = "false"\n`,
    ],
    [
      // Wrangler reads its own configuration through `removeBOMAndValidate`, so
      // this file deploys correctly. Refusing it would point the operator at
      // the one block that is right — the false positive that gets a gate
      // switched off.
      'a configuration saved with a byte-order mark',
      `﻿${ONLY_BINDING}\n`,
    ],
    [
      // `routes` is permitted because attaching it IS the documented cutover
      // and the deploy wrapper supports a route-bearing deploy. Keeping the
      // wildcard blocks commented is the assertion above, not this one.
      'a route beside the binding',
      `${ONLY_BINDING}\n\n[[routes]]\npattern = "r2-test.fiveacross.app/*"\nzone_name = "fiveacross.app"\n`,
    ],
    [
      // An allowlist only survives its trade if it LISTS the ordinary
      // settings. Refusing `preview_urls = false` — a hardening key — while
      // accepting the file without it would teach an operator that the gate is
      // the obstacle, which is how one gets switched off. None of these can
      // mint a binding.
      'the capability-free deployment settings a real configuration carries',
      `${beforeTheBinding(
        [
          `account_id = "${'a'.repeat(32)}"`,
          'preview_urls = false',
          'logpush = false',
          'upload_source_maps = true',
          'send_metrics = false',
          'keep_vars = false',
          'minify = true',
          'compatibility_flags = ["nodejs_compat"]',
        ].join('\n'),
      )}\n[limits]\ncpu_ms = 50\n\n[placement]\nmode = "smart"\n`,
    ],
    [
      'the singular route spelling Wrangler also accepts',
      beforeTheBinding('route = { pattern = "r2-test.fiveacross.app/*", zone_name = "fiveacross.app" }'),
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

  /**
   * Route-bearing is a question about the same document, so it is read the same
   * way. `scripts/worker-deploy.sh` announces "no routes configured, so this
   * changes nothing the public sees" on the strength of this answer — a
   * reassurance offered at exactly the moment an operator might be attaching
   * every wildcard Namespace hostname. It used to be a line grep for
   * `^\s*routes\s*=`, which is blind to two spellings Wrangler honours, one of
   * which is the shape the accept case above blesses.
   */
  it.each([
    ['the array spelling', `routes = [{ pattern = "a.fiveacross.app/*", zone_name = "fiveacross.app" }]\n\n${ONLY_BINDING}\n`],
    ['an array-of-tables header', `${ONLY_BINDING}\n\n[[routes]]\npattern = "a.fiveacross.app/*"\nzone_name = "fiveacross.app"\n`],
    ['a quoted key', `"routes" = [{ pattern = "a.fiveacross.app/*", zone_name = "fiveacross.app" }]\n\n${ONLY_BINDING}\n`],
    ['the singular spelling', `route = { pattern = "a.fiveacross.app/*", zone_name = "fiveacross.app" }\n\n${ONLY_BINDING}\n`],
  ])('reads %s as a route-bearing configuration', (_label, config) => {
    expect(declaresRoutes(config)).toBe(true);
  });

  it('reads the shipped configuration as attaching nothing', async () => {
    expect(declaresRoutes(await readFile(ROUTER_CONFIG, 'utf8'))).toBe(false);
    // A `routes` written inside a comment or a string is text here too.
    expect(declaresRoutes(`${ONLY_BINDING}\n\n# routes = [ … ]\n`)).toBe(false);
    expect(declaresRoutes(`${ONLY_BINDING}\n\n[vars]\nNOTE = """\nroutes = []\n"""\n`)).toBe(false);
  });

  it('refuses to answer about routes in a configuration it cannot read', () => {
    // The caller assumes a cutover when this throws, so "unreadable" must not
    // quietly become "no routes".
    expect(() => declaresRoutes('["va\\qrs"]\n')).toThrow();
  });

  it('refuses a services block that names the key twice', () => {
    // Two answers is not an answer a capability check may pick between, and
    // Wrangler's own resolution of a duplicate key is not this guard's to
    // guess at. TOML calls it an error, and an error refuses.
    expect(() =>
      validateRouterServiceBinding(
        '[[services]]\nbinding = "REGISTRY"\nservice = "five-across-event-registry"\nentrypoint = "RegistryLookupEntrypoint"\nentrypoint = "default"\n',
      ),
    ).toThrow('RegistryLookupEntrypoint');
  });
});
