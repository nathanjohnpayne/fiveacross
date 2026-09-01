import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearUrlFragmentAndConfirm } from './urlFragment';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clearUrlFragmentAndConfirm', () => {
  it('preserves path and query and confirms the live URL is safe', () => {
    const location = { pathname: '/board', search: '?day=3', hash: '#credential=secret' };
    const replaceState = vi.fn(() => {
      location.hash = '';
    });
    vi.stubGlobal('window', {
      location,
      history: { state: { page: 1 }, replaceState },
    });

    expect(clearUrlFragmentAndConfirm((hash) => hash.includes('secret'))).toBe(true);
    expect(replaceState).toHaveBeenCalledWith({ page: 1 }, '', '/board?day=3');
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
