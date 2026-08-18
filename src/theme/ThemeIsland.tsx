import type { HTMLAttributes } from 'react';
import type { ThemeId } from '../types';

/**
 * A CSS-scoped Theme island (#795, specs/event-setup-wizard.md § "Live
 * preview strip"): retints ONLY its own subtree to `theme`, never
 * `<html>` / `ThemeContext`.
 *
 * This formalizes a pattern the app already relies on in one place —
 * `Board.tsx`'s `.board-area[data-theme]` "retint scope"
 * (specs/theme-on-color-contrast.md Scope C, src/index.css ~L650): every
 * `themes.css` token block is a plain `[data-theme='…']` ATTRIBUTE selector,
 * never `html[data-theme]` or `:root[data-theme]` specifically, so setting
 * `data-theme` on any element — not only the document root — scopes the CSS
 * custom-property cascade to that element's own subtree. `<html
 * data-theme>` is just the one instance of this that happens to sit at the
 * document root; nesting the same attribute deeper down works by the exact
 * same cascade rule, with no additional CSS required. That is why this
 * component ships with zero new rules in `src/index.css` or `themes.css`.
 *
 * Deliberately does NOT import or touch `ThemeContext`
 * (`src/theme/ThemeContext.tsx`) or `document.documentElement.dataset.theme`
 * — the app-global theme is a completely separate scope from any island. A
 * page may nest any number of islands, each wearing its own `ThemeId`, while
 * `<html data-theme>` keeps whatever `ThemeProvider` (or nothing, pre-auth)
 * has set. `ThemeIsland.test.tsx` pins this as a regression: mounting an
 * island under a `ThemeProvider` wearing a DIFFERENT theme must never move
 * `document.documentElement`'s own `data-theme`.
 */
export default function ThemeIsland({
  theme,
  children,
  ...rest
}: {
  theme: ThemeId;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-theme={theme} {...rest}>
      {children}
    </div>
  );
}
