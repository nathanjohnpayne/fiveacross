// Reading the precache list back out of a BUILT service worker (#546).
//
// Why this exists at all: `manifest.webmanifest` used to ride in the Workbox
// precache, and nothing in the repo could see it. `vite.config.ts` globs
// `{js,css,html,svg,png,woff2}`, which excludes `.webmanifest`, so reading the
// config was actively misleading — `vite-plugin-pwa` appended the manifest
// UNCONDITIONALLY as an `additionalManifestEntries` item, downstream of every
// knob the config exposes. The only place the truth was visible was the emitted
// worker.
//
// And `grep` cannot read it. `dist/sw.js` is minified past the point where grep
// classifies it as binary, so `grep manifest.webmanifest dist/sw.js` reports
// NOTHING and exits 1 — a false all-clear that produced exactly one wrong
// conclusion already (#546, 2026-08-19). Parse it.
//
// Deliberately not a regex over the whole file: the entries are JSON, so the
// array is located and then JSON-parsed. That gives the callers a positive
// control — an extractor that silently stopped matching returns an EMPTY list,
// and a caller asserting only "the manifest is absent" would pass. Every caller
// here asserts the list is populated first.

/** One entry of the injected `self.__WB_MANIFEST` array. */
export interface PrecacheEntry {
  url: string;
  revision: string | null;
}

/**
 * Find the index just past the array that starts at `start`.
 *
 * A depth counter rather than a lazy regex, because entry URLs are string
 * literals that may legally contain brackets; string state (and its escapes)
 * is tracked so a `]` inside a URL cannot close the array early.
 */
function arrayEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isEntry(value: unknown): value is PrecacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<PrecacheEntry>;
  return typeof entry.url === 'string' && (entry.revision === null || typeof entry.revision === 'string');
}

/**
 * Every precache entry embedded in a built service worker.
 *
 * Minifier-agnostic: it keys off the injected JSON rather than off whatever
 * local name `precacheAndRoute` was mangled to, so a Vite or Workbox upgrade
 * that renames the call does not silently empty this list. Key order inside an
 * entry is not assumed either — Workbox emits `revision` first today, and that
 * is an implementation detail of its serializer.
 */
export function precacheEntries(serviceWorkerSource: string): PrecacheEntry[] {
  const entries: PrecacheEntry[] = [];
  const arrayStart = /\[\{"(?:revision|url)":/g;
  let match: RegExpExecArray | null;
  while ((match = arrayStart.exec(serviceWorkerSource)) !== null) {
    const end = arrayEnd(serviceWorkerSource, match.index);
    if (end === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(serviceWorkerSource.slice(match.index, end + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) if (isEntry(value)) entries.push(value);
  }
  return entries;
}

/** The URLs of {@link precacheEntries}, in emission order. */
export function precachedUrls(serviceWorkerSource: string): string[] {
  return precacheEntries(serviceWorkerSource).map((entry) => entry.url);
}
