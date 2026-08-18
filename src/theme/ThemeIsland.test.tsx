import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, screen } from '@testing-library/react';
import ThemeIsland from './ThemeIsland';
import { ThemeProvider } from './ThemeContext';
import { parseThemeBlocks } from './contrast';

// Regression coverage for #795 (specs/event-setup-wizard.md § "Live preview
// strip"): the scoped Theme island is new, reusable src/theme/ work, and the
// ticket's own acceptance criterion is explicit — "existing theme contrast
// tests and the app-global theming behavior are unaffected" while a nested
// island renders a DIFFERENT theme than the surrounding app. This suite pins
// that as a structural, DOM-level regression rather than relying on jsdom's
// (unreliable) CSS custom-property cascade — the same "parse the source of
// truth, don't depend on the runtime CSS engine" convention every other
// suite in this directory already uses (w1-themes.test.tsx,
// theme-on-color-contrast.test.tsx, d15-two-themes.test.ts).

const themeDir = dirname(fileURLToPath(import.meta.url));
const themeBlocks = parseThemeBlocks(readFileSync(join(themeDir, 'themes.css'), 'utf-8'));

describe('ThemeIsland', () => {
  it('sets data-theme on its OWN node, not on document.documentElement', () => {
    delete document.documentElement.dataset.theme;
    render(<ThemeIsland theme="marquee" data-testid="island" />);
    const island = screen.getByTestId('island');
    expect(island.dataset.theme).toBe('marquee');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('never touches the app-global theme set by ThemeProvider, even when the island wears a DIFFERENT theme', () => {
    render(
      <ThemeProvider defaultTheme="marquee">
        <ThemeIsland theme="the-birds" data-testid="island" />
      </ThemeProvider>,
    );
    // ThemeProvider's own effect stamps <html data-theme> from ITS resolved
    // theme (marquee here — no autoThemeId, no saved/player pick) —
    // completely independent of what the nested island renders.
    expect(document.documentElement.dataset.theme).toBe('marquee');
    expect(screen.getByTestId('island').dataset.theme).toBe('the-birds');
  });

  it('lets two sibling islands wear two different themes at once — two token scopes in one document', () => {
    render(
      <div>
        <ThemeIsland theme="marquee" data-testid="a" />
        <ThemeIsland theme="confetti-hour" data-testid="b" />
      </div>,
    );
    expect(screen.getByTestId('a').dataset.theme).toBe('marquee');
    expect(screen.getByTestId('b').dataset.theme).toBe('confetti-hour');
    expect(screen.getByTestId('a').dataset.theme).not.toBe(screen.getByTestId('b').dataset.theme);
  });

  it("both scopes' themes resolve to their OWN, independently-defined token sets in themes.css", () => {
    // Structural corroboration that the two data-theme values used above are
    // not just different strings but genuinely different token sets — the
    // premise the whole scoped-cascade mechanism depends on.
    const marquee = themeBlocks['marquee'];
    const confettiHour = themeBlocks['confetti-hour'];
    expect(marquee).toBeDefined();
    expect(confettiHour).toBeDefined();
    expect(marquee?.bg).not.toBe(confettiHour?.bg);
    expect(marquee?.primary).not.toBe(confettiHour?.primary);
  });

  it('forwards children and arbitrary DOM attributes without swallowing them', () => {
    render(
      <ThemeIsland theme="afterglow" className="board-area preview" aria-label="Sample card">
        <span>hello</span>
      </ThemeIsland>,
    );
    const island = screen.getByLabelText('Sample card');
    expect(island.className).toBe('board-area preview');
    expect(island.textContent).toBe('hello');
  });
});
