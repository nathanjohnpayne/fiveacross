// Covers specs/auth-handoff-client.md § The transaction verifier.
//
// The verifier is the half that never leaves this origin, and it is what makes
// a code in a URL something other than a session in a URL. Two properties are
// worth more than the rest and are tested hardest: it must SURVIVE a round trip
// that can drop sessionStorage, and it must be GONE the moment the transaction
// is over.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_TRANSACTION_KEY,
  HANDOFF_TRANSACTION_TTL_MS,
  HANDOFF_TOKEN_PATTERN,
  base64url,
  createVerifier,
  forgetHandoffTransaction,
  readHandoffTransaction,
  rememberHandoffTransaction,
} from './handoffTransaction';

const NOW = 1_700_000_000_000;

/**
 * A real in-memory `Storage`.
 *
 * Needed because this jsdom configuration exposes `sessionStorage` but NOT
 * `localStorage` — which is itself the reason the module reaches both stores
 * through `globalThis` with optional chaining rather than naming them directly.
 * Stubbing it here makes the dual-store behaviour observable instead of
 * silently untested.
 */
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

/** A store that refuses every operation — private mode, disabled storage, quota. */
function deadStorage(): Storage {
  const deny = () => {
    throw new Error('denied');
  };
  return {
    get length(): number {
      return deny();
    },
    clear: deny,
    getItem: deny,
    key: deny,
    removeItem: deny,
    setItem: deny,
  };
}

/**
 * Run `fn` with the named globals throwing on ACCESS, then restore them exactly.
 *
 * `Reflect.deleteProperty` is not a valid undo here — it removes jsdom's real
 * `sessionStorage` for every later test in the file — so the original
 * descriptors are captured and put back.
 */
function withUnnameableStores(names: readonly string[], fn: () => void): void {
  const saved = names.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
  }
  try {
    fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

beforeEach(() => {
  try {
    globalThis.sessionStorage?.clear();
  } catch {
    /* a stubbed or absent store needs no clearing */
  }
  vi.stubGlobal('localStorage', memoryStorage());
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    verifier: 'A'.repeat(43),
    targetOrigin: 'https://summer-camp.fiveacross.app',
    returnPath: '/board',
    createdAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('base64url', () => {
  it('encodes unpadded, with the URL-safe alphabet', () => {
    // 0xFF 0xFE 0xFD is `//79` in standard base64 — the bytes chosen precisely
    // because they exercise both substituted characters.
    expect(base64url(new Uint8Array([255, 254, 253]))).toBe('__79');
    expect(base64url(new Uint8Array([251, 255]))).toBe('-_8');
    expect(base64url(new Uint8Array([]))).toBe('');
  });

  it.each([[1], [2], [3], [4], [5], [31], [32], [33]])(
    'never emits padding or a non-URL-safe character for %i bytes',
    (length) => {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      expect(base64url(bytes)).toMatch(/^[A-Za-z0-9_-]*$/);
    },
  );
});

describe('createVerifier', () => {
  it('produces the 43-character shape the server accepts', () => {
    expect(createVerifier()).toMatch(HANDOFF_TOKEN_PATTERN);
  });

  // Throwing beats degrading. A `Math.random` fallback would produce a verifier
  // that looks right, redeems right, and is predictable — a silent downgrade of
  // the one secret holding the whole transaction binding up.
  it('throws rather than degrading when the CSPRNG is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('no entropy');
      },
    });
    expect(() => createVerifier()).toThrow();
  });
});

describe('remember / read / forget', () => {
  it('round-trips a transaction', () => {
    expect(rememberHandoffTransaction(record())).toBe(true);
    expect(readHandoffTransaction(NOW)).toEqual(record());
  });

  it('reads nothing when nothing was stored', () => {
    expect(readHandoffTransaction(NOW)).toBeNull();
  });

  // The durability property. iOS Safari is documented in this repo as dropping
  // sessionStorage across a provider round trip while localStorage survives —
  // and a lost verifier is not a security failure, it is an unrecoverable dead
  // end, because the code it was paired with is single-use and already spent.
  it('survives sessionStorage being wiped mid-round-trip', () => {
    rememberHandoffTransaction(record());
    sessionStorage.clear();
    expect(readHandoffTransaction(NOW)).toEqual(record());
  });

  it('prefers the sessionStorage copy when both are present', () => {
    rememberHandoffTransaction(record());
    localStorage.setItem(HANDOFF_TRANSACTION_KEY, JSON.stringify(record({ returnPath: '/stale' })));
    expect(readHandoffTransaction(NOW)?.returnPath).toBe('/board');
  });

  it('clears BOTH stores, so nothing is left holding a spent verifier', () => {
    rememberHandoffTransaction(record());
    forgetHandoffTransaction();
    expect(sessionStorage.getItem(HANDOFF_TRANSACTION_KEY)).toBeNull();
    expect(localStorage.getItem(HANDOFF_TRANSACTION_KEY)).toBeNull();
    expect(readHandoffTransaction(NOW)).toBeNull();
  });

  // Reporting failure is what lets the caller abort BEFORE navigating. Leaving
  // without a retrievable verifier guarantees the return leg fails, and it fails
  // only after a code has been minted and spent.
  it('reports failure when no store will accept the write', () => {
    vi.stubGlobal('sessionStorage', deadStorage());
    vi.stubGlobal('localStorage', deadStorage());
    expect(rememberHandoffTransaction(record())).toBe(false);
  });

  it('still succeeds when only one store works', () => {
    vi.stubGlobal('sessionStorage', deadStorage());
    expect(rememberHandoffTransaction(record())).toBe(true);
    expect(readHandoffTransaction(NOW)).toEqual(record());
  });
});

