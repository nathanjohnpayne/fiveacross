import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_INVITATION_FRAGMENT_KEY,
  PENDING_EVENT_INVITATION_KEY,
  PENDING_EVENT_INVITATION_TTL_MS,
  capturePendingEventInvitation,
  forgetPendingEventInvitationIf,
  hasEventInvitationFragment,
  readPendingEventInvitation,
  readEventInvitationCode,
} from './pendingEventInvitation';

const CODE = 'I'.repeat(43);
const ORIGIN = 'https://summer-camp.fiveacross.app';
const NOW = 1_700_000_000_000;
const STORAGE_CAPTURE_ID_PATTERN = /^[a-f0-9]{32}$/;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

function pendingKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key !== null)
    .filter(
      (key) => key === PENDING_EVENT_INVITATION_KEY || key.startsWith(`${PENDING_EVENT_INVITATION_KEY}:`),
    );
}

function pendingKey(id: string): string {
  return `${PENDING_EVENT_INVITATION_KEY}:v1:${id}`;
}

function storedRecord(id: string, code = CODE, capturedAt = NOW, captureOrdinal = 0) {
  return { captureId: id, captureOrdinal, code, origin: ORIGIN, capturedAt };
}

function seedImpossibleOriginRecord(storage: Storage, id: string) {
  const mismatchedKey = pendingKey(id);
  const futureKey = `${PENDING_EVENT_INVITATION_KEY}:v2:${id}`;
  const unrelatedKey = `unrelated:${id}`;
  storage.setItem(
    mismatchedKey,
    JSON.stringify({
      ...storedRecord(id),
      origin: 'https://other.fiveacross.app',
    }),
  );
  storage.setItem(futureKey, 'future');
  storage.setItem(unrelatedKey, 'keep');
  return { mismatchedKey, futureKey, unrelatedKey };
}

function expectOnlyImpossibleOriginRecordRemoved(
  storage: Storage,
  keys: ReturnType<typeof seedImpossibleOriginRecord>,
): void {
  expect(storage.getItem(keys.mismatchedKey)).toBeNull();
  expect(storage.getItem(keys.futureKey)).toBe('future');
  expect(storage.getItem(keys.unrelatedKey)).toBe('keep');
}

function storageWithReplacementAfterRead(
  initialKey: string,
  initialValue: string,
  replacementKey: string,
  replacementValue: string,
): Storage {
  const storage = memoryStorage();
  storage.setItem(initialKey, initialValue);
  let replaced = false;
  return {
    get length() {
      return storage.length;
    },
    clear: () => storage.clear(),
    getItem: (key) => {
      const value = storage.getItem(key);
      if (!replaced && key === initialKey) {
        replaced = true;
        storage.setItem(replacementKey, replacementValue);
      }
      return value;
    },
    key: (index) => storage.key(index),
    removeItem: (key) => storage.removeItem(key),
    setItem: (key, value) => storage.setItem(key, value),
  };
}

function storageWithEffectOnFirstGet(storage: Storage, effect: () => void): Storage {
  let fired = false;
  return {
    get length() {
      return storage.length;
    },
    clear: () => storage.clear(),
    getItem: (key) => {
      if (!fired) {
        fired = true;
        effect();
      }
      return storage.getItem(key);
    },
    key: (index) => storage.key(index),
    removeItem: (key) => storage.removeItem(key),
    setItem: (key, value) => storage.setItem(key, value),
  };
}

