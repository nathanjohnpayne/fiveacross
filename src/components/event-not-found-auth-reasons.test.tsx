// Covers specs/auth-handoff-client.md § Failure states — the two mount-gate
// screens #549 adds to `EventNotFound`.
//
// They exist as separate reasons rather than folded into `auth-unconfigured`
// because a different person fixes each: `auth-unconfigured` means nobody
// finished provisioning this address, while these two mean this build was told
// to sign in a way that cannot work here. The tests hold that distinction to the
// only thing that carries it — the words on the screen.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import EventNotFound from './EventNotFound';

const HOST = 'summer-camp.fiveacross.app';

describe('EventNotFound — the #549 sign-in route failures', () => {
  it('keeps the player-facing headline shared with auth-unconfigured', () => {
    // A player can act on none of these states, so they read the same. The
    // difference is the operator sentence below, not the headline.
    for (const reason of [
      'auth-unconfigured',
      'auth-same-origin-unavailable',
      'auth-mode-invalid',
      'auth-handoff-misconfigured',
    ] as const) {
      const { unmount } = render(<EventNotFound hostname={HOST} reason={reason} />);
      expect(screen.getByRole('heading')).toHaveTextContent('This address is not open yet');
      unmount();
    }
  });

  it('names the escape hatch as the cause when same_origin cannot work here', () => {
    render(<EventNotFound hostname={HOST} reason="auth-same-origin-unavailable" />);
    expect(screen.getByText(/set to a mode this address cannot use/i)).toBeInTheDocument();
    // The developer note is what makes a screenshot actionable — it must name
    // the actual setting, not gesture at "configuration".
    expect(screen.getByText(/VITE_AUTH_MODE=same_origin/)).toBeInTheDocument();
    expect(screen.getByText(/FIRST_PARTY_AUTH_HOSTS/)).toBeInTheDocument();
  });

  it('names the missing central origin when the handoff is misconfigured', () => {
    render(<EventNotFound hostname={HOST} reason="auth-handoff-misconfigured" />);
    expect(screen.getByText(/has not been finished for this address/i)).toBeInTheDocument();
    expect(screen.getByText(/VITE_AUTH_HANDOFF_ORIGIN/)).toBeInTheDocument();
  });

  it('names VITE_AUTH_MODE when the configured mode is invalid', () => {
    render(<EventNotFound hostname={HOST} reason="auth-mode-invalid" />);
    expect(screen.getByText(/sign-in mode is not recognised/i)).toBeInTheDocument();
    expect(screen.getByText(/VITE_AUTH_MODE/)).toBeInTheDocument();
    expect(screen.queryByText(/VITE_AUTH_HANDOFF_ORIGIN/)).toBeNull();
  });

  it('does not confuse the two, in either direction', () => {
    const { unmount } = render(<EventNotFound hostname={HOST} reason="auth-same-origin-unavailable" />);
    expect(screen.queryByText(/VITE_AUTH_HANDOFF_ORIGIN/)).toBeNull();
    unmount();
    render(<EventNotFound hostname={HOST} reason="auth-handoff-misconfigured" />);
    expect(screen.queryByText(/VITE_AUTH_MODE=same_origin/)).toBeNull();
  });

  it('still renders the hostname, which is what a screenshot is identified by', () => {
    render(<EventNotFound hostname={HOST} reason="auth-handoff-misconfigured" />);
    expect(screen.getByText(HOST)).toBeInTheDocument();
  });

  // The pre-existing preview hint belongs to `auth-unconfigured` alone; the new
  // reasons must not have stolen it.
  it('leaves the vercel preview hint on auth-unconfigured', () => {
    render(<EventNotFound hostname="gcb-abc123-x.vercel.app" reason="auth-unconfigured" />);
    expect(screen.getByText(/per-deployment preview hosts/i)).toBeInTheDocument();
  });
});
