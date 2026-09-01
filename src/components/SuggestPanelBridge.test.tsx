import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import SuggestPanelBridge from './SuggestPanelBridge';
import {
  requestOpenSuggestPanel,
  __resetOpenSuggestPanelForTests,
  useOpenSuggestPanelIntent,
} from '../hooks/useOpenSuggestPanel';

const eventScope = vi.hoisted(() => ({ eventId: 'event-a' }));

vi.mock('../firebase', () => ({
  get EVENT_ID() {
    return eventScope.eventId;
  },
}));

// #559, Codex P2 on PR #845 round 4: under `BrowserRouter`, `useNavigate()`
// returns a NEW function identity once the pathname changes — so the SAME
// `/more` push this component performs is exactly what would re-trigger a
// SECOND push if the effect depended on `navigate` itself. Mocking
// `useNavigate` to hand back a fresh mock per call reproduces that identity
// churn without a real router.
const navFns = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
let callIndex = 0;
vi.mock('react-router', () => ({
  useNavigate: () => navFns[Math.min(callIndex++, navFns.length - 1)],
}));

beforeEach(() => {
  eventScope.eventId = 'event-a';
  callIndex = 0;
  __resetOpenSuggestPanelForTests();
  navFns.forEach((f) => f.mockClear());
});

describe('SuggestPanelBridge (#559)', () => {
  it('navigates to /more exactly once per pending intent, even across a route-change-driven re-render with a new navigate identity', () => {
    const { rerender } = render(<SuggestPanelBridge />);

    act(() => {
      requestOpenSuggestPanel();
    });

    // Simulate the re-renders a real route change would cause once the
    // `/more` push lands — each one hands back a DIFFERENT mocked
    // `useNavigate()` instance, exactly like `BrowserRouter` does.
    rerender(<SuggestPanelBridge />);
    rerender(<SuggestPanelBridge />);

    const totalNavigateCalls = navFns.reduce((n, f) => n + f.mock.calls.length, 0);
    expect(totalNavigateCalls).toBe(1);
    expect(navFns.some((f) => f.mock.calls.some((args) => args[0] === '/more'))).toBe(true);
  });

  it('does nothing while no intent is pending', () => {
    render(<SuggestPanelBridge />);
    const totalNavigateCalls = navFns.reduce((n, f) => n + f.mock.calls.length, 0);
    expect(totalNavigateCalls).toBe(0);
  });

  it('returns neutral instead of exposing an Event A intent while Event B is active', () => {
    const view = renderHook(() => useOpenSuggestPanelIntent());

    act(() => requestOpenSuggestPanel());
    expect(view.result.current).toBe(true);

    eventScope.eventId = 'event-b';
    view.rerender();
    expect(view.result.current).toBe(false);

    act(() => requestOpenSuggestPanel());
    expect(view.result.current).toBe(true);

    eventScope.eventId = 'event-a';
    view.rerender();
    expect(view.result.current).toBe(false);
  });

  it('does not consume a queued Event A intent as navigation for Event B', () => {
    act(() => requestOpenSuggestPanel());
    eventScope.eventId = 'event-b';

    const view = render(<SuggestPanelBridge />);
    view.rerender(<SuggestPanelBridge />);

    expect(navFns.reduce((n, f) => n + f.mock.calls.length, 0)).toBe(0);

    eventScope.eventId = 'event-a';
    view.rerender(<SuggestPanelBridge />);

    expect(navFns.reduce((n, f) => n + f.mock.calls.length, 0)).toBe(1);
  });
});