describe('readHandoffTransaction rejects anything it cannot trust', () => {
  it.each([
    ['unparseable json', 'not json'],
    ['a json primitive', '"a string"'],
    ['null', 'null'],
    ['an array', '[]'],
  ])('reads %s as absent', (_label, raw) => {
    sessionStorage.setItem(HANDOFF_TRANSACTION_KEY, raw);
    expect(readHandoffTransaction(NOW)).toBeNull();
  });

  it.each([
    ['a missing verifier', record({ verifier: undefined })],
    ['a short verifier', record({ verifier: 'abc' })],
    ['a verifier with a non-base64url character', record({ verifier: `${'A'.repeat(42)}+` })],
    ['a non-string verifier', record({ verifier: 42 })],
    ['a missing target origin', record({ targetOrigin: undefined })],
    ['a blank target origin', record({ targetOrigin: '' })],
    ['a relative return path', record({ returnPath: 'board' })],
    ['a missing return path', record({ returnPath: undefined })],
    ['a non-numeric createdAt', record({ createdAt: 'soon' })],
    ['a NaN createdAt', record({ createdAt: Number.NaN })],
  ])('reads %s as absent', (_label, value) => {
    sessionStorage.setItem(HANDOFF_TRANSACTION_KEY, JSON.stringify(value));
    expect(readHandoffTransaction(NOW)).toBeNull();
  });

  it('accepts a transaction right up to the TTL', () => {
    rememberHandoffTransaction(record());
    expect(readHandoffTransaction(NOW + HANDOFF_TRANSACTION_TTL_MS)).not.toBeNull();
  });

  // An abandoned sign-in must not authorize an unrelated one later in the day.
  it('rejects a transaction past the TTL', () => {
    rememberHandoffTransaction(record());
    expect(readHandoffTransaction(NOW + HANDOFF_TRANSACTION_TTL_MS + 1)).toBeNull();
  });

  // A record from the future means the clock moved during the round trip, which
  // makes the age unknowable rather than small.
  it('rejects a transaction stamped in the future', () => {
    rememberHandoffTransaction(record({ createdAt: NOW + 60_000 }));
    expect(readHandoffTransaction(NOW)).toBeNull();
  });

  // The local TTL is deliberately the LOOSER of the two: the server owns expiry
  // (120s), and a tighter local window would discard the verifier for a code the
  // server would still have honoured.
  it('is looser than the server deadline it must never pre-empt', () => {
    expect(HANDOFF_TRANSACTION_TTL_MS).toBeGreaterThan(120_000);
  });
});

describe('storage key', () => {
  it('uses the Five Across namespace the rest of the era-appropriate state uses', () => {
    expect(HANDOFF_TRANSACTION_KEY.startsWith('fa:')).toBe(true);
  });
});

// Codex P2, round 1 — two ways the durability story quietly broke.
describe('storage hazards that are not ordinary failures', () => {
  it('confirms the record it just wrote, not merely that some record exists', () => {
    // An abandoned, still-in-TTL transaction is sitting in sessionStorage, and
    // the new write fails there while succeeding in localStorage. Returning
    // `true` here would navigate with the NEW digest while the return leg reads
    // the OLD verifier — every exchange then rejected as a transaction
    // mismatch, with nothing on either side looking broken.
    const stale = record({ verifier: 'S'.repeat(43) });
    const session = memoryStorage();
    session.setItem(HANDOFF_TRANSACTION_KEY, JSON.stringify(stale));
    const readOnly: Storage = {
      ...session,
      get length() {
        return session.length;
      },
      getItem: (k: string) => session.getItem(k),
      key: (i: number) => session.key(i),
      clear: () => session.clear(),
      removeItem: () => {
        /* refuses to clear */
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    vi.stubGlobal('sessionStorage', readOnly);

    const fresh = record({ verifier: 'F'.repeat(43) });
    expect(rememberHandoffTransaction(fresh)).toBe(false);
  });

  it('clears any previous transaction before storing a new one', () => {
    rememberHandoffTransaction(record({ verifier: 'A'.repeat(43) }));
    rememberHandoffTransaction(record({ verifier: 'B'.repeat(43) }));
    expect(readHandoffTransaction(NOW)?.verifier).toBe('B'.repeat(43));
    expect(localStorage.getItem(HANDOFF_TRANSACTION_KEY)).toContain('B'.repeat(43));
  });

  // Reading `globalThis.sessionStorage` is not a safe property access: the
  // GETTER itself throws SecurityError in privacy-restricted and embedded
  // contexts. Evaluated at a call site, that throw escapes before any helper
  // try-block runs, so the localStorage fallback never gets a turn.
  it('falls back to localStorage when naming sessionStorage itself throws', () => {
    withUnnameableStores(['sessionStorage'], () => {
      expect(rememberHandoffTransaction(record())).toBe(true);
      expect(readHandoffTransaction(NOW)).toEqual(record());
      expect(() => forgetHandoffTransaction()).not.toThrow();
    });
  });

  it('never throws out of forget, even when both stores refuse to be named', () => {
    withUnnameableStores(['sessionStorage', 'localStorage'], () => {
      expect(() => forgetHandoffTransaction()).not.toThrow();
      expect(readHandoffTransaction(NOW)).toBeNull();
      // Reported honestly as "not stored" rather than throwing out of the start
      // leg, which is what keeps the inline `start-failed` state reachable.
      expect(rememberHandoffTransaction(record())).toBe(false);
    });
  });
});
