// Covers specs/auth-handoff-client.md § The three legs and § Failure states.
//
// The boundary primitives and the start leg (#549) — the half of the flow that
// touches no Firebase. The invariant worth the most here is ADR 0010's hard
// line: no token, and not even the verifier, ever appears in a URL.
//
// The two callable legs are covered next door in handoffExchange.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HANDOFF_AUTH_PATH,
  HANDOFF_FRAGMENT_KEY,
  buildAuthOriginUrl,
  clearHandoffFragment,
  consumeHandoffFailure,
  parseHandoffRequest,
  readHandoffCode,
  recordHandoffFailure,
  startAuthHandoff,
} from './handoffClient';
import { HANDOFF_TRANSACTION_KEY, readHandoffTransaction } from './handoffTransaction';

const CODE = 'C'.repeat(43);
const ORIGIN = 'https://summer-camp.fiveacross.app';
const CENTRAL = 'https://auth.fiveacross.app';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('localStorage', memoryStorage());
  consumeHandoffFailure();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readHandoffCode', () => {
  it('reads a well-formed code out of the fragment', () => {
    expect(readHandoffCode(`#${HANDOFF_FRAGMENT_KEY}=${CODE}`)).toBe(CODE);
  });

  it('reads a code sitting alongside other fragment parameters', () => {
    expect(readHandoffCode(`#a=1&${HANDOFF_FRAGMENT_KEY}=${CODE}&b=2`)).toBe(CODE);
  });

  it.each([
    ['an empty fragment', ''],
    ['a bare hash', '#'],
    ['an unrelated fragment', '#section-3'],
    ['a different key', `#other=${CODE}`],
    ['a short code', `#${HANDOFF_FRAGMENT_KEY}=abc`],
    ['a code with an illegal character', `#${HANDOFF_FRAGMENT_KEY}=${'C'.repeat(42)}+`],
    ['an empty value', `#${HANDOFF_FRAGMENT_KEY}=`],
    // No leading `#` is not a fragment at all, whatever it otherwise looks like.
    ['a bare parameter with no hash', `${HANDOFF_FRAGMENT_KEY}=${CODE}`],
  ])('reads %s as no code', (_label, hash) => {
    expect(readHandoffCode(hash)).toBeNull();
  });

  // The code rides in a FRAGMENT, never a query string: a fragment is not sent
  // to any server, so it is absent from access logs, from any proxy in front of
  // the origin, and from the Referer of every subsequent request.
  it('ignores a code smuggled into the query string', () => {
    expect(readHandoffCode(`?${HANDOFF_FRAGMENT_KEY}=${CODE}`)).toBeNull();
  });
});

describe('clearHandoffFragment', () => {
  it('drops the fragment while preserving path and query, without navigating', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname: '/board', search: '?day=3', hash: `#${HANDOFF_FRAGMENT_KEY}=${CODE}` },
      history: { state: { a: 1 }, replaceState },
    });
    clearHandoffFragment();
    expect(replaceState).toHaveBeenCalledWith({ a: 1 }, '', '/board?day=3');
  });

  it('never throws when the history API refuses', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '', hash: '' },
      history: {
        state: null,
        replaceState: () => {
          throw new Error('denied');
        },
      },
    });
    expect(() => clearHandoffFragment()).not.toThrow();
  });
});

describe('buildAuthOriginUrl', () => {
  it('builds the central-origin URL with the transaction on it', () => {
    const url = new URL(
      buildAuthOriginUrl({
        authOrigin: CENTRAL,
        targetOrigin: ORIGIN,
        transactionId: 'T'.repeat(43),
        returnPath: '/board?day=3',
      }),
    );
    expect(url.origin).toBe(CENTRAL);
    expect(url.pathname).toBe(HANDOFF_AUTH_PATH);
    expect(url.searchParams.get('target')).toBe(ORIGIN);
    expect(url.searchParams.get('txn')).toBe('T'.repeat(43));
    expect(url.searchParams.get('return')).toBe('/board?day=3');
  });

  // ADR 0010's hard line, checked on the one URL this module assembles.
  it('carries no token of any kind', () => {
    const url = buildAuthOriginUrl({
      authOrigin: CENTRAL,
      targetOrigin: ORIGIN,
      transactionId: 'T'.repeat(43),
      returnPath: '/',
    });
    expect(url).not.toMatch(/token/i);
    expect(url).not.toContain(HANDOFF_FRAGMENT_KEY);
  });
});

