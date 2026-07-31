import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

// The 2026-07-24 blank-screen incident, pinned. A stale precached shell threw
// during render; with no boundary React unmounted the ENTIRE root — including
// the `UpdatePrompt` sibling that is the only caller of
// `updateServiceWorker(true)` — so the client could never move off the build
// that had just crashed. See src/components/ErrorBoundary.tsx.

const resetShell = vi.hoisted(() => vi.fn());
const resetAttempted = vi.hoisted(() => vi.fn());
const markResetAttempted = vi.hoisted(() => vi.fn());
const phCapture = vi.hoisted(() => vi.fn());

vi.mock('../shellRecovery', () => ({ resetShell, resetAttempted, markResetAttempted }));
vi.mock('../posthog', () => ({ phCapture }));

function Boom(): never {
  throw new Error('cells.every is not a function');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAttempted.mockReturnValue(true); // default: attempt already spent
  // React logs the caught error; silence it so the suite output stays readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
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
    );
  });
});
