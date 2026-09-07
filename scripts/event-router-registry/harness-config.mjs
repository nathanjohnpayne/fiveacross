import { parse as parseToml } from 'smol-toml';

const REQUIRED_ENTRYPOINT = 'RegistryLookupEntrypoint';
const REGISTRY_SERVICE = 'five-across-event-registry';
const SERVICES_KEY = 'services';
const ENV_KEY = 'env';
const UNSAFE_KEY = 'unsafe';
/** The complete key set of the one binding this file may declare. */
const BINDING_KEYS = ['binding', 'service', 'entrypoint'];
/**
 * Every top-level key these two configurations may declare.
 *
 * An ALLOWLIST, because the forbidden set is open-ended and grows with
 * Wrangler. `[[durable_objects.bindings]]` with `script_name` reaches the
 * registry's `HOST_REGISTRY` namespace directly — the exact capability the
 * named entrypoint exists to withhold — and `kv_namespaces`, `r2_buckets` and
 * `dispatch_namespaces` each grant something this router is documented as not
 * having. Enumerating those would leave whatever Cloudflare ships next
 * unlisted; enumerating what the file may contain does not. A new top-level
 * key is then a deliberate review moment rather than a silent capability.
 *
 * `routes` is permitted because attaching it IS the documented cutover and
 * `scripts/worker-deploy.sh` supports a route-bearing deploy; keeping the
 * wildcard blocks commented is `routerBinding.test.ts`'s assertion, not this
 * validator's.
 */
const TOP_LEVEL_KEYS = [
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'workers_dev',
  'observability',
  'vars',
  'services',
  'routes',
];

/**
 * Wrangler's configuration, judged as a PARSED TOML DOCUMENT rather than as
 * text that resembles one.
 *
 * This file used to carry a hand-written reader that tracked strings and
 * comments and attributed `key = "value"` lines to the header above them. It
 * was only ever as strong as the spellings its author happened to picture, and
 * TOML has more of them than anyone pictures. Three that it missed — each a
 * second, control-plane service binding that Wrangler honours and the guard
 * did not see — were reproduced against it:
 *
 *   - `[env.staging]` then `"services" = [ … ]`. The reader compared RAW key
 *     text, so a quoted key was a different key.
 *   - `env.staging.services = [ … ]` at the root. A dotted key names a nested
 *     table; the reader only understood table HEADERS.
 *   - `env = { staging = { services = [ … ] } }`. An inline table is a table.
 *
 * None of the three needs a CLI flag to reach a deploy: `scripts/worker-
 * deploy.sh` refuses Wrangler arguments, but Wrangler also selects an
 * environment from `CLOUDFLARE_ENV`, which the wrapper forwards like any other
 * variable. So "there is no `--env` on the command line" was never the same
 * claim as "there is no other binding in this file".
 *
 * The lesson is not that the reader needed three more cases. It is that a
 * capability gate must not own a parser for a format it does not define, so
 * this one does not: `smol-toml` (a zero-dependency TOML 1.0.0 implementation)
 * reads the whole document, and everything below is STRUCTURAL — it inspects
 * the resulting object, where a quoted key, a dotted key, an inline table and a
 * table header have already collapsed into the one shape they all denote.
 */

/**
 * A TOML *table*, and nothing else that happens to be a JS object.
 *
 * Arrays are values, and a TOML datetime parses to a `Date` subclass — neither
 * is a table, and treating one as a table is how a scan walks into a shape it
 * cannot judge and reports nothing rather than refusing.
 */
