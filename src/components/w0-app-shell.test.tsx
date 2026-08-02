import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router';
import { TABS, FALLBACK_PATH, visibleTabs, type TabId } from './tabs';
import TabBar from './TabBar';

// Covers specs/w0-app-shell.md. Runs under Vitest's default `environment:
// 'node'` (no jsdom/RTL yet — that lands with w0-test-harness) by rendering
// via `react-dom/server`'s DOM-free `renderToStaticMarkup`. `TabBar` and
// `./tabs` are deliberately free of Firebase-backed imports so they can
// render here; `Nav.tsx`/`App.tsx` wire in the real hooks but are otherwise
// thin callers of the same contract exercised below.
//
// The tab SET was revised in Phase 1.5 (#203, specs/d15-tab-contract.md) from
// Card/Feed/Ranks/Prompts/Admin to Card/Feed/Ranks/More; the app-shell
// structure this spec owns (frozen mount points, one route per tab, `*`
// fallback) is unchanged.

describe('tabs contract (frozen stable mount points)', () => {
  it('defines exactly the four Card/Feed/Ranks/More tabs, in order', () => {
    expect(TABS.map((t) => t.id)).toEqual(['card', 'feed', 'ranks', 'more']);
    expect(TABS.map((t) => t.label)).toEqual(['Card', 'Feed', 'Ranks', 'More']);
    expect(TABS.map((t) => t.path)).toEqual(['/', '/feed', '/leaderboard', '/more']);
  });

  it('has unique ids and unique paths (no accidental mount-point collisions)', () => {
    const ids = TABS.map((t) => t.id);
    const paths = TABS.map((t) => t.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('points the unmatched-route fallback at the Card tab\'s path', () => {
    const card = TABS.find((t) => t.id === 'card');
    expect(card?.path).toBe(FALLBACK_PATH);
  });
});

describe('visibleTabs', () => {
  it('returns the full Card/Feed/Ranks/More set (admin is an in-menu concern now)', () => {
    expect(visibleTabs().map((t) => t.id)).toEqual(['card', 'feed', 'ranks', 'more']);
  });
});

// react-router's NavLink/Navigate use useLayoutEffect internally, which
// logs React's stock "does nothing on the server" warning under
// renderToStaticMarkup. Harmless here: every assertion below reads markup
// produced by the synchronous render pass itself, not by the layout effect.
describe('TabBar (real render — no Firebase-backed hooks in this component)', () => {
  it('renders one link per tab in the frozen order', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TabBar />
      </MemoryRouter>,
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/feed"');
    expect(html).toContain('href="/leaderboard"');
    expect(html).toContain('href="/more"');
    expect(html.match(/<a /g)).toHaveLength(4);
  });
});

describe('route table (mirrors App.tsx\'s TABS -> <Route> mapping)', () => {
  function renderRoutesAt(path: string): string {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* Mirrors App.tsx exactly: the `more` route alone mounts with a
              splat so the admin console's sub-routes (/more/admin[/section],
              specs/admin-console-ia.md) nest inside the frozen mount point. */}
          {TABS.map((tab) => (
            <Route key={tab.id} path={tab.id === 'more' ? `${tab.path}/*` : tab.path} element={<div data-tab={tab.id} />} />
          ))}
          <Route path="*" element={<Navigate to={FALLBACK_PATH} replace />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  const expected: Record<TabId, string> = {
    card: '/',
    feed: '/feed',
    ranks: '/leaderboard',
    more: '/more',
  };

  for (const [id, path] of Object.entries(expected) as [TabId, string][]) {
    it(`mounts the "${id}" mount point at ${path}`, () => {
      const html = renderRoutesAt(path);
      expect(html).toContain(`data-tab="${id}"`);
    });
  }

  it('mounts the "more" mount point for the admin sub-routes (/more/admin[/section])', () => {
    for (const path of ['/more/admin', '/more/admin/settings']) {
      expect(renderRoutesAt(path)).toContain('data-tab="more"');
    }
  });

  it('mounts none of the known tabs for an unrecognized path (defers to the "/" redirect)', () => {
    const html = renderRoutesAt('/this-route-does-not-exist');
    for (const tab of TABS) {
      expect(html).not.toContain(`data-tab="${tab.id}"`);
    }
  });
});

// The one piece of the `.tabs` CSS that IS machine-checkable. The spec's
// layout claims (44px targets, safe-area padding) still need a real layout
// engine and stay a code-review/device check — but "the fixed bar carries no
// compositing trigger" is a grep, and it is the rule that has now failed twice
// in production (#422's backdrop-filter, then #451). Pin it so a future polish
// pass has to argue with a red test instead of silently reintroducing it.
describe('.tabs compositing contract (#422, #451)', () => {
  const indexCss = readFileSync('src/index.css', 'utf8');

  /**
   * Every innermost rule in the stylesheet, as a selector plus parsed
   * declarations. Reading real rules instead of regex-matching rule TEXT
   * (Codex P2 on #452): text matching missed `.app .tabs`, `.tabs.compact`,
   * and comma-separated selectors entirely, so a perfectly ordinary override
   * could reintroduce a promotion trigger with this suite still green.
   * Because the body pattern excludes braces, nested blocks (`@media`,
   * `@supports`) yield their inner rules with their own selectors, which is
   * exactly what we want. Values containing a literal `;` (a data: URL) would
   * split wrongly; no tab-bar rule has one, and one appearing would be its own
   * red flag.
   */
  const cssRules = (css: string) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1].trim(),
      decls: m[2]
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d.includes(':'))
        .map((d) => ({
          prop: d.slice(0, d.indexOf(':')).trim().toLowerCase(),
          value: d.slice(d.indexOf(':') + 1).trim(),
        })),
    }));

  /**
   * Does this selector apply TO the bar, rather than merely mention it? Only
   * the subject (the last compound selector) counts: `.app .tabs` styles the
   * bar, while `.tabs > .tab` styles a tab and `body:has(.tabs)
   * .install-prompt` styles a toast.
   *
   * Functional pseudo-classes split two ways (Codex P2 on #452), and the
   * distinction is the whole point: `:is(.tabs)` and `:where(.tabs)` match the
   * element ITSELF against their argument, so `:where(.tabs) { transform: ... }`
   * really does style the bar and has to count — their arguments are unwrapped.
   * `:has(.tabs)` and `:not(.tabs)` relate or invert instead: they match some
   * OTHER element, so a `.tabs` inside them must not make the subject the bar —
   * their arguments are dropped. Stripping every parenthesised argument (the
   * first cut) was safe against false positives but left `:where(.tabs)` as a
   * silent way back in.
   */
  const resolvePseudos = (part: string) => {
    let out = part;
    for (let i = 0; i < 5; i++) {
      const next = out
        .replace(/:(?:not|has)\([^()]*\)/g, '')
        .replace(/:(?:is|where)\(([^()]*)\)/g, ' $1 ');
      if (next === out) break;
      out = next;
    }
    return out;
  };

  // Resolve BEFORE splitting on commas: unwrapping `:is(.a, .tabs)` yields a
  // comma of its own, and because an `:is()` list is a disjunction, letting the
  // resulting alternatives split into separate selectors gives the right answer
  // — `.foo:is(.a, .tabs)` becomes `.foo .a` / `.tabs`, and the second branch
  // correctly reports that this rule can style the bar.
  const targetsTabBar = (selector: string) =>
    resolvePseudos(selector)
      .split(',')
      .some((part) => {
        const compounds = part.trim().split(/[\s>+~]+/).filter(Boolean);
        const subject = compounds[compounds.length - 1] ?? '';
        return /(^|[^\w-])\.tabs(?![\w-])/.test(subject);
      });

  const tabBarRules = cssRules(indexCss).filter((rule) => targetsTabBar(rule.selector));
  const baseRules = tabBarRules.filter((rule) => rule.selector === '.tabs');
  const declsOf = (rule: (typeof tabBarRules)[number]) => rule.decls;
  // Vendor prefixes are stripped before comparison, and comparison is on the
  // PROPERTY NAME, so `-webkit-backdrop-filter` is caught while `text-transform`
  // is not confused for `transform` — no boundary regex needed.
  const unprefixed = (prop: string) => prop.replace(/^-(?:webkit|moz|ms|o)-/, '');

  it('finds the tab bar rules at all (guards against the scanner silently matching nothing)', () => {
    expect(tabBarRules.length).toBeGreaterThan(0);
    expect(baseRules).toHaveLength(1);
  });

  it('keeps the bar pinned to the viewport bottom', () => {
    const decls = declsOf(baseRules[0]);
    expect(decls.find((d) => d.prop === 'position')?.value).toBe('fixed');
    expect(decls.find((d) => d.prop === 'bottom')?.value).toBe('0');
  });

  // On iOS WebKit a `position: fixed` element promoted to its own compositing
  // layer is not reliably kept pinned to the visual viewport during scroll: it
  // detaches and freezes mid-screen, most visibly in a standalone home-screen
  // PWA on a scrolling route. Every property below is a promotion trigger.
  for (const trigger of ['backdrop-filter', 'filter', 'transform', 'will-change', 'perspective']) {
    it(`declares no \`${trigger}\` on the tab bar, vendor-prefixed spellings included`, () => {
      for (const rule of tabBarRules) {
        expect(
          declsOf(rule)
            .map((d) => unprefixed(d.prop))
            .filter((prop) => prop === trigger),
        ).toEqual([]);
      }
    });
  }

  it('paints a fully opaque background (no blending work on the fixed layer)', () => {
    // An allowlist, not a `transparent`-token denylist (Codex P2 on #452): a
    // denylist passes `rgb(0 0 0 / 80%)` and `#000000cc` — both translucent,
    // neither containing the word — and fails an innocent `border-color:
    // transparent`. Pinning the known-opaque token means any future fill has to
    // come here and argue for itself.
    const backgrounds = tabBarRules.flatMap((rule) =>
      declsOf(rule)
        .filter((d) => d.prop === 'background' || d.prop === 'background-color')
        .map((d) => d.value),
    );
    expect(backgrounds).toEqual(['var(--bg)']);
  });
});