function deadStorage(): Storage {
  const deny = (): never => {
    throw new Error('storage denied');
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

function withUnnameableStores(fn: () => void): void {
  const names = ['sessionStorage', 'localStorage'] as const;
  const descriptors = names.map(
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
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  const state = readPendingEventInvitation({ origin: ORIGIN, now: NOW });
  if (state) forgetPendingEventInvitationIf(state.record);
  vi.unstubAllGlobals();
});

describe('readEventInvitationCode', () => {
  it('recognizes the credential slot even when its value is malformed or duplicated', () => {
    expect(hasEventInvitationFragment(`#${EVENT_INVITATION_FRAGMENT_KEY}=short`)).toBe(true);
    expect(
      hasEventInvitationFragment(
        `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}&${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      ),
    ).toBe(true);
    expect(hasEventInvitationFragment('#unrelated=value')).toBe(false);
    expect(hasEventInvitationFragment(`?${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`)).toBe(false);
  });

  it('accepts exactly one 256-bit base64url token from the invitation fragment', () => {
    expect(readEventInvitationCode(`#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`)).toBe(CODE);
  });

  it('allows unrelated fragment state around the invitation', () => {
    expect(readEventInvitationCode(`#view=board&${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`)).toBe(
      CODE,
    );
  });

  it.each([
    ['', 'an empty URL fragment'],
    ['#', 'a bare hash'],
    [`?${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`, 'a query string'],
    [`#${EVENT_INVITATION_FRAGMENT_KEY}=short`, 'a short token'],
    [`#${EVENT_INVITATION_FRAGMENT_KEY}=${'I'.repeat(42)}+`, 'a non-base64url token'],
    [
      `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}&${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      'an ambiguous duplicate',
    ],
    [`#other=${CODE}`, 'a different fragment key'],
  ])('rejects %s (%s)', (hash) => {
    expect(readEventInvitationCode(hash)).toBeNull();
  });
});

describe('capture and recovery', () => {
  it('stores a valid origin-bound invitation in both browser stores', () => {
    const captured = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    });

    expect(captured).toEqual({
      record: {
        captureId: expect.stringMatching(STORAGE_CAPTURE_ID_PATTERN),
        captureOrdinal: 0,
        code: CODE,
        origin: ORIGIN,
        capturedAt: NOW,
      },
      durable: true,
    });
    expect(pendingKeys(sessionStorage)).toHaveLength(1);
    const sessionKey = pendingKeys(sessionStorage)[0]!;
    expect(sessionKey).toMatch(
      new RegExp(`^${PENDING_EVENT_INVITATION_KEY}:v1:[a-f0-9]{32}$`),
    );
    expect(sessionKey).not.toContain(CODE);
    expect(sessionKey).not.toContain('summer-camp');
    expect(sessionStorage.getItem(sessionKey)).toContain(CODE);
    expect(pendingKeys(localStorage)).toHaveLength(1);
    expect(localStorage.getItem(pendingKeys(localStorage)[0]!)).toContain(CODE);
  });

  it('falls back to localStorage when the session copy is lost across authentication', () => {
    capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    });
    sessionStorage.clear();

    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })).toEqual({
      record: {
        captureId: expect.stringMatching(STORAGE_CAPTURE_ID_PATTERN),
        captureOrdinal: 0,
        code: CODE,
        origin: ORIGIN,
        capturedAt: NOW,
      },
      durable: true,
    });
  });

  it('falls through a malformed session copy to a valid local copy', () => {
    localStorage.setItem(
      pendingKey('a'.repeat(32)),
      JSON.stringify(storedRecord('a'.repeat(32))),
    );
    const malformedKey = pendingKey('b'.repeat(32));
    sessionStorage.setItem(malformedKey, 'not json');

    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })?.record.code).toBe(CODE);
    expect(sessionStorage.getItem(malformedKey)).toBeNull();
  });

  it.each(['sessionStorage', 'localStorage'] as const)(
    'scrubs an impossible-origin v1 bearer from %s without touching other versions',
    (name) => {
      const storage = globalThis[name];
      const keys = seedImpossibleOriginRecord(storage, 'c'.repeat(32));

      expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })).toBeNull();
      expectOnlyImpossibleOriginRecordRemoved(storage, keys);
    },
  );

  it('scrubs impossible-origin v1 bearers while capturing a valid replacement', () => {
    const sessionKeys = seedImpossibleOriginRecord(sessionStorage, 'd'.repeat(32));
    const localKeys = seedImpossibleOriginRecord(localStorage, 'e'.repeat(32));

    const captured = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    })!;

    expectOnlyImpossibleOriginRecordRemoved(sessionStorage, sessionKeys);
    expectOnlyImpossibleOriginRecordRemoved(localStorage, localKeys);
    expect(sessionStorage.getItem(pendingKey(captured.record.captureId))).not.toBeNull();
    expect(localStorage.getItem(pendingKey(captured.record.captureId))).not.toBeNull();
  });

  it('scrubs impossible-origin v1 bearers during malformed replacement cleanup', () => {
    const sessionKeys = seedImpossibleOriginRecord(sessionStorage, 'f'.repeat(32));
    const localKeys = seedImpossibleOriginRecord(localStorage, '0'.repeat(32));

    expect(
      capturePendingEventInvitation({
        hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=short`,
        origin: ORIGIN,
        now: NOW,
      }),
    ).toBeNull();

    expectOnlyImpossibleOriginRecordRemoved(sessionStorage, sessionKeys);
    expectOnlyImpossibleOriginRecordRemoved(localStorage, localKeys);
  });

  it('keeps a current-document copy when both stores reject access', () => {
    vi.stubGlobal('sessionStorage', deadStorage());
    vi.stubGlobal('localStorage', deadStorage());

    const captured = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    });

    expect(captured).toEqual({
      record: {
        captureId: expect.stringMatching(STORAGE_CAPTURE_ID_PATTERN),
        captureOrdinal: 0,
        code: CODE,
        origin: ORIGIN,
        capturedAt: NOW,
      },
      durable: false,
    });
  });

  it('does not throw when browser privacy settings make storage getters throw', () => {
    withUnnameableStores(() => {
      expect(
        capturePendingEventInvitation({
          hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
          origin: ORIGIN,
          now: NOW,
        }),
      ).toEqual({
        record: {
          captureId: expect.stringMatching(STORAGE_CAPTURE_ID_PATTERN),
          captureOrdinal: 0,
          code: CODE,
          origin: ORIGIN,
          capturedAt: NOW,
        },
        durable: false,
      });
    });
  });

  it('keeps only a memory record when capture identity generation fails', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('randomness unavailable');
      },
    });

    expect(
      capturePendingEventInvitation({
        hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
        origin: ORIGIN,
        now: NOW,
      }),
    ).toEqual({
      record: {
        captureId: expect.stringMatching(/^memory:\d+$/),
        captureOrdinal: 0,
        code: CODE,
        origin: ORIGIN,
        capturedAt: NOW,
      },
      durable: false,
    });
    expect(pendingKeys(sessionStorage)).toHaveLength(0);
    expect(pendingKeys(localStorage)).toHaveLength(0);
  });

  it('lets a same-millisecond malformed replacement clear a memory-only capture', () => {
    const browserCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('randomness unavailable');
      },
    });
    capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    });
    vi.stubGlobal('crypto', browserCrypto);

    expect(
      capturePendingEventInvitation({
        hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=short`,
        origin: ORIGIN,
        now: NOW,
      }),
    ).toBeNull();
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })).toBeNull();
  });

  it('rejects malformed origins before retaining the bearer value', () => {
    expect(
      capturePendingEventInvitation({
        hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
        origin: `${ORIGIN}/board`,
        now: NOW,
      }),
    ).toBeNull();
    expect(pendingKeys(sessionStorage)).toHaveLength(0);
    expect(pendingKeys(localStorage)).toHaveLength(0);
  });

  it.each([
    [`#${EVENT_INVITATION_FRAGMENT_KEY}=short`, 'a malformed replacement'],
    [
      `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}&${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      'an ambiguous replacement',
    ],
  ])('supersedes a stale same-origin invitation with %s (%s)', (hash) => {
    const stale = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    })!.record;

    expect(capturePendingEventInvitation({ hash, origin: ORIGIN, now: NOW + 1 })).toBeNull();
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW + 1 })).toBeNull();
    expect(pendingKeys(sessionStorage)).toHaveLength(0);
    expect(pendingKeys(localStorage)).toHaveLength(0);
    expect(forgetPendingEventInvitationIf(stale)).toBe(false);
  });
});

describe('origin and TTL binding', () => {
  beforeEach(() => {
    capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    });
  });

  it('does not return an invitation to another origin', () => {
    expect(
      readPendingEventInvitation({ origin: 'https://other.fiveacross.app', now: NOW }),
    ).toBeNull();
  });

  it('accepts the record through the TTL boundary', () => {
    expect(
      readPendingEventInvitation({ origin: ORIGIN, now: NOW + PENDING_EVENT_INVITATION_TTL_MS }),
    ).not.toBeNull();
  });

  it('physically erases the bearer after the TTL', () => {
    const expected = readPendingEventInvitation({ origin: ORIGIN, now: NOW })!.record;
    expect(
      readPendingEventInvitation({
        origin: ORIGIN,
        now: NOW + PENDING_EVENT_INVITATION_TTL_MS + 1,
      }),
    ).toBeNull();
    expect(pendingKeys(sessionStorage)).toHaveLength(0);
    expect(pendingKeys(localStorage)).toHaveLength(0);
    expect(forgetPendingEventInvitationIf(expected)).toBe(false);
  });

  it('does not expose or erase a concurrent record observed before its capture time', () => {
    const expected = readPendingEventInvitation({ origin: ORIGIN, now: NOW })!.record;
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW - 1 })).toBeNull();
    expect(pendingKeys(sessionStorage)).toHaveLength(1);
    expect(pendingKeys(localStorage)).toHaveLength(1);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })?.record).toEqual(expected);
  });
});

describe('compare-delete', () => {
  it('cannot erase a newer invitation captured by another tab', () => {
    const older = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    })!.record;
    const newerCode = 'N'.repeat(43);
    const newer = storedRecord('e'.repeat(32), newerCode, NOW + 1);
    // Another tab shares localStorage, but not this tab's sessionStorage or
    // module memory. This is the exact cross-tab shape compare-delete protects.
    localStorage.setItem(
      pendingKey('e'.repeat(32)),
      JSON.stringify(newer),
    );

    expect(forgetPendingEventInvitationIf(older)).toBe(true);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW + 1 })?.record).toEqual(newer);
    expect(forgetPendingEventInvitationIf(newer)).toBe(true);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW + 1 })).toBeNull();
  });

  it('cannot erase a replacement written between the old record read and deletion', () => {
    const older = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    })!.record;
    const oldKey = pendingKeys(localStorage)[0]!;
    const oldValue = localStorage.getItem(oldKey)!;
    const newer = storedRecord('f'.repeat(32), 'N'.repeat(43), NOW + 1);
    const newerKey = pendingKey('f'.repeat(32));
    vi.stubGlobal(
      'localStorage',
      storageWithReplacementAfterRead(oldKey, oldValue, newerKey, JSON.stringify(newer)),
    );

    expect(forgetPendingEventInvitationIf(older)).toBe(true);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW + 1 })?.record).toEqual(newer);
  });

  it('distinguishes captures with identical bearer, origin, and timestamp', () => {
    const older = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    })!.record;
    const newer = storedRecord('f'.repeat(32));
    localStorage.setItem(pendingKey(newer.captureId), JSON.stringify(newer));

    expect(forgetPendingEventInvitationIf(older)).toBe(true);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })?.record).toEqual(newer);
  });

  it('makes a sequential same-millisecond capture supersede the prior record', () => {
    const older = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    })!.record;
    const newer = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${'N'.repeat(43)}`,
      origin: ORIGIN,
      now: NOW,
    })!.record;

    expect(newer.captureOrdinal).toBe(older.captureOrdinal + 1);
    expect(pendingKeys(sessionStorage)).toHaveLength(1);
    expect(pendingKeys(localStorage)).toHaveLength(1);
    expect(forgetPendingEventInvitationIf(newer)).toBe(true);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })).toBeNull();
  });

  it('keeps random key identity independent from observed same-time order', () => {
    const observed = storedRecord('f'.repeat(32), CODE, NOW, 7);
    localStorage.setItem(pendingKey(observed.captureId), JSON.stringify(observed));
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0);
        return bytes;
      },
    });

    const captured = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${'N'.repeat(43)}`,
      origin: ORIGIN,
      now: NOW,
    })!;

    expect(captured.record.captureOrdinal).toBe(8);
    expect(captured.record.captureId).toBe('0'.repeat(32));
    expect(captured.durable).toBe(true);
  });

  it('resets an exhausted observed ordinal without persisting an invalid record', () => {
    const exhausted = storedRecord(
      'f'.repeat(32),
      CODE,
      NOW,
      Number.MAX_SAFE_INTEGER,
    );
    localStorage.setItem(pendingKey(exhausted.captureId), JSON.stringify(exhausted));

    const captured = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${'N'.repeat(43)}`,
      origin: ORIGIN,
      now: NOW,
    })!;

    expect(captured.record.captureOrdinal).toBe(0);
    expect(captured.durable).toBe(true);
    expect(localStorage.getItem(pendingKey(exhausted.captureId))).toBeNull();
    expect(pendingKeys(localStorage)).toHaveLength(1);
  });

  it('preserves a later cross-tab capture published while a valid replacement starts', () => {
    capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    });
    const later = storedRecord('f'.repeat(32), 'N'.repeat(43), NOW + 2);
    const tabSessionStorage = sessionStorage;
    vi.stubGlobal(
      'sessionStorage',
      storageWithEffectOnFirstGet(tabSessionStorage, () => {
        localStorage.setItem(pendingKey(later.captureId), JSON.stringify(later));
      }),
    );

    const current = capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${'M'.repeat(43)}`,
      origin: ORIGIN,
      now: NOW + 1,
    })!.record;

    expect(localStorage.getItem(pendingKey(later.captureId))).not.toBeNull();
    expect(forgetPendingEventInvitationIf(current)).toBe(true);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW + 2 })?.record).toEqual(later);
  });

  it('preserves a later cross-tab capture published while malformed cleanup starts', () => {
    capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    });
    const later = storedRecord('f'.repeat(32), 'N'.repeat(43), NOW + 2);
    const tabSessionStorage = sessionStorage;
    vi.stubGlobal(
      'sessionStorage',
      storageWithEffectOnFirstGet(tabSessionStorage, () => {
        localStorage.setItem(pendingKey(later.captureId), JSON.stringify(later));
      }),
    );

    expect(
      capturePendingEventInvitation({
        hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=short`,
        origin: ORIGIN,
        now: NOW + 1,
      }),
    ).toBeNull();
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW + 2 })?.record).toEqual(later);
  });
});
