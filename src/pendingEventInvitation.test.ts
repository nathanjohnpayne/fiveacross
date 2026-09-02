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
      record: { code: CODE, origin: ORIGIN, capturedAt: NOW },
      durable: true,
    });
    expect(sessionStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toContain(CODE);
    expect(localStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toContain(CODE);
  });

  it('falls back to localStorage when the session copy is lost across authentication', () => {
    capturePendingEventInvitation({
      hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
      origin: ORIGIN,
      now: NOW,
    });
    sessionStorage.clear();

    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })).toEqual({
      record: { code: CODE, origin: ORIGIN, capturedAt: NOW },
      durable: true,
    });
  });

  it('falls through a malformed session copy to a valid local copy', () => {
    localStorage.setItem(
      PENDING_EVENT_INVITATION_KEY,
      JSON.stringify({ code: CODE, origin: ORIGIN, capturedAt: NOW }),
    );
    sessionStorage.setItem(PENDING_EVENT_INVITATION_KEY, 'not json');

    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW })?.record.code).toBe(CODE);
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
      record: { code: CODE, origin: ORIGIN, capturedAt: NOW },
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
        record: { code: CODE, origin: ORIGIN, capturedAt: NOW },
        durable: false,
      });
    });
  });

  it('rejects malformed origins before retaining the bearer value', () => {
    expect(
      capturePendingEventInvitation({
        hash: `#${EVENT_INVITATION_FRAGMENT_KEY}=${CODE}`,
        origin: `${ORIGIN}/board`,
        now: NOW,
      }),
    ).toBeNull();
    expect(sessionStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toBeNull();
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
    expect(sessionStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toBeNull();
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
    const expected = { code: CODE, origin: ORIGIN, capturedAt: NOW };
    expect(
      readPendingEventInvitation({
        origin: ORIGIN,
        now: NOW + PENDING_EVENT_INVITATION_TTL_MS + 1,
      }),
    ).toBeNull();
    expect(sessionStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toBeNull();
    expect(forgetPendingEventInvitationIf(expected)).toBe(false);
  });

  it('physically erases a record captured in the future', () => {
    const expected = { code: CODE, origin: ORIGIN, capturedAt: NOW };
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW - 1 })).toBeNull();
    expect(sessionStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_EVENT_INVITATION_KEY)).toBeNull();
    expect(forgetPendingEventInvitationIf(expected)).toBe(false);
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
    const newer = {
      code: newerCode,
      origin: ORIGIN,
      capturedAt: NOW + 1,
    };
    // Another tab shares localStorage, but not this tab's sessionStorage or
    // module memory. This is the exact cross-tab shape compare-delete protects.
    localStorage.setItem(PENDING_EVENT_INVITATION_KEY, JSON.stringify(newer));

    expect(forgetPendingEventInvitationIf(older)).toBe(true);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW + 1 })?.record).toEqual(newer);
    expect(forgetPendingEventInvitationIf(newer)).toBe(true);
    expect(readPendingEventInvitation({ origin: ORIGIN, now: NOW + 1 })).toBeNull();
  });
});