function isTable(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * The registry's lookup binding, validated from a Wrangler configuration.
 *
 * ONE validator, two consumers — the private synthetic harness and the public
 * Event router — for the same reason `src/slug.ts` is one list with two
 * consumers: the two configurations make the same capability claim, and two
 * validators that could disagree about what "bound to the lookup entrypoint"
 * means would let the more permissive one ship. An omitted or `default`
 * entrypoint binds the registry's default export instead, which is the signed
 * sync/audit/recovery control plane, so both spellings are refused here rather
 * than left to review.
 *
 * What it enforces, structurally:
 *
 *   - The document parses. A TOML error — an undefined escape, a duplicated
 *     key, a redefined table — refuses, because "unreadable" and "absent" must
 *     not be the same answer in a capability check.
 *   - The document declares NO named environment and NO `unsafe` table. See
 *     the notes on each below.
 *   - The top level declares exactly one `services` entry; it is a table; it
 *     carries exactly the keys `binding`, `service` and `entrypoint`; and they
 *     name `REGISTRY`, the registry service, and the lookup-only entrypoint.
 *     A `[vars]` entry that happens to be named `services`, `env` or `unsafe`
 *     is an ordinary Worker var in a table Wrangler reads no binding from, and
 *     is deliberately untouched — a false positive there is how a capability
 *     gate gets switched off.
 */
export function validateRegistryLookupBinding(config, subject) {
  const exactlyOnce = new Error(`${subject} must bind exactly once to ${REQUIRED_ENTRYPOINT}`);

  let document;
  try {
    // Wrangler reads its own configuration through `removeBOMAndValidate`, so a
    // BOM-prefixed file deploys perfectly well. Stripping it here keeps this
    // validator reading the SAME document Wrangler does — without it, a
    // correct configuration saved by an editor that writes a BOM is refused
    // with a message pointing at the one block that is right, which is how a
    // capability gate gets switched off.
    document = parseToml(config.replace(/^﻿/, ''));
  } catch {
    throw exactlyOnce;
  }
  if (!isTable(document)) throw exactlyOnce;

  // A named environment is refused OUTRIGHT, whatever it contains, because
  // neither thing it can contain is certifiable.
  //
  // Wrangler does not inherit service bindings into a named environment — its
  // own schema says they are "not automatically inherited from the top level
  // environment" and "must be specified in every named environment". So an
  // `[env.<name>]` either declares its own binding, which is a second copy of
  // this capability boundary selectable through `CLOUDFLARE_ENV` that no
  // reviewer of the top-level block would see; or it declares none, and
  // `CLOUDFLARE_ENV=<name>` then publishes a router carrying no registry
  // binding at all, which answers `lookup-unavailable` on every address while
  // reporting a clean deploy. This gate can certify neither, and
  // `specs/event-router-registry.md` authorises no routed environment. (The
  // "temporary preview environment" in worker/README.md is `wrangler dev
  // --remote`'s own; it is not an `[env.<name>]` block in this file.)
  //
  // Refusing the KEY rather than its spellings is what makes this total: a
  // table header, a dotted key, an inline table and a quoted key all parse to
  // the same root `env`, so there is no fourth spelling to have missed.
  if (Object.hasOwn(document, ENV_KEY)) {
    throw new Error(
      `${subject} must declare no named environment: a Wrangler environment inherits no service ` +
        `binding, so ${REQUIRED_ENTRYPOINT} cannot be certified for one`,
    );
  }

  // `[[unsafe.bindings]]` is Wrangler's escape hatch for bindings its schema
  // does not model, and an entry with `type = "service"` is a service binding
  // like any other — a second one, reachable with no environment and no CLI
  // flag. A gate that counted only `services` would certify a file that
  // uploads two. Refused as a table rather than entry by entry, for the same
  // reason `env` is: a rule about a KEY has no spellings left to miss, and this
  // configuration has no business declaring an unmodelled binding at all.
  if (Object.hasOwn(document, UNSAFE_KEY)) {
    throw new Error(
      `${subject} must declare no unsafe bindings: they bypass the ${REQUIRED_ENTRYPOINT} check`,
    );
  }

  // Nothing else at the top level. A binding does not have to be a `services`
  // entry to reach the registry: `[[durable_objects.bindings]]` carrying
  // `script_name = "five-across-event-registry"` binds its `HOST_REGISTRY`
  // namespace directly, which is the capability the named entrypoint exists to
  // withhold, and it adds no `services` entry for a count to find.
  const unknown = Object.keys(document).filter((key) => !TOP_LEVEL_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${subject} declares ${unknown.join(', ')}, which the ${REQUIRED_ENTRYPOINT} check does not cover`,
    );
  }

  if (!Object.hasOwn(document, SERVICES_KEY)) throw exactlyOnce;
  const declared = document[SERVICES_KEY];
  if (!Array.isArray(declared) || declared.length !== 1 || !isTable(declared[0])) throw exactlyOnce;

  // Read as OWN properties. An inherited value is not something this file
  // declared, and a capability check must not accept one.
  const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : null);
  const [block] = declared;
  // EXACTLY these three keys, because the binding's other schema fields change
  // what it reaches. `environment = "…"` binds a named environment of the
  // TARGET service — a different deployment of the registry, whose
  // `RegistryLookupEntrypoint` is whatever that deployment exports. Naming the
  // permitted keys rather than the forbidden ones is what keeps this true of
  // fields Wrangler has not added yet.
  const keys = Object.keys(block);
  if (keys.length !== BINDING_KEYS.length || !BINDING_KEYS.every((key) => keys.includes(key))) {
    throw exactlyOnce;
  }
  const binding = own(block, 'binding');
  const service = own(block, 'service');
  const entrypoint = own(block, 'entrypoint');
  if (binding !== 'REGISTRY' || service !== REGISTRY_SERVICE || entrypoint !== REQUIRED_ENTRYPOINT) {
    throw new Error(`${subject} must bind explicitly to ${REQUIRED_ENTRYPOINT}`);
  }
  return { binding, service, entrypoint };
}

export function validateHarnessServiceBinding(config) {
  return validateRegistryLookupBinding(config, 'harness');
}

export function validateRouterServiceBinding(config) {
  return validateRegistryLookupBinding(config, 'the Event router');
}
