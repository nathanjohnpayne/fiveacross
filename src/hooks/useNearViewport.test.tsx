import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNearViewport } from './useNearViewport';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('proof media viewport gate', () => {
  it('cleans up a card removed before it approaches the viewport', () => {
    const node = document.createElement('div');
    const observe = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(_cb: IntersectionObserverCallback, options: IntersectionObserverInit) {
        expect(options.rootMargin).toBe('400px 0px');
      }
      observe = observe; disconnect = disconnect;
    });
    const { result, unmount } = renderHook(() => {
      const gate = useNearViewport(); gate.ref.current = node; return gate;
    });
    expect(result.current.nearby).toBe(false);
    expect(observe).toHaveBeenCalledWith(node);
    unmount(); expect(disconnect).toHaveBeenCalledOnce();
  });

  it('loads only a nearby card and cleans up on unmount', () => {
    const node = document.createElement('div');
    let callback!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: IntersectionObserverCallback) { callback = cb; }
      observe() {} disconnect = disconnect;
    });
    const { result, unmount } = renderHook(() => {
      const gate = useNearViewport(); gate.ref.current = node; return gate;
    });
    const notify = (isIntersecting: boolean) => act(() => callback([
      { target: node, isIntersecting } as unknown as IntersectionObserverEntry,
    ], {} as IntersectionObserver));
    notify(false); expect(result.current.nearby).toBe(false);
    notify(true); expect(result.current.nearby).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    notify(false); expect(result.current.nearby).toBe(false);
    notify(true); expect(result.current.nearby).toBe(true);
    unmount(); expect(disconnect).toHaveBeenCalledOnce();
  });

  it('uses scroll proximity when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const node = document.createElement('div');
    let top = 10_000;
    vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 200 }) as DOMRect);
    const { result, unmount } = renderHook(() => {
      const gate = useNearViewport(); gate.ref.current = node; return gate;
    });
    expect(result.current.nearby).toBe(false);
    top = 200;
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(result.current.nearby).toBe(true);
    top = 10_000;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(result.current.nearby).toBe(false);
    unmount();
  });
});
