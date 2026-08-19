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
    const loc = { pathname: '/board', search: '?day=3', hash: `#${HANDOFF_FRAGMENT_KEY}=${CODE}` };
    const replaceState = vi.fn(() => {
      loc.hash = '';
    });
    vi.stubGlobal('window', { location: loc, history: { state: { a: 1 }, replaceState } });
    expect(clearHandoffFragment()).toBe(true);
    expect(replaceState).toHaveBeenCalledWith({ a: 1 }, '', '/board?day=3');
  });

  it('never throws when the history API refuses, and says so', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '', hash: `#${HANDOFF_FRAGMENT_KEY}=${CODE}` },
      history: {
        state: null,
        replaceState: () => {
          throw new Error('denied');
        },
      },
    });
    expect(clearHandoffFragment()).toBe(false);
  });

  // Phase 4b P1: a `replaceState` that is accepted but does nothing still leaves
  // a LIVE code in the URL. Assuming success there is what would let telemetry
  // read it — so the result is confirmed against the URL, not the call.
  it('reports failure when replaceState no-ops and the code survives', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '', hash: `#${HANDOFF_FRAGMENT_KEY}=${CODE}` },
      history: { state: null, replaceState: vi.fn() },
    });
    expect(clearHandoffFragment()).toBe(false);
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

  // Phase 4b P1. The old `startsWith('/') && !startsWith('//')` test was a
  // BLACKLIST, and blacklists lose here: each of these begins with a single `/`
  // and still resolves OFF-ORIGIN under WHATWG URL rules. Since `returnPath` is
  // handed to the server to build the URL that carries the handoff code, a miss
  // turns the trusted central auth endpoint into an open redirect that leaks a
  // freshly minted code.
  //
  // The payloads are pinned by their RESOLVED origin rather than their shape,
  // so this test states the property instead of restating the implementation.
  it.each([
    ['a literal backslash', '/\\evil.example'],
    ['a backslash-slash pair', '/\\/evil.example'],
    ['a literal tab between the slashes', '/\t/evil.example'],
    ['a literal newline between the slashes', '/\n/evil.example'],
    ['a literal carriage return', '/\r/evil.example'],
  ])('refuses %s, which resolves off-origin', (_label, returnPath) => {
    // Guard on the premise: if this ever stops resolving off-origin, the test
    // has stopped testing what it claims to.
    expect(new URL(returnPath, ORIGIN).origin).not.toBe(ORIGIN);
    const search = `?target=${encodeURIComponent(ORIGIN)}&txn=${txn}&return=${encodeURIComponent(returnPath)}`;
    expect(parseHandoffRequest(search)).toBeNull();
  });

  // The counterpart, and the reason resolve-and-compare beats a denylist in
  // BOTH directions: percent-encoded sequences are NOT decoded by URL
  // resolution, so these stay on the target origin and are perfectly safe deep
  // links. A pattern-matcher tuned to reject "backslash-ish" strings would have
  // broken them for no benefit.
  it.each([
    ['an encoded backslash', '/%5Cevil.example'],
    ['an encoded tab', '/%09/evil.example'],
    ['an encoded newline', '/%0A/evil.example'],
  ])('still accepts %s, which stays on the target origin', (_label, returnPath) => {
    expect(new URL(returnPath, ORIGIN).origin).toBe(ORIGIN);
    const search = `?target=${encodeURIComponent(ORIGIN)}&txn=${txn}&return=${encodeURIComponent(returnPath)}`;
    expect(parseHandoffRequest(search)?.returnPath).toBe(returnPath);
  });

  it.each([
    ['a plain path', '/board'],
    ['a path with a query', '/board?day=3'],
    ['a nested path', '/a/b/c'],
    ['the root', '/'],
  ])('still accepts %s', (_label, returnPath) => {
    const search = `?target=${encodeURIComponent(ORIGIN)}&txn=${txn}&return=${encodeURIComponent(returnPath)}`;
    expect(parseHandoffRequest(search)?.returnPath).toBe(returnPath);
  });

  it('refuses a fragment or an over-long path', () => {
    const mk = (rp: string) =>
      `?target=${encodeURIComponent(ORIGIN)}&txn=${txn}&return=${encodeURIComponent(rp)}`;
    expect(parseHandoffRequest(mk('/board#x'))).toBeNull();
    expect(parseHandoffRequest(mk(`/${'a'.repeat(600)}`))).toBeNull();
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
