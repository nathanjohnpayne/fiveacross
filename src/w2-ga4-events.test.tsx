import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track, GA4_EVENTS } from './analytics';
import ConsentNotice from './components/ConsentNotice';

// Covers specs/w2-ga4-events.md: the 12-event GA4 PRD catalog (plus the
// operational `login_failed` event added in #163) + `track()` entry point
// (src/analytics.ts) and the 18+ analytics consent notice
// (src/components/ConsentNotice.tsx).

// Hoisted so these mock factories (which Vitest hoists above the imports
// above) can close over them. `mockAnalyticsInstance.current` doubles as the
// "analytics available" toggle: `firebase.ts` exports `analytics` as
// `Analytics | null`, and `track()` re-reads the live binding on every call.
const { logEvent, mockAnalyticsInstance } = vi.hoisted(() => ({
  logEvent: vi.fn(),
  mockAnalyticsInstance: { current: {} as object | null },
}));

vi.mock('firebase/analytics', () => ({ logEvent }));
vi.mock('./firebase', () => ({
  get analytics() {
    return mockAnalyticsInstance.current;
  },
  analyticsReady: Promise.resolve({}),
}));

describe('GA4_EVENTS catalog', () => {
  it('enumerates the 12 PRD events plus the operational login_failed (#163), text_size_change (#215), reshuffle_card (#378), heart_post (specs/feed-hearts.md), most_loved_photo_frozen (specs/most-loved-photo.md), mark_rejected (#387), unmark_square + echo_mark (#721), and the Community Prompt entry-point trio prompt_suggestion_submitted/prompt_suggestion_approved/community_prompt_dealt (#559)', () => {
    expect(GA4_EVENTS).toEqual([
      'login',
      'login_failed',
      'join_event',
      'add_item',
      'report_item',
      'mark_square',
      'attach_proof',
      'demand_proof',
      'bingo',
      'blackout',
      'theme_change',
      'text_size_change',
      'share_click',
      'install_pwa',
      'reshuffle_card',
      'heart_post',
      'most_loved_photo_frozen',
      'mark_rejected',
      'unmark_square',
      'echo_mark',
      'prompt_suggestion_submitted',
      'prompt_suggestion_approved',
      'community_prompt_dealt',
    ]);
  });
});

describe('track()', () => {
  beforeEach(() => {
    logEvent.mockClear();
    mockAnalyticsInstance.current = {};
  });

  it('fires demand_proof through logEvent with its params (10 -> 12)', () => {
    track('demand_proof', { itemId: 'p1', cellIndex: 3 });
    expect(logEvent).toHaveBeenCalledWith(mockAnalyticsInstance.current, 'demand_proof', {
      itemId: 'p1',
      cellIndex: 3,
      // Always present on the GA4 sink (#613, Phase 4b P1): an event without
      // an explicit page_location makes GA4 derive one from the full
      // query-bearing URL, breaking the path-only policy.
      page_location: `${window.location.origin}${window.location.pathname}`,
    });
  });

  it('fires install_pwa through logEvent (10 -> 12)', () => {
    track('install_pwa');
    expect(logEvent).toHaveBeenCalledWith(mockAnalyticsInstance.current, 'install_pwa', {
      page_location: `${window.location.origin}${window.location.pathname}`,
    });
  });

  it('never throws and never calls logEvent when analytics is unavailable (null)', () => {
    mockAnalyticsInstance.current = null;
    expect(() => track('login', { method: 'google' })).not.toThrow();
    expect(logEvent).not.toHaveBeenCalled();
  });
});

// A minimal in-memory `localStorage` stand-in, installed via `vi.stubGlobal`:
// recent Node runtimes ship a built-in `localStorage` global that is present
// but non-functional without a `--localstorage-file` flag, and it can shadow
// jsdom's working one. Bringing our own keeps this suite deterministic
// regardless of which `localStorage` the runtime would otherwise resolve.
function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('ConsentNotice', () => {
  // Versioned key (#195): bumped to v2 so the updated session-replay disclosure
  // re-shows to visitors who dismissed the old GA4-only notice.
  const CONSENT_KEY = 'gcb.consent.analytics.v2.dismissedAt';
  let storage: Storage;

  beforeEach(() => {
    storage = createStorageStub();
    vi.stubGlobal('localStorage', storage);
  });

  it('renders the 18+ analytics disclosure on first visit', () => {
    render(<ConsentNotice />);
    const notice = screen.getByRole('note');
    expect(notice).toHaveTextContent(/18\+/);
    expect(notice).toHaveTextContent(/analytics/i);
  });

  it('dismisses on click and persists the dismissal to localStorage', async () => {
    const user = userEvent.setup();
    render(<ConsentNotice />);

    await user.click(screen.getByRole('button', { name: /got it/i }));

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(storage.getItem(CONSENT_KEY)).not.toBeNull();
  });

  it('does not render on a later mount once dismissed', () => {
    storage.setItem(CONSENT_KEY, String(Date.now()));
    render(<ConsentNotice />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
