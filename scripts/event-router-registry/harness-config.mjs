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

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/**
 * A quoted string starting at `start`, DECODED.
 *
 * The decoding is the point rather than tidiness. `[["services"]]` is a
 * valid TOML spelling of `[[services]]`, and a reader that compared the raw
 * bytes would see a differently-named table, skip it, and let a second binding
 * through — the same bypass class as an uncounted trailing comment, one
 * escape sequence lower. An escape TOML does not define returns `null` so the
 * caller fails closed rather than guessing at Wrangler's reading of it.
 */
function readQuoted(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === quote) return { value, end: index + 1 };
    // A literal (single-quoted) string has no escapes at all: its backslash is
    // a backslash.
    if (quote === '"' && character === '\\') {
      const escape = text[index + 1];
      if (escape === 'u' || escape === 'U') {
        const width = escape === 'u' ? 4 : 8;
        const hex = text.slice(index + 2, index + 2 + width);
        if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
        value += String.fromCodePoint(code);
        index += 2 + width;
        continue;
      }
      if (!Object.hasOwn(ESCAPES, escape)) return null;
      value += ESCAPES[escape];
      index += 2;
      continue;
    }
    value += character;
    index += 1;
  }
  return null;
}

/** A `key = value` right-hand side, when it is a plain string and nothing else. */
function unquote(value) {
  const text = value.trim();
  if (text.length === 0) return null;
  const read = readQuoted(text, 0);
  if (read === null || text.slice(read.end).trim().length !== 0) return null;
  return read.value;
}

/** One dotted segment: a bare key, or a single quoted key decoded. */
function keySegment(raw) {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text[0] === '"' || text[0] === "'") {
    const read = readQuoted(text, 0);
    if (read === null || text.slice(read.end).trim().length !== 0) return null;
    return read.value;
  }
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : null;
}

/**
 * `a.b."c"` → `['a', 'b', 'c']`, splitting only on dots outside quotes and
 * decoding each quoted segment. `null` for a name this reader cannot resolve.
 */
function dottedName(inner) {
  const parts = [];
  let current = '';
  let index = 0;
  while (index < inner.length) {
    const character = inner[index];
    if (character === '"' || character === "'") {
      const read = readQuoted(inner, index);
      if (read === null) return null;
      current += inner.slice(index, read.end);
      index = read.end;
      continue;
    }
    if (character === '.') {
      parts.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  parts.push(current);
  const segments = parts.map(keySegment);
  return segments.includes(null) ? null : segments;
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
 * written UNDER its own header, or `null` for a file this reader cannot
 * resolve.
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
      // A header whose name this reader cannot resolve must not degrade into
      // "not a header": that would leave the table uncounted AND attribute its
      // keys to the block above it, which is fail-OPEN in a capability check.
      if (header.path === null) return null;
      current = { ...header, keys: new Map() };
      tables.push(current);
      continue;
    }
    // Outside a string, a code line beginning with `[` can only be a table
    // header in TOML — a value line always starts with its key. One that did
    // not parse as a header above is therefore unreadable, not a value.
    if (trimmed.startsWith('[')) return null;

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
  if (tables === null) throw exactlyOnce;

  // The inline spelling, and only where it would actually be a binding: the
  // root table, or an `[env.<name>]` table. A `[vars]` entry that happens to be
  // named `services` is an ordinary Worker var, and refusing THAT would be a
  // false positive — the failure mode that gets a gate switched off.
  const inlineServices = (table) =>
    !table.array &&
    (table.path.length === 0 || (table.path[0] === 'env' && table.path.length === 2)) &&
    table.keys.has(SERVICES_TABLE);
  if (tables.some(inlineServices)) throw exactlyOnce;

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
