import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// THE REGRESSION NET (#608 acceptance).
//
// The lexicon fixes today's ~60 leaks. This test is what keeps them fixed: this
// class of defect reappears with EVERY new string, because a cruise noun inside
// an otherwise-neutral sentence survives a find-and-replace of the brand name
// untouched — which is exactly why #554's mechanical sweep did not catch it and
// why the leak got as far as a Bodega guest's screen.
//
// So it scans the SOURCE, not the brand table. `edition-lexicon.test.ts` proves
// the table's non-cruise registers are clean; a table can be perfect while a new
// component hardcodes "Cruise schedule" beside it. Only a scan catches that, and
// only at the moment the string is written.
//
// The allowlist below is the whole design. Every entry is a place where a cruise
// noun is CORRECT — because the value is Edition-scoped, or because it is Gay
// Cruise Bingo's own content — and each one carries the reason. Adding a file
// here is a decision a reviewer can weigh; leaving it out is the default.

const SRC = resolve(__dirname);

/**
 * Files whose cruise vocabulary is deliberate. Every path needs a reason, and
 * "it was already there" is not one.
 */
const ALLOWED = new Map<string, string>([
  // The Edition table IS the vocabulary. Its `gcb` rows are cruise by
  // definition; `edition-lexicon.test.ts` guards the other two registers.
  ['editions.ts', 'the Edition table — cruise is one of the three registers it holds'],
  // Per-EVENT seed data for the Gay Cruise Bingo Event, not code copy. Owned by
  // #563 / #564; a Bodega or Five Across Event seeds its own pool.
  ['data/seed.ts', "Gay Cruise Bingo's own Event seed data (#563 / #564)"],
  // `welcome-aboard` / `so-long-farewell` are Theme IDS, deliberately kept by
  // #535 and GCB-scoped by `themesForEdition` — they never render elsewhere.
  ['theme/themes.ts', 'GCB-scoped Theme ids + labels, deliberately kept (#535)'],
  ['domainTypes.d.ts', 'the canonical ThemeId union naming those same GCB-scoped ids'],
  // Nothing else. `Nav.tsx` and `dayIdentity.tsx` were here until #602 shipped,
  // and `ShareCard.tsx` until Phase 4b folded its app name into the Edition —
  // the allowlist shrinks as the leaks close rather than being left to rot,
  // which is what the size assertion below is for.
]);

/** The nouns. Word-bounded, so `report`, `transport` and `passport` are safe. */
const CRUISE_NOUN =
  /\b(cruise|cruises|sail|sails|sailing|sailings|sea|seas|ship|ships|boat|boats|port|ports|aboard|onboard|docked|voyage)\b/i;

/** A string literal or a JSX text node — the two shapes user-facing copy takes.
 *
 *  The JSX pattern is deliberately narrow: SINGLE-LINE, starting with a letter,
 *  and restricted to characters prose actually uses. A looser `>…<` would match
 *  across a comparison operator and swallow whole function bodies (`if (today <
 *  first.date)` sits between a `>` and a `<` like any other text), which reports
 *  code as copy and makes the guard's failure output useless. */
const STRING_LITERAL = /'([^'\\\n]{4,})'|"([^"\\\n]{4,})"|`([^`\\\n]{4,})`/g;
const JSX_TEXT = />[ \t]*([A-Za-z][A-Za-z0-9 ,.'\u2019!?:\u2014\u2013\u2026&%#+/\u00a4-]{3,})[ \t]*</g;

/**
 * Comments are prose ABOUT the code, not copy the app renders — and a template
 * literal's `${…}` holes are expressions, not words. Both are removed before the
 * scan: the holes because leaving them in would make a template literal
 * unmatchable (the `$` breaks the pattern), which is precisely where interpolated
 * copy like `Cruise schedule for ${name}` lives.
 */
function scannableBody(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '')
    .replace(/\$\{[^{}]*\}/g, '\u00a4');
}

/** CSS class / test-id strings are implementation identifiers, not rendered
 * copy. Keep them out without allowing ordinary prose such as “Meet at port”. */
function isIdentifierList(text: string): boolean {
  return /[-_]/.test(text) && text.split(/\s+/).every((part) => /^[a-z][a-z0-9_-]*$/i.test(part));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

describe('no cruise noun survives in a string every Edition shares', () => {
  const offenders: { file: string; text: string }[] = [];

  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (ALLOWED.has(rel)) continue;
    const body = scannableBody(readFileSync(file, 'utf8'));
    for (const re of [STRING_LITERAL, JSX_TEXT]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const text = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (isIdentifierList(text)) continue;
        if (CRUISE_NOUN.test(text)) offenders.push({ file: rel, text });
      }
    }
  }

  it('finds none outside the allowlist', () => {
    const report = offenders.map((o) => `  ${o.file}: ${JSON.stringify(o.text)}`).join('\n');
    expect(
      offenders,
      offenders.length
        ? `Cruise vocabulary in a string that every Edition renders:\n${report}\n\n` +
            'Move it to `src/editions.ts` — a token on `EditionLexicon` if the sentence ' +
            'skeleton survives the swap, a whole-string override on `EditionBrand` if it ' +
            'does not (#608). If the string is genuinely Gay Cruise Bingo content or an ' +
            "Edition-scoped value, add the file to this test's ALLOWED map with the reason."
        : '',
    ).toEqual([]);
  });

  // A guard that silently matches NOTHING passes forever. This is the negative
  // control: run the same three patterns over a sample carrying one leak of each
  // shape and prove each is caught, so a regex that stops working fails HERE
  // rather than by quietly declaring the codebase clean.
  it('actually catches the three shapes a leak takes', () => {
    const sample = [
      "const a = 'Cruise schedule';",
      'const b = `Three for the whole cruise`;',
      '<p>Works offline at sea.</p>',
      "const c = 'Meet at the next port';",
      "const ok = 'Report a problem';", // `report` must NOT trip the word boundary
      '// a comment about the cruise', // comments are prose about code, not copy
    ].join('\n');
    const body = scannableBody(sample);
    const found: string[] = [];
    for (const re of [STRING_LITERAL, JSX_TEXT]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const text = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (isIdentifierList(text)) continue;
        if (CRUISE_NOUN.test(text)) found.push(text);
      }
    }
    expect(found).toEqual([
      'Cruise schedule',
      'Three for the whole cruise',
      'Meet at the next port',
      'Works offline at sea.',
    ]);
  });

  // A guard whose allowlist quietly grows is not a guard. Pinning the size means
  // widening it is a visible, reviewed line in the diff rather than a one-word
  // edit nobody reads.
  it('keeps the allowlist small and reasoned', () => {
    expect(ALLOWED.size).toBe(4);
    for (const [file, reason] of ALLOWED) {
      expect(reason.length, `${file} needs a real reason`).toBeGreaterThan(20);
    }
  });
});
