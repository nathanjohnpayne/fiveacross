import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import EventNotFound from './EventNotFound';

// specs/event-resolution.md, `auth-unconfigured` state. The screen that filed
// #585: a Vercel per-branch preview host rendered "This address is not open
// yet" and read as a regression, because the copy named the state without
// naming the supported path out of it.
describe('EventNotFound — auth-unconfigured on a preview host (#585)', () => {
  it('points a developer at the stable preview alias on a *.vercel.app host', () => {
    render(
      <EventNotFound
        hostname="gaycruisebingo-iy4xn21x8-nathanjohnpaynes-projects.vercel.app"
        reason="auth-unconfigured"
      />,
    );
    const hint = screen.getByText(/Developer note/i);
    // The alias itself, not just a pointer at the docs: this screen is usually
    // read off a phone screenshot (Codex P3 on #585).
    expect(hint.textContent).toContain(
      'gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app',
    );
    expect(hint.textContent).toMatch(/docs\/app\/preview-deploys\.md/);
    // The player-facing copy is unchanged; the hint is additive.
    expect(screen.getByRole('heading').textContent).toBe('This address is not open yet');
  });

  it('keeps the player copy free of developer instructions on a real address', () => {
    render(<EventNotFound hostname="bodega-bay.fiveacross.app" reason="auth-unconfigured" />);
    expect(screen.queryByText(/Developer note/i)).toBeNull();
    expect(screen.getByRole('heading').textContent).toBe('This address is not open yet');
  });

  it('does not show the hint for the other not-found reasons on a preview host', () => {
    // Only the auth gate has a "use the stable alias" answer. A missing or
    // finished Event on a preview host is a different problem entirely.
    for (const reason of ['missing', 'inactive', 'unreachable'] as const) {
      const { unmount } = render(
        <EventNotFound hostname="gaycruisebingo-abc123-nathanjohnpaynes-projects.vercel.app" reason={reason} />,
      );
      expect(screen.queryByText(/Developer note/i)).toBeNull();
      unmount();
    }
  });
});
