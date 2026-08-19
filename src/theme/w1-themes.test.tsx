import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  THEMES,
  themesForEdition,
  themesForEditionIncluding,
  defaultThemeForEdition,
  activeEdition,
  setActiveEdition,
  DEFAULT_EDITION,
} from './themes';
import { ThemeProvider, useTheme } from './ThemeContext';
import { contrastRatio, hexToRgb, parseThemeBlocks } from './contrast';

// Covers specs/w1-themes.md: WCAG AA contrast across all 8 [data-theme]
// blocks, ThemeContext's persistence + async-default invariants, the <5s PRD
// switch-latency metric, and the "no Atlantis marks" non-goal.
//
// The WCAG 2.1 luminance/contrast helpers and the themes.css block parser live
// in ./contrast (shared with the badge and theme-on-color suites) so the suite
// computes from one implementation and never hand-transcribes a color table.
// Ratios are still computed over [data-theme] blocks parsed straight out of
// themes.css, so this test can never drift from the CSS it polices.

// `join(dirname(fileURLToPath(import.meta.url)), ...)` rather than
// `new URL('./themes.css', import.meta.url)`: Vite statically rewrites the
// latter two-argument form into a dev-server asset URL (its "explicit URL
// imports" asset handling), which isn't a file:// URL under Vitest.
const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'themes.css');
const themeBlocks = parseThemeBlocks(readFileSync(cssPath, 'utf-8'));

// Foreground/background token pairs src/index.css assigns as literal color
// values — see specs/w1-themes.md § WCAG AA contrast contract for the
// call-site inventory.
//
// Every one of --ink/--dim/--accent is used as a real text fill somewhere in
// src/index.css (not merely a border or glow), so every pair below is held
// to the 4.5:1 normal-text floor (WCAG 1.4.3) rather than the looser 3:1
// non-text/UI-component floor (1.4.11): --accent drives a border/box-shadow
// *and* a text fill with the identical custom-property value, so the
// stricter bar is the binding constraint for the variable either way.
// Border/glow-only call sites that reuse these same pairs (.cell.free
// border, etc.) are covered for free since they share the checked value.
//
// primary/bg and secondary/bg (issue #72, specs/theme-on-color-contrast.md):
// retired as *text* pairs here. .brand b / .bingo-head span (the B-I-N-G-O
// header) and .count b used to fill text with --primary/--secondary
// directly on body's gradient-tinted background — the former "Known bound"
// this suite deliberately didn't chase (verified to drop as low as 3.15:1
// for summer-white's --primary against its own tint) — and now use --ink
// instead; see theme-on-color-contrast.test.tsx for that fix's coverage.
// --primary/--secondary still back border/box-shadow-only call sites
// (.btn.primary, .chip.active, .row .rank text on --panel, etc.) at the
// looser 3:1 UI-component floor or on --panel, not --bg, so no pair below
// is needed to cover them.
const TEXT_PAIRS: [fg: string, bg: string][] = [
  ['ink', 'bg'], // body text; .signin h1; .celebrate .big (flat-bg floor — see theme-on-color-contrast.test.tsx for the composited-backdrop checks)
  ['ink', 'panel'], // .row .name, .input text
  ['ink', 'cell'], // .cell text
  ['dim', 'bg'], // .muted, .count, .ack, inactive .tab
  ['dim', 'panel'], // .row .sub
  ['primary', 'panel'], // .row .rank (leaderboard rank numbers, 22px normal weight)
  ['accent', 'cell'], // .cell.free text ("FREE")
  ['accent', 'panel'], // .badge ("1st BINGO")
];
const TEXT_MIN = 4.5; // WCAG 1.4.3 Contrast (Minimum), normal text

