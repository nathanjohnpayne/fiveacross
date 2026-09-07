const REQUIRED_ENTRYPOINT = 'RegistryLookupEntrypoint';
const REGISTRY_SERVICE = 'five-across-event-registry';
const SERVICES_TABLE = 'services';

/**
 * Wrangler's configuration, read the way TOML defines it rather than the way it
 * usually looks.
 *
 * A capability gate that reads configuration with line regexes is only as
 * strong as the spellings its author happened to picture, and every spelling it
 * misses is a binding Wrangler will honour and the gate will not see. Three
 * of them matter here and none is exotic TOML:
 *
 *   - `[[services]] # control plane` is a valid header. A `^\s*\[\[services\]\]\s*$`
 *     line match does not see it, so a second service block written that way is
 *     invisible to the counter AND cut away by the truncation — the guard then
 *     reports exactly one lookup-only binding while Wrangler uploads two, the
 *     second bound to the registry's default control-plane export.
 *   - `[[services]]` inside a multi-line string or a comment is TEXT. Counting
 *     it would refuse a configuration that is in fact correct, which is the
 *     failure mode that gets a gate disabled.
 *   - `[[env.staging.services]]` is a services array too, under an environment.
 *
 * So the scanner below is a real (if small) TOML reader for the one shape this
 * file judges: it tracks strings and comments to decide what is code, then
 * attributes each `key = "value"` line to the table header above it. It parses
 * no arrays, dates, integers, or inline tables — anything it cannot judge is
 * refused rather than skipped, because "unrecognised" and "absent" must not be
 * the same answer in a capability check.
 */

/**
 * The configuration's logical lines, with comments removed and the contents of
 * strings excluded from what can look like structure.
 *
 * A multi-line string's newlines do NOT start logical lines, which is the whole
 * point: `x = """\n[[services]]\n"""` is one value, not a table header.
 */
function codeLines(config) {
  const source = config.replace(/\r\n/g, '\n');
  const lines = [];
  let current = '';
  let state = 'normal';
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (state === 'normal') {
      if (character === '\n') {
        lines.push(current);
        current = '';
        index += 1;
      } else if (character === '#') {
        // A comment runs to end of line and is not configuration, so nothing
        // written in one can stand in for a binding.
        while (index < source.length && source[index] !== '\n') index += 1;
      } else if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
        state = source[index] === '"' ? 'multilineBasic' : 'multilineLiteral';
        current += source.slice(index, index + 3);
        index += 3;
      } else if (character === '"' || character === "'") {
        state = character === '"' ? 'basic' : 'literal';
        current += character;
        index += 1;
      } else {
        current += character;
        index += 1;
      }
      continue;
    }

    if (state === 'basic' || state === 'literal') {
      if (state === 'basic' && character === '\\') {
        current += source.slice(index, index + 2);
        index += 2;
      } else if (character === (state === 'basic' ? '"' : "'")) {
        state = 'normal';
        current += character;
        index += 1;
      } else if (character === '\n') {
        // An unterminated single-line string is invalid TOML. Recover at the
        // line break rather than swallowing the rest of the file, so a typo
        // cannot hide a later table from the counter.
        state = 'normal';
        lines.push(current);
        current = '';
        index += 1;
      } else {
        current += character;
        index += 1;
      }
      continue;
    }

    const terminator = state === 'multilineBasic' ? '"""' : "'''";
    if (state === 'multilineBasic' && character === '\\') {
      index += 2;
    } else if (source.startsWith(terminator, index)) {
      state = 'normal';
      current += terminator;
      index += terminator.length;
    } else {
      // Deliberately dropped: the CONTENT of a multi-line string is data, and
      // its newlines do not end the logical line the value sits on.
      index += 1;
    }
  }

  lines.push(current);
  return lines;
}

function unquote(value) {
  const trimmed = value.trim();
  const basic = /^"([^"]*)"$/.exec(trimmed);
  if (basic !== null) return basic[1];
  const literal = /^'([^']*)'$/.exec(trimmed);
  if (literal !== null) return literal[1];
  return null;
}

/** `a.b."c"` → `['a', 'b', 'c']`, splitting only on dots outside quotes. */
function dottedName(inner) {
  const segments = [];
  let current = '';
  let quote = null;
  for (const character of inner) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '.') {
      segments.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  segments.push(current.trim());
  return segments;
}

function tableHeader(line) {
  const array = /^\[\[(.*)\]\]$/.exec(line);
  if (array !== null) return { array: true, path: dottedName(array[1]) };
  const table = /^\[([^[].*)\]$/.exec(line);
  if (table !== null) return { array: false, path: dottedName(table[1]) };
  return null;
}

/**
 * Every table in the file, each carrying only the `key = "string"` pairs
 * written UNDER its own header.
 *
 * A key repeated within one table resolves to `null` rather than to either
 * value: two answers is not an answer a capability check may pick between.
 */
function parseTables(config) {
  const root = { array: false, path: [], keys: new Map() };
  const tables = [root];
  let current = root;

  for (const line of codeLines(config)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const header = tableHeader(trimmed);
    if (header !== null) {
      current = { ...header, keys: new Map() };
      tables.push(current);
      continue;
    }

    const pair = /^([^=]+)=(.*)$/.exec(trimmed);
    if (pair === null) continue;
    const key = pair[1].trim();
    const value = unquote(pair[2]);
    current.keys.set(key, current.keys.has(key) ? null : value);
  }

  return tables;
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
 * Counting is over EVERY services array in the file, including one under an
 * environment (`[[env.staging.services]]`) and one whose header carries a
 * trailing comment, because Wrangler honours each of them and a guard that
 * claims "exactly one lookup-only binding" has to have seen each of them to say
 * so. The inline spelling (`services = [ … ]`) is refused outright: it is a
 * shape this validator does not read, and treating unreadable as absent is how
 * a capability check passes a configuration it never examined.
 */
export function validateRegistryLookupBinding(config, subject) {
  const tables = parseTables(config);
  const exactlyOnce = new Error(`${subject} must bind exactly once to ${REQUIRED_ENTRYPOINT}`);

  if (tables.some((table) => !table.array && table.keys.has(SERVICES_TABLE))) {
    throw exactlyOnce;
  }

  const services = tables.filter(
    (table) => table.array && table.path.at(-1) === SERVICES_TABLE,
  );
  if (services.length !== 1 || services[0].path.length !== 1) throw exactlyOnce;

  const [block] = services;
  const binding = block.keys.get('binding') ?? null;
  const service = block.keys.get('service') ?? null;
  const entrypoint = block.keys.get('entrypoint') ?? null;
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