describe('parseHandoffRequest', () => {
  const txn = 'T'.repeat(43);

  it('parses a well-formed request', () => {
    expect(parseHandoffRequest(`?target=${encodeURIComponent(ORIGIN)}&txn=${txn}&return=/board`)).toEqual(
      { targetOrigin: ORIGIN, transactionId: txn, returnPath: '/board' },
    );
  });

  it('defaults the return path to the root', () => {
    expect(
      parseHandoffRequest(`?target=${encodeURIComponent(ORIGIN)}&txn=${txn}`)?.returnPath,
    ).toBe('/');
  });

  it.each([
    ['no target', `?txn=${txn}`],
    ['no transaction', `?target=${encodeURIComponent(ORIGIN)}`],
    ['a malformed transaction', `?target=${encodeURIComponent(ORIGIN)}&txn=abc`],
    ['a target that is not an origin', `?target=notaurl&txn=${txn}`],
    ['a decorated target', `?target=${encodeURIComponent(`${ORIGIN}/x`)}&txn=${txn}`],
    // A protocol-relative path is read by a browser as a different ORIGIN — the
    // payload a naive "must start with /" check waves straight through.
    ['a protocol-relative return path', `?target=${encodeURIComponent(ORIGIN)}&txn=${txn}&return=//evil.test`],
    ['a relative return path', `?target=${encodeURIComponent(ORIGIN)}&txn=${txn}&return=board`],
  ])('refuses %s', (_label, search) => {
    expect(parseHandoffRequest(search)).toBeNull();
  });
});

describe('startAuthHandoff', () => {
  it('stores the verifier and navigates to the central origin', async () => {
    const navigate = vi.fn();
    expect(
      await startAuthHandoff({
        authOrigin: CENTRAL,
        targetOrigin: ORIGIN,
        returnPath: '/board',
        navigate,
      }),
    ).toBe(true);

    const stored = readHandoffTransaction(Date.now());
    expect(stored).toMatchObject({ targetOrigin: ORIGIN, returnPath: '/board' });

    const url = new URL(navigate.mock.calls[0][0] as string);
    expect(url.origin).toBe(CENTRAL);
    // Only the DIGEST travels. The verifier itself must appear nowhere in the URL.
    expect(url.searchParams.get('txn')).not.toBe(stored?.verifier);
    expect(navigate.mock.calls[0][0]).not.toContain(stored?.verifier);
  });

  it('publishes the digest of the verifier it kept', async () => {
    const navigate = vi.fn();
    await startAuthHandoff({ authOrigin: CENTRAL, targetOrigin: ORIGIN, returnPath: '/', navigate });
    const stored = readHandoffTransaction(Date.now());
    const published = new URL(navigate.mock.calls[0][0] as string).searchParams.get('txn');
    const { transactionIdFor } = await import('./handoffTransaction');
    expect(published).toBe(await transactionIdFor(stored!.verifier));
  });

  // Everything that can fail happens BEFORE the navigation. Discovering
  // unavailable storage afterwards means discovering it once a code has been
  // minted and spent, which is unrecoverable.
  it('refuses to navigate when the verifier cannot be stored', async () => {
    const deny = () => {
      throw new Error('denied');
    };
    const dead = { length: 0, clear: deny, getItem: deny, key: deny, removeItem: deny, setItem: deny };
    vi.stubGlobal('sessionStorage', dead);
    vi.stubGlobal('localStorage', dead);
    const navigate = vi.fn();

    expect(
      await startAuthHandoff({ authOrigin: CENTRAL, targetOrigin: ORIGIN, returnPath: '/', navigate }),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(consumeHandoffFailure()).toEqual({ reason: 'start-failed' });
  });

  it('reports a failure and keeps no verifier when the CSPRNG throws', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('no entropy');
      },
    });
    const navigate = vi.fn();
    expect(
      await startAuthHandoff({ authOrigin: CENTRAL, targetOrigin: ORIGIN, returnPath: '/', navigate }),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(HANDOFF_TRANSACTION_KEY)).toBeNull();
    expect(consumeHandoffFailure()).toEqual({ reason: 'start-failed' });
  });
});

describe('the failure channel', () => {
  it('reads a recorded failure exactly once', () => {
    recordHandoffFailure('exchange-rejected');
    expect(consumeHandoffFailure()).toEqual({ reason: 'exchange-rejected' });
    expect(consumeHandoffFailure()).toBeNull();
  });
});