describe('themes.css — WCAG AA contrast (specs/w1-themes.md)', () => {
  it('defines a [data-theme] block for every ThemeId', () => {
    for (const t of THEMES) {
      expect(themeBlocks[t.id], `missing [data-theme='${t.id}'] block in themes.css`).toBeDefined();
    }
  });

  for (const t of THEMES) {
    const vars = themeBlocks[t.id] ?? {};

    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${t.id}: --${fg} on --${bg} meets ${TEXT_MIN}:1`, () => {
        expect(contrastRatio(hexToRgb(vars[fg]), hexToRgb(vars[bg]))).toBeGreaterThanOrEqual(TEXT_MIN);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// ThemeContext — persistence, the async-default invariant, and switch latency.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'gcb.theme';

// This repo's Vitest jsdom project doesn't configure a same-origin `url`, so
// jsdom leaves `window.localStorage` unset (ThemeContext.tsx's try/catch
// around every localStorage call is defensive against exactly this). Install
// a minimal in-memory Storage so the persistence behavior under test is real
// rather than a silently-swallowed no-op; scoped to this file only.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

if (!window.localStorage) {
  Object.defineProperty(window, 'localStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}

function ThemeProbe() {
  const { theme, setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme('seriously-pink')}>
      {theme}
    </button>
  );
}

describe('ThemeContext — persistence and defaults (specs/w1-themes.md)', () => {
  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('defaults to neon-playground and does not auto-persist the default', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('neon-playground');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('applies an explicit pick to <html data-theme> and persists it, well under the 5s PRD budget', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    const startedAt = performance.now();
    await user.click(screen.getByRole('button'));
    const elapsedMs = performance.now() - startedAt;

    expect(screen.getByRole('button')).toHaveTextContent('seriously-pink');
    expect(document.documentElement.dataset.theme).toBe('seriously-pink');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('seriously-pink');
    expect(elapsedMs).toBeLessThan(5000); // PRD: a Theme switch applies in <5s.
  });

  it('adopts an async-arriving event/player default when the user has not chosen', () => {
    const { rerender } = render(
      <ThemeProvider defaultTheme="neon-playground">
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('neon-playground');

    // Simulate the Firestore-sourced event/player default resolving after mount.
    rerender(
      <ThemeProvider defaultTheme="get-sporty">
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('get-sporty');
  });

  it('never lets an async-arriving default override an explicit user pick', () => {
    window.localStorage.setItem(STORAGE_KEY, 'seriously-pink');
    const { rerender } = render(
      <ThemeProvider defaultTheme="neon-playground">
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('seriously-pink');

    rerender(
      <ThemeProvider defaultTheme="get-sporty">
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('seriously-pink');
  });
});

// ---------------------------------------------------------------------------
// ThemeContext — the "Auto: match the day" preference (specs/d15-more-menu.md
// § Theme). Extends the persistence/default suite above in place (this is
// where ThemeContext's tests already live) rather than forking a separate
// ThemeContext.test.tsx.
// ---------------------------------------------------------------------------

function ThemePreferenceProbe() {
  const { theme, preference, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="preference">{preference}</span>
      <button type="button" onClick={() => setTheme('auto')}>
        pick auto
      </button>
      <button type="button" onClick={() => setTheme('seriously-pink')}>
        pick seriously-pink
      </button>
    </div>
  );
}

describe('ThemeContext — Auto: match the day (specs/d15-more-menu.md § Theme)', () => {
  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('defaults to auto and resolves to the supplied autoThemeId, never persisting it', () => {
    render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty">
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('auto');
    expect(screen.getByTestId('theme')).toHaveTextContent('get-sporty');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('falls back to defaultTheme when auto has no autoThemeId (pre-cruise / no Days)', () => {
    render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId={null}>
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('auto');
    expect(screen.getByTestId('theme')).toHaveTextContent('neon-playground');
  });

  it('re-resolves auto live as autoThemeId arrives/changes from Firestore', () => {
    const { rerender } = render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId={null}>
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('neon-playground');

    rerender(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="seriously-pink">
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('seriously-pink');
  });

  it('an explicit pick still saves and overrides auto', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty">
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'pick seriously-pink' }));
    expect(screen.getByTestId('preference')).toHaveTextContent('seriously-pink');
    expect(screen.getByTestId('theme')).toHaveTextContent('seriously-pink');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('seriously-pink');
  });

  it('picking auto after an explicit pick clears the saved value', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty">
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'pick seriously-pink' }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('seriously-pink');

    await user.click(screen.getByRole('button', { name: 'pick auto' }));
    expect(screen.getByTestId('preference')).toHaveTextContent('auto');
    expect(screen.getByTestId('theme')).toHaveTextContent('get-sporty');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('an explicit saved pick wins over autoThemeId on initial mount (no auto default)', () => {
    window.localStorage.setItem(STORAGE_KEY, 'seriously-pink');
    render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty">
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('seriously-pink');
    expect(screen.getByTestId('theme')).toHaveTextContent('seriously-pink');
  });

  // Codex P2 on #232: `defaultTheme` used to carry the Player's cross-device
  // pick (main.tsx's old `player?.theme ?? event?.defaultTheme ?? ...`), so a
  // device with no local override started at `preference === 'auto'` and
  // `autoThemeId` silently outranked the Player's saved pick as soon as a Day
  // was current. `playerTheme` is now a distinct prop, adopted as the
  // preference — never folded into the Auto resolution — so it outranks
  // `autoThemeId` even though it arrives async after the Day's already known.
  it('adopts an async-arriving playerTheme (cross-device pick) even with a current Day, on a device with no local override', () => {
    const { rerender } = render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty" playerTheme={null}>
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('auto');
    expect(screen.getByTestId('theme')).toHaveTextContent('get-sporty');

    // The Player's saved cross-device pick arrives from Firestore after mount.
    rerender(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty" playerTheme="seriously-pink">
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('seriously-pink');
    expect(screen.getByTestId('theme')).toHaveTextContent('seriously-pink');
  });

  // Codex P3 on #232: a malformed/stale `players/{uid}.theme` (e.g. a
  // retired ThemeId from older data) must not become the active `data-theme`
  // — the pre-Auto async-default path validated with `isThemeId` before
  // applying, and the playerTheme-adopt effect needs the same runtime guard,
  // not just the TS `ThemeId` type (which the actual Firestore read doesn't
  // enforce).
  it('ignores a malformed async-arriving playerTheme instead of adopting it', () => {
    const { rerender } = render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty" playerTheme={null}>
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('auto');

    rerender(
      <ThemeProvider
        defaultTheme="neon-playground"
        autoThemeId="get-sporty"
        playerTheme={'retired-theme-id' as unknown as (typeof THEMES)[number]['id']}
      >
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('auto');
    expect(screen.getByTestId('theme')).toHaveTextContent('get-sporty');
  });

  it('never lets an async-arriving playerTheme override a local gcb.theme override', () => {
    window.localStorage.setItem(STORAGE_KEY, 'seriously-pink');
    const { rerender } = render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty" playerTheme={null}>
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('seriously-pink');

    rerender(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty" playerTheme="get-sporty">
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('seriously-pink');
    expect(screen.getByTestId('theme')).toHaveTextContent('seriously-pink');
  });

  it('never lets an async-arriving playerTheme override an explicit in-session pick', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty" playerTheme={null}>
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'pick seriously-pink' }));
    expect(screen.getByTestId('preference')).toHaveTextContent('seriously-pink');

    rerender(
      <ThemeProvider defaultTheme="neon-playground" autoThemeId="get-sporty" playerTheme="get-sporty">
        <ThemePreferenceProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('seriously-pink');
  });
});

describe('Theme metadata (specs/w1-themes.md)', () => {
  it('keeps Neon Playground as the first/default Theme', () => {
    expect(THEMES[0]?.id).toBe('neon-playground');
  });

  it('carries no Atlantis mark, trademark, or affiliation text (PRD non-goal)', () => {
    const bannedPatterns = [/atlantis/i, /[®™]/];
    for (const t of THEMES) {
      for (const pattern of bannedPatterns) {
        expect(t.label, `Theme "${t.id}" label leaks a mark: "${t.label}"`).not.toMatch(pattern);
        expect(
          t.description,
          `Theme "${t.id}" description leaks a mark: "${t.description}"`,
        ).not.toMatch(pattern);
      }
    }
  });
});

// --- Edition scoping (#555) --------------------------------------------------
//
// `THEMES` is the complete REGISTRY and must stay complete: Leaderboard,
// dayIdentity, DaySwitcher and Board all look a Theme up BY ID for its emoji
// and label, so narrowing the registry would turn those into silent fallbacks.
// Only the PICKER is scoped. These pin that split.

describe('themesForEdition — pickable list is scoped, registry is not', () => {
  const ids = (edition?: string | null) => themesForEdition(edition).map((t) => t.id);

  it('defaults to the legacy Edition, so today\'s picker is unchanged', () => {
    // Edition is not resolved anywhere yet (#543). If this default ever became
    // "shared only", the cruise's own tutorial Themes would vanish from its
    // switcher the moment this shipped — a silent production regression.
    expect(DEFAULT_EDITION).toBe('gcb');
    expect(ids()).toContain('welcome-aboard');
    expect(ids()).toContain('so-long-farewell');
  });

  it('never offers a Bodega or Five Across Theme on the Gay Cruise Bingo picker', () => {
    for (const id of [
      'the-birds',
      'side-quests',
      'fog-froth-farewells',
      'marquee',
      'confetti-hour',
      'afterglow',
    ]) {
      expect(ids('gcb')).not.toContain(id);
    }
  });

  it('offers EXACTLY the Bodega Themes on the Vacay picker', () => {
    // The regression this pins (Codex on #577): the first cut treated a Theme
    // with no declared Edition as shared, and every Atlantis party Theme was
    // undeclared — so the Bodega picker opened with Dog Tag T-Dance in it.
    expect(ids('vacay')).toEqual(['the-birds', 'side-quests', 'fog-froth-farewells']);
  });

  it('offers EXACTLY the Five Across Themes on the fiveacross picker', () => {
    // The same regression #617 closes for the third Edition: before these rows
    // existed, `known` computed false for 'fiveacross' and the picker fell back
    // to the whole gcb scope — Dog Tag T-Dance on a conference's Theme picker.
    // `fiveacross-slate` is deliberately NOT here — see the chrome-exclusion
    // describe block below (#882).
    expect(ids('fiveacross')).toEqual(['marquee', 'confetti-hour', 'afterglow']);
  });

  it.each(['vacay', 'fiveacross'])('keeps every legacy party Theme out of %s by name', (edition) => {
    for (const id of [
      'neon-playground',
      'get-sporty',
      'duty-free',
      'glamiators',
      'summer-white',
      'dog-tag',
      'revival-disco',
      'seriously-pink',
      'uniforms-without-borders',
      'neon-pink-playground',
      'sporty-splash',
      'under-the-stars',
      'atlantis-classics',
    ]) {
      expect(ids(edition)).not.toContain(id);
    }
  });

  it('PARTITIONS the pickable registry — every non-chrome Theme is pickable on exactly one Edition', () => {
    // Stronger than the two lists above: a Theme added without an Edition can
    // no longer slip through as "shared", and a Theme claimed by two Editions
    // has to be a deliberate, visible choice rather than an omission.
    //
    // The union excludes `chrome`-flagged Themes on purpose (#882): a
    // platform-chrome Theme is registered and `THEME_EDITIONS`-bound like any
    // other, but `themesForEdition` filters it out of every picker, so it is
    // never a member of any Edition's pick list — see the dedicated
    // "platform-chrome Themes" describe block below for that half of the
    // contract. Subtracting it here keeps this test's job narrow: the
    // NON-CHROME registry still partitions pairwise with no overlap and
    // nothing left out.
    const gcb = ids('gcb');
    const vacay = ids('vacay');
    const fiveacross = ids('fiveacross');
    const pickableRegistry = THEMES.filter((t) => !t.chrome).map((t) => t.id);
    expect([...gcb, ...vacay, ...fiveacross].sort()).toEqual(pickableRegistry.sort());
    expect(gcb.filter((id) => vacay.includes(id))).toEqual([]);
    expect(gcb.filter((id) => fiveacross.includes(id))).toEqual([]);
    expect(vacay.filter((id) => fiveacross.includes(id))).toEqual([]);
  });

  it('falls back to the legacy Edition for an Edition nothing recognises', () => {
    // Degrading to the legacy experience beats degrading to an empty picker.
    expect(ids('not-an-edition')).toEqual(ids('gcb'));
  });

  it('follows the ACTIVE Edition when no argument is passed', () => {
    try {
      setActiveEdition('vacay');
      expect(ids()).toEqual(['the-birds', 'side-quests', 'fog-froth-farewells']);
      expect(activeEdition()).toBe('vacay');
      setActiveEdition(null);
      expect(activeEdition()).toBe(DEFAULT_EDITION);
      expect(ids()).toContain('welcome-aboard');
    } finally {
      setActiveEdition(DEFAULT_EDITION);
    }
  });

  it('leaves the REGISTRY complete regardless of Edition', () => {
    // The id->emoji lookups depend on this; a scoped registry breaks them.
    const registry = THEMES.map((t) => t.id);
    for (const id of ['the-birds', 'welcome-aboard', 'neon-playground', 'marquee']) {
      expect(registry).toContain(id);
    }
  });
});

// --- Platform-chrome Themes (#882) ------------------------------------------
//
// A Theme MAY be flagged `chrome: true` on its THEMES entry instead of being
// an ordinary occasion Theme: it dresses surfaces that have no Day (utility
// states, the admin console, email, gallery/share surfaces outside a Day
// context), never a Day a player or organizer can wear. `fiveacross-slate` is
// the first (and, as of this ticket, only) one. It stays in the complete
// REGISTRY and the WCAG contrast suite above audits it exactly like any other
// Theme — `chrome` only narrows the PICKER, per the split `themesForEdition`'s
// own doc comment draws.
describe('platform-chrome Themes are registered but never pickable (#882)', () => {
  it('fiveacross-slate is in the registry, flagged chrome, and never the fiveacross Edition default', () => {
    const meta = THEMES.find((t) => t.id === 'fiveacross-slate');
    expect(meta).toBeDefined();
    expect(meta?.chrome).toBe(true);
    expect(defaultThemeForEdition('fiveacross')).not.toBe('fiveacross-slate');
  });

  it.each(['gcb', 'vacay', 'fiveacross', 'not-an-edition'])(
    'fiveacross-slate is absent from the %s picker',
    (edition) => {
      expect(themesForEdition(edition).map((t) => t.id)).not.toContain('fiveacross-slate');
    },
  );

  it('themesForEditionIncluding still surfaces it (prepended) if a stored value ever names it', () => {
    // Defense in depth: no picker offers this id, so no UI path can write it
    // to a Day or defaultTheme — but if a hand-edited Firestore doc ever did,
    // the admin control must display it rather than silently substituting a
    // different Theme (the same "never misreport what is set" contract
    // themesForEditionIncluding gives an ordinary off-Edition Theme).
    const list = themesForEditionIncluding('fiveacross-slate', 'fiveacross').map((t) => t.id);
    expect(list[0]).toBe('fiveacross-slate');
    expect(list).toEqual(['fiveacross-slate', 'marquee', 'confetti-hour', 'afterglow']);
  });
});

// The admin controls display a stored Theme as well as change it, so their list
// cannot be a plain scoped list: a `<select>` whose value matches no option
// silently renders the first one instead.
describe('themesForEditionIncluding — never misreports what is already set', () => {
  it('adds an off-Edition current Theme, at the front', () => {
    const list = themesForEditionIncluding('the-birds', 'gcb').map((t) => t.id);
    expect(list[0]).toBe('the-birds');
    expect(list).toContain('neon-playground');
  });

  it('does not duplicate a current Theme that is already in scope', () => {
    const list = themesForEditionIncluding('neon-playground', 'gcb').map((t) => t.id);
    expect(list.filter((id) => id === 'neon-playground')).toHaveLength(1);
    expect(list).toEqual(themesForEdition('gcb').map((t) => t.id));
  });

  it('is just the scoped list when nothing is set yet', () => {
    expect(themesForEditionIncluding(undefined, 'vacay').map((t) => t.id)).toEqual([
      'the-birds',
      'side-quests',
      'fog-froth-farewells',
    ]);
  });
});

// The last resort in the chain player pick -> Event `defaultTheme` -> Edition
// default. It matters most where the chain is shortest: the signed-out shell
// reads no Event doc at all, so this line alone decides what a Vacay build wears
// before sign-in (Codex on #577).
describe('defaultThemeForEdition — the pre-auth fallback', () => {
  it('keeps neon-playground for the legacy Edition', () => {
    expect(defaultThemeForEdition('gcb')).toBe('neon-playground');
  });

  it('gives Vacay its own Day 1 Theme, not the cruise default', () => {
    expect(defaultThemeForEdition('vacay')).toBe('the-birds');
  });

  it('gives Five Across its doors-open Theme, not the cruise default', () => {
    // Explicit-argument form on purpose: `setActiveEdition('fiveacross')`
    // resets to gcb until the Edition lands in `BRANDS` (#608 / PR #615), but
    // the scoping tables key on the Edition id alone, so this row is correct
    // and testable in either merge order (#617).
    expect(defaultThemeForEdition('fiveacross')).toBe('marquee');
  });

  it('falls back to the legacy default for an unknown Edition', () => {
    expect(defaultThemeForEdition('not-an-edition')).toBe('neon-playground');
  });

  it('follows the ACTIVE Edition with no argument', () => {
    try {
      setActiveEdition('vacay');
      expect(defaultThemeForEdition()).toBe('the-birds');
    } finally {
      setActiveEdition(DEFAULT_EDITION);
    }
  });

  it('every Edition default is PICKABLE on its own Edition', () => {
    // Otherwise the switcher would open with no chip active on a fresh device.
    for (const edition of ['gcb', 'vacay', 'fiveacross']) {
      const id = defaultThemeForEdition(edition);
      expect(themesForEdition(edition).map((t) => t.id)).toContain(id);
    }
  });
});
