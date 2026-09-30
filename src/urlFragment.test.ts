import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearUrlFragmentAndConfirm } from './urlFragment';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clearUrlFragmentAndConfirm', () => {
  it('preserves path and query and confirms the live URL is safe', () => {
    const location = {
      origin: 'https://summer-camp.fiveacross.app',
      pathname: '/board',
      search: '?day=3',
      hash: '#credential=secret',
    };
    const replaceState = vi.fn(() => {
      location.hash = '';
    });
    vi.stubGlobal('window', {
      location,
      history: { state: { page: 1 }, replaceState },
    });

    expect(clearUrlFragmentAndConfirm((hash) => hash.includes('secret'))).toBe(true);
    expect(replaceState).toHaveBeenCalledWith({ page: 1 }, '', 'https://summer-camp.fiveacross.app/board?day=3');
  });

  it('passes an ABSOLUTE same-origin URL, so a `//` pathname is never read as another host', () => {
    // A pathname like `//evil.example` (reachable through dot-segment
    // normalisation) handed to replaceState as a bare path would be resolved as
    // protocol-relative — a different origin, which the History API refuses.
    const location = {
      origin: 'https://summer-camp.fiveacross.app',
      pathname: '//evil.example/x',
      search: '',
      hash: '#credential=secret',
    };
    const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
      if (!url.startsWith(location.origin)) throw new Error('SecurityError');
      location.hash = '';
    });
    vi.stubGlobal('window', { location, history: { state: null, replaceState } });

    expect(clearUrlFragmentAndConfirm((hash) => hash.includes('secret'))).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://summer-camp.fiveacross.app//evil.example/x');
  });

  it('fails closed when replaceState silently leaves a credential behind', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '', hash: '#credential=secret' },
      history: { state: null, replaceState: vi.fn() },
    });

    expect(clearUrlFragmentAndConfirm((hash) => hash.includes('secret'))).toBe(false);
  });

  it('fails closed when the history API throws', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '', hash: '#credential=secret' },
      history: {
        state: null,
        replaceState: () => {
          throw new Error('denied');
        },
      },
    });

    expect(clearUrlFragmentAndConfirm((hash) => hash.includes('secret'))).toBe(false);
  });
});
