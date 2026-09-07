import { parse as parseToml } from 'smol-toml';

const REQUIRED_ENTRYPOINT = 'RegistryLookupEntrypoint';
const REGISTRY_SERVICE = 'five-across-event-registry';
const SERVICES_KEY = 'services';
const ENV_KEY = 'env';

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
 * Every scope Wrangler would read a `services` array from: the top level, plus
 * one per named environment.
 *
 * `null` for a document whose `env` is a shape this check cannot judge — a
 * scalar, an array, or an environment that is not a table. Wrangler resolves an
 * environment's own bindings for that environment's upload, so an `env` this
 * function cannot enumerate is an unknown number of unexamined bindings, which
 * must fail closed rather than count as zero. A nested `env` inside an
 * environment is refused for the same reason: Wrangler has no nested
 * environments, so the document is expressing something this validator has no
 * reading of.
 */
function bindingScopes(document) {
  const scopes = [{ root: true, table: document }];
  if (!Object.hasOwn(document, ENV_KEY)) return scopes;

  const environments = document[ENV_KEY];
  if (!isTable(environments)) return null;
  for (const environment of Object.values(environments)) {
    if (!isTable(environment) || Object.hasOwn(environment, ENV_KEY)) return null;
    scopes.push({ root: false, table: environment });
  }
  return scopes;
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
 *   - `env`, if present, is a table of tables, none of them nested.
 *   - Every `services` value in every one of those scopes is an array of
 *     tables. A `[vars]` entry that happens to be named `services` is an
 *     ordinary Worker var in a scope Wrangler reads no binding from, and is
 *     deliberately untouched — a false positive there is how a capability gate
 *     gets switched off.
 *   - There is EXACTLY ONE service binding in the whole document, top level and
 *     every environment counted together, and it is declared at the top level.
 *     A named environment does not inherit top-level bindings, so a config that
 *     repeats even the identical lookup-only binding under `[env.<name>]` is
 *     refused too: this gate's claim is "one binding exists in this file", and
 *     a second copy is a second thing to keep correct, selectable by an
 *     environment variable, that no reviewer of the top-level block would see.
 *     If a routed environment is ever wanted, that decision changes the claim
 *     and belongs in `specs/event-router-registry.md` first.
 *   - That one binding names `REGISTRY`, the registry service, and the
 *     lookup-only entrypoint explicitly.
 */
export function validateRegistryLookupBinding(config, subject) {
  const exactlyOnce = new Error(`${subject} must bind exactly once to ${REQUIRED_ENTRYPOINT}`);

  let document;
  try {
    document = parseToml(config);
  } catch {
    throw exactlyOnce;
  }
  if (!isTable(document)) throw exactlyOnce;

  const scopes = bindingScopes(document);
  if (scopes === null) throw exactlyOnce;

  const bindings = [];
  let atTopLevel = 0;
  for (const scope of scopes) {
    if (!Object.hasOwn(scope.table, SERVICES_KEY)) continue;
    const declared = scope.table[SERVICES_KEY];
    if (!Array.isArray(declared) || !declared.every(isTable)) throw exactlyOnce;
    if (scope.root) atTopLevel += declared.length;
    bindings.push(...declared);
  }
  if (bindings.length !== 1 || atTopLevel !== 1) throw exactlyOnce;

  // Read as OWN properties. An inherited value is not something this file
  // declared, and a capability check must not accept one.
  const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : null);
  const [block] = bindings;
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
