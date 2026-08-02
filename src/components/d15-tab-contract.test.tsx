import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { TABS, visibleTabs } from './tabs';
import TabBar from './TabBar';

// Covers specs/d15-tab-contract.md — the Phase 1.5 (#203) tab-set revision to
// Card/Feed/Ranks/More and the More tab's avatar-or-ellipsis icon, rendered
// DOM-free via `renderToStaticMarkup` (TabBar/tabs are Firebase-hook free). The
// route table's /items,/admin retirement lives in the sibling
// w0-app-shell.test.tsx, which owns App.tsx's TABS -> <Route> mapping.

describe('d15 frozen tab contract (Card · Feed · Ranks · More)', () => {
  it('has exactly four entries — card/feed/ranks/more, in that order, no Prompts/Admin', () => {
    expect(TABS.map((t) => t.id)).toEqual(['card', 'feed', 'ranks', 'more']);
    expect(TABS.map((t) => t.label)).toEqual(['Card', 'Feed', 'Ranks', 'More']);
    expect(TABS.map((t) => t.path)).toEqual(['/', '/feed', '/leaderboard', '/more']);
  });

  it('drops the tab-level admin gate — no entry carries an adminOnly flag', () => {
    expect(TABS.some((t) => 'adminOnly' in t)).toBe(false);
    expect(visibleTabs().map((t) => t.id)).toEqual(['card', 'feed', 'ranks', 'more']);
  });
});

describe('d15 More tab icon = player avatar, ellipsis fallback signed-out', () => {
  const render = (morePhotoURL: string | null) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <TabBar morePhotoURL={morePhotoURL} />
      </MemoryRouter>,
    );

  it('renders More as an avatar <img> with a photo URL, a Lucide ellipsis glyph when signed out', () => {
    const withPhoto = render('https://example.com/photo.jpg');
    expect(withPhoto).toContain('<img');
    expect(withPhoto).toContain('src="https://example.com/photo.jpg"');
    const signedOut = render(null);
    expect(signedOut).not.toContain('<img');
    // specs/d15-icons-lucide.md: the fallback is now the lucide-react
    // `Ellipsis` icon (className `tab-ellipsis`), not a literal '⋯' character.
    expect(signedOut).toContain('tab-ellipsis');
    expect(signedOut).not.toContain('⋯');
  });

  it('captions the avatar/ellipsis with a visible "More" label, no duplicate announcement (#297)', () => {
    // The visible label is the accessible name, same as Card/Feed/Ranks — so
    // the avatar's alt is empty and the NavLink carries no aria-label that
    // would double-announce "More" to screen readers.
    for (const markup of [render('https://example.com/photo.jpg'), render(null)]) {
      expect(markup).toContain('>More</a>');
      expect(markup).not.toContain('aria-label="More"');
    }
    expect(render('https://example.com/photo.jpg')).toContain('alt=""');
  });
});
