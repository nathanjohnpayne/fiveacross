import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';

// The 2026-07-24 blank-screen incident, pinned. A stale precached shell threw
// during render; with no boundary React unmounted the ENTIRE root — including
// the `UpdatePrompt` sibling that is the only caller of
// `updateServiceWorker(true)` — so the client could never move off the build
// that had just crashed. See src/components/ErrorBoundary.tsx.

const resetShell = vi.hoisted(() => vi.fn());
const resetAttempted = vi.hoisted(() => vi.fn());
const markResetAttempted = vi.hoisted(() => vi.fn());
const definitelyOffline = vi.hoisted(() => vi.fn());
const phCapture = vi.hoisted(() => vi.fn());

vi.mock('../shellRecovery', () => ({ resetShell, resetAttempted, markResetAttempted, definitelyOffline }));
vi.mock('../posthog', () => ({ phCapture }));

function Boom(): never {
  throw new Error('cells.every is not a function');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAttempted.mockReturnValue(true); // default: attempt already spent
  markResetAttempted.mockReturnValue(true); // default: the store is durable
  definitelyOffline.mockReturnValue(false); // default: online
  // React logs the caught error; silence it so the suite output stays readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // The resolved Edition is module state, so a test that installs one would
  // otherwise brand every test after it.
  setActiveEdition(DEFAULT_EDITION);
});

describe('ErrorBoundary', () => {
  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the board</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the board')).toBeInTheDocument();
    expect(resetShell).not.toHaveBeenCalled();
  });

  it('KEEPS SIBLINGS MOUNTED when the wrapped tree crashes', () => {
    // The core regression. Without the boundary this sibling — standing in for
    // UpdatePrompt — is unmounted with the rest of the root, and the client
    // loses its only in-app route off a broken build.
    render(
      <>
        <p>update prompt</p>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByText('update prompt')).toBeInTheDocument();
  });

  it('shows a recovery panel instead of a blank screen', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset & reload/i })).toBeInTheDocument();
  });

  it('reassures the player their marks are safe', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/marks are safe/i)).toBeInTheDocument();
  });

  it('resets the shell when the player asks', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /reset & reload/i }));
    expect(resetShell).toHaveBeenCalledOnce();
  });

  it('auto-recovers ONCE when the tab still has its attempt — the stale-shell self-heal', () => {
    resetAttempted.mockReturnValue(false);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(markResetAttempted).toHaveBeenCalledOnce();
    expect(resetShell).toHaveBeenCalledOnce();
  });

  it('does NOT auto-recover while offline — the panel beats the browser error page', () => {
    // Codex P1 on #513. Offline, the teardown would delete the only copy of the
    // shell this device has. Skipping it keeps THIS panel on screen, and leaves
    // the attempt unspent for when connectivity returns.
    resetAttempted.mockReturnValue(false);
    definitelyOffline.mockReturnValue(true);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(resetShell).not.toHaveBeenCalled();
    expect(markResetAttempted).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does NOT auto-recover when the attempt cannot be durably recorded', () => {
    // Codex P1 on #513: a readable-but-unwritable store would otherwise re-arm
    // the reset on every load — an unbounded destructive reload loop.
    resetAttempted.mockReturnValue(false);
    markResetAttempted.mockReturnValue(false);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(resetShell).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does NOT auto-recover again once the attempt is spent — no reload loop', () => {
    // A crash that survives the reset is an app bug, not a stale shell: show
    // the panel and stop rather than reloading forever.
    resetAttempted.mockReturnValue(true);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(resetShell).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('reports the crash with the build stamp that produced it', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(phCapture).toHaveBeenCalledWith(
      'app_crash',
      expect.objectContaining({ message: 'cells.every is not a function', build_stamp: expect.any(String) }),
      expect.anything(),
    );
  });

  it('beacons the crash report so the auto-reload cannot drop it', () => {
    // CodeRabbit on #513. The default batched transport would lose this event
    // when auto-recovery reloads a moment later — self-defeating, since
    // `app_crash` is what makes the next stale-shell wave visible at all.
    resetAttempted.mockReturnValue(false);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(phCapture).toHaveBeenCalledWith(
      'app_crash',
      expect.any(Object),
      { transport: 'sendBeacon', send_instantly: true },
    );
  });
});

// The #543/#576 defect on its third and last surface. The crash panel reuses
// the `.signin` shell the gate and `DealError` reuse, but kept its own copy of
// the `gcb` wordmark and offline note — so the screen whose whole job is to
// reassure a player greeted a Bodega Bay guest with another product's name and
// sent them after printed cards for a cruise that is not happening. The sibling
// proof for the other two surfaces is src/components/signin-edition-brand.test.tsx.
//
// `../editions` is deliberately NOT mocked: the point is that the component
// reads the real brand table rather than holding strings, which a stubbed
// module would hide.
describe('ErrorBoundary — the crash panel wears the resolved Edition', () => {
  it('shows the cruise brand on the legacy Edition', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('GAY CRUISE BINGO');
    expect(screen.getByText(/lost signal at sea/i)).toBeInTheDocument();
  });

  it('shows the Vacay brand once the resolver installs that Edition', () => {
    setActiveEdition('vacay');
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('VACAY BINGO');
    expect(screen.getByText(/marks sync when you reconnect/i)).toBeInTheDocument();
    expect(screen.queryByText(/at sea/i)).toBeNull();
  });

  it('falls back to the legacy brand on an unknown Edition rather than a blank wordmark', () => {
    // `setActiveEdition` already coerces the unknown value, but the panel is
    // the surface that would render the hole if it ever stopped doing so.
    setActiveEdition('not-a-real-edition');
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('GAY CRUISE BINGO');
  });
});
