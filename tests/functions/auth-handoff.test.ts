import { describe, expect, it } from 'vitest';
import {
  HANDOFF_FRAGMENT_KEY,
  HANDOFF_TTL_MS,
  buildHandoffRecord,
  exchangeHandoff,
  handoffPath,
  mintHandoff,
  transactionIdFor,
  validateReturnPath,
  type ExchangeDeps,
  type HandoffDocRef,
  type HandoffFirestore,
  type HandoffRecordInput,
  type HandoffSnapshot,
  type HandoffTransaction,
  type MintDeps,
} from '../../functions/src/authHandoff';

// Covers specs/auth-handoff.md at the decision layer — every branch of mint and
// exchange, against an in-memory Firestore whose transactions model the real
// thing's optimistic concurrency. The same module is exercised against a REAL
// emulator in tests/rules/auth-handoff.test.ts, which is where the deny-all
// rules and a genuine two-writer race live; this suite is where the twenty-odd
// rejection branches are cheap enough to enumerate exhaustively.

const HOST = 'bodega-bay.fiveacross.app';
const ORIGIN = `https://${HOST}`;
const OTHER_ORIGIN = 'https://someone-else.fiveacross.app';
const UID = 'player-1';
const T0 = 1_760_000_000_000;

/** A 43-character base64url token, the shape codes and verifiers both take. */
const token = (seed: string) => (seed + 'x'.repeat(43)).slice(0, 43);
const VERIFIER = token('verifier-');
const CODE = token('code-');

// --- In-memory Firestore with real optimistic concurrency ------------------------

interface Stored {
  data: Record<string, unknown>;
  /** Bumped on every write. Standing in for Firestore's internal update time,
   *  which is what its transactions actually compare. */
  version: number;
}

interface FakeDb {
  db: HandoffFirestore;
  docs: Map<string, Stored>;
  /** Reads served, so a test can prove a malformed input never reached storage. */
  reads: { count: number };
  /** Fires inside every transaction attempt, after the callback and before the
   *  conflict check — the seam a test uses to interleave two transactions. */
  hooks: { beforeCommit?: () => Promise<void> };
}

/**
 * A fake whose `runTransaction` reproduces the ONE property single-use rests on:
 * a transaction that reads a document and then writes it commits only if nothing
 * else wrote that document in between, and otherwise re-runs the whole callback.
 * `it('detects a conflicting write')` below proves the fake actually has that
 * property, because a concurrency test against a fake that always commits would
 * pass no matter what the code under test did.
 */
function makeDb(seed: Record<string, Record<string, unknown>> = {}): FakeDb {
  const docs = new Map<string, Stored>();
  for (const [path, data] of Object.entries(seed)) docs.set(path, { data: { ...data }, version: 0 });
  const reads = { count: 0 };
  const hooks: FakeDb['hooks'] = {};

  const snapshot = (path: string): HandoffSnapshot => {
    const stored = docs.get(path);
    return { exists: stored !== undefined, data: () => (stored ? { ...stored.data } : undefined) };
  };

  const refFor = (path: string): HandoffDocRef & { path: string } => ({
    path,
    get: async () => {
      reads.count += 1;
      return snapshot(path);
    },
    create: async (data) => {
      if (docs.has(path)) throw new Error(`ALREADY_EXISTS: ${path}`);
      docs.set(path, { data: { ...data }, version: 0 });
      return undefined;
    },
  });

  const pathOf = (ref: HandoffDocRef): string => (ref as { path: string }).path;

  const db: HandoffFirestore = {
    doc: (path) => refFor(path),
    runTransaction: async <T,>(fn: (tx: HandoffTransaction) => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // Version seen at read time; -1 means "absent when I looked".
        const readVersions = new Map<string, number>();
        const pendingWrites: Array<[string, Record<string, unknown>]> = [];
        const tx: HandoffTransaction = {
          get: async (ref) => {
            const path = pathOf(ref);
            reads.count += 1;
            readVersions.set(path, docs.get(path)?.version ?? -1);
            return snapshot(path);
          },
          update: (ref, data) => {
            pendingWrites.push([pathOf(ref), data]);
          },
        };

        const result = await fn(tx);
        if (hooks.beforeCommit) await hooks.beforeCommit();

        const conflicted = [...readVersions].some(
          ([path, seen]) => (docs.get(path)?.version ?? -1) !== seen,
        );
        // Exactly Firestore's ABORTED behaviour: discard the writes, re-run the
        // whole callback, let it decide again on freshly-read state.
        if (conflicted) continue;

        for (const [path, data] of pendingWrites) {
          const current = docs.get(path);
          docs.set(path, {
            data: { ...(current?.data ?? {}), ...data },
            version: (current?.version ?? -1) + 1,
          });
        }
        return result;
      }
      throw new Error('transaction failed after 5 attempts');
    },
  };

  return { db, docs, reads, hooks };
}

const activeHost = (host = HOST) => ({
  [`hostnames/${host}`]: { eventId: 'bodega', status: 'active', edition: 'vacay' },
});

const fakeTimestamp = (ms: number) => ({ toMillis: () => ms });

const mintDeps = (fake: FakeDb, overrides: Partial<MintDeps> = {}): MintDeps => ({
  db: fake.db,
  now: () => T0,
  timestamp: fakeTimestamp,
  policy: { allowLocalDev: false },
  mintCode: () => CODE,
  ...overrides,
});

const exchangeDeps = (fake: FakeDb, overrides: Partial<ExchangeDeps> = {}): ExchangeDeps => ({
  db: fake.db,
  now: () => T0 + 1_000,
  timestamp: fakeTimestamp,
  createCustomToken: async (uid: string) => `custom-token-for:${uid}`,
  ...overrides,
});

/** Seed a mintable, unconsumed record the way `mintHandoff` writes it. */
function seedHandoff(over: Partial<HandoffRecordInput> = {}) {
  return {
    [handoffPath(CODE)]: buildHandoffRecord({
      uid: UID,
      targetOrigin: ORIGIN,
      transactionId: transactionIdFor(VERIFIER),
      eventId: 'bodega',
      issuedAt: T0,
      expiresAt: T0 + HANDOFF_TTL_MS,
      timestamp: fakeTimestamp,
      ...over,
    }),
  };
}

// --- The harness's own guard ----------------------------------------------------

describe('the in-memory transaction fake', () => {
  it('re-runs the callback when a document it read was written in between', async () => {
    const fake = makeDb({ 'x/y': { n: 0 } });
    const ref = fake.db.doc('x/y');
    let attempts = 0;

    fake.hooks.beforeCommit = async () => {
      attempts += 1;
      // Interfere exactly once, after the first attempt has already read.
      if (attempts === 1) fake.docs.set('x/y', { data: { n: 99 }, version: 1 });
    };

    const seen = await fake.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const n = snap.data()?.n;
      tx.update(ref, { touched: true });
      return n;
    });

    // The first attempt read 0 and was discarded; the retry read the interloper's
    // value. Without conflict detection this would still be 0 — which is what
    // would make the concurrent-exchange test below meaningless.
    expect(attempts).toBe(2);
    expect(seen).toBe(99);
  });
});

// --- Mint -----------------------------------------------------------------------

describe('mintHandoff', () => {
  it('mints a code bound to the caller and returns a server-built handoff URL', async () => {
    const fake = makeDb(activeHost());
    const result = await mintHandoff(
      { uid: UID, targetOrigin: ORIGIN, transactionId: transactionIdFor(VERIFIER) },
      mintDeps(fake),
    );

    expect(result).toMatchObject({
      ok: true,
      targetOrigin: ORIGIN,
      expiresAt: T0 + HANDOFF_TTL_MS,
      handoffUrl: `${ORIGIN}/#${HANDOFF_FRAGMENT_KEY}=${CODE}`,
    });

    const stored = fake.docs.get(handoffPath(CODE));
    expect(stored?.data).toMatchObject({
      uid: UID,
      targetOrigin: ORIGIN,
      transactionId: transactionIdFor(VERIFIER),
      eventId: 'bodega',
      consumedAt: null,
    });
  });

  it('stores the code under its hash, never under the code itself', async () => {
    const fake = makeDb(activeHost());
    await mintHandoff(
      { uid: UID, targetOrigin: ORIGIN, transactionId: transactionIdFor(VERIFIER) },
      mintDeps(fake),
    );

    expect(fake.docs.has(`authHandoffs/${CODE}`)).toBe(false);
    expect(fake.docs.has(handoffPath(CODE))).toBe(true);
    // Nor does the raw code appear anywhere in the stored document.
    expect(JSON.stringify([...fake.docs.values()])).not.toContain(CODE);
  });

  it('puts the code in the fragment and no token of any kind in the URL', async () => {
    const fake = makeDb(activeHost());
    const result = await mintHandoff(
      { uid: UID, targetOrigin: ORIGIN, transactionId: transactionIdFor(VERIFIER) },
      mintDeps(fake),
    );
    if (!result.ok) throw new Error('expected a mint');

    const url = new URL(result.handoffUrl);
    // ADR 0010's hard line: nothing token-shaped in the query, and the code
    // itself only ever in the fragment, which no server ever receives.
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#${HANDOFF_FRAGMENT_KEY}=${CODE}`);
    expect(result.handoffUrl).not.toContain('idToken');
    expect(result.handoffUrl).not.toContain('customToken');
    expect(result.handoffUrl).not.toContain('refreshToken');
  });

  it('refuses an unauthenticated caller before touching Firestore', async () => {
    const fake = makeDb(activeHost());
    const result = await mintHandoff(
      { uid: undefined, targetOrigin: ORIGIN, transactionId: transactionIdFor(VERIFIER) },
      mintDeps(fake),
    );

    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(fake.reads.count).toBe(0);
  });

  it('rejects an unrecognised slug — no hostname document, no handoff', async () => {
    const fake = makeDb(activeHost());
    const result = await mintHandoff(
      {
        uid: UID,
        targetOrigin: 'https://never-registered.fiveacross.app',
        transactionId: transactionIdFor(VERIFIER),
      },
      mintDeps(fake),
    );

    expect(result).toEqual({ ok: false, reason: 'origin-not-allowed' });
    expect(fake.docs.has(handoffPath(CODE))).toBe(false);
  });

  it('rejects a registered hostname that is not active', async () => {
    for (const status of ['disabled', 'archived', undefined]) {
      const fake = makeDb({ [`hostnames/${HOST}`]: { eventId: 'bodega', status } });
      const result = await mintHandoff(
        { uid: UID, targetOrigin: ORIGIN, transactionId: transactionIdFor(VERIFIER) },
        mintDeps(fake),
      );
      expect(result).toEqual({ ok: false, reason: 'origin-not-allowed' });
    }
  });

  it.each([
    ['a bare domain', 'evil.test'],
    ['plain http', 'http://bodega-bay.fiveacross.app'],
    ['a trailing slash', 'https://bodega-bay.fiveacross.app/'],
    ['a path', 'https://bodega-bay.fiveacross.app/board'],
    ['a query', 'https://bodega-bay.fiveacross.app?next=x'],
    ['embedded credentials', 'https://bodega-bay.fiveacross.app@evil.test'],
    ['an explicit port', 'https://bodega-bay.fiveacross.app:8443'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a data scheme', 'data:text/html,x'],
    ['mixed case', 'https://Bodega-Bay.FiveAcross.app'],
    ['a non-string', 42],
  ])('rejects %s as a target origin', async (_label, origin) => {
    const fake = makeDb(activeHost());
    const result = await mintHandoff(
      { uid: UID, targetOrigin: origin, transactionId: transactionIdFor(VERIFIER) },
      mintDeps(fake),
    );

    expect(result.ok).toBe(false);
    expect(fake.docs.has(handoffPath(CODE))).toBe(false);
  });

  it('allows a loopback origin only when pointed at an emulator', async () => {
    const denied = makeDb();
    expect(
      await mintHandoff(
        {
          uid: UID,
          targetOrigin: 'http://localhost:5173',
          transactionId: transactionIdFor(VERIFIER),
        },
        mintDeps(denied),
      ),
    ).toEqual({ ok: false, reason: 'origin-not-allowed' });

    const allowed = makeDb();
    expect(
      await mintHandoff(
        {
          uid: UID,
          targetOrigin: 'http://localhost:5173',
          transactionId: transactionIdFor(VERIFIER),
        },
        mintDeps(allowed, { policy: { allowLocalDev: true } }),
      ),
    ).toMatchObject({ ok: true, targetOrigin: 'http://localhost:5173' });
  });

  it.each([['too short', 'abc'], ['wrong alphabet', '+'.repeat(43)], ['absent', undefined]])(
    'rejects a %s transaction id',
    async (_label, transactionId) => {
      const fake = makeDb(activeHost());
      const result = await mintHandoff(
        { uid: UID, targetOrigin: ORIGIN, transactionId },
        mintDeps(fake),
      );
      expect(result).toEqual({ ok: false, reason: 'invalid-transaction-id' });
    },
  );

  it('preserves a deep-link return path', async () => {
    const fake = makeDb(activeHost());
    const result = await mintHandoff(
      {
        uid: UID,
        targetOrigin: ORIGIN,
        transactionId: transactionIdFor(VERIFIER),
        returnPath: '/board?day=2',
      },
      mintDeps(fake),
    );

    expect(result).toMatchObject({
      ok: true,
      handoffUrl: `${ORIGIN}/board?day=2#${HANDOFF_FRAGMENT_KEY}=${CODE}`,
    });
  });

  it.each([
    ['protocol-relative', '//evil.test'],
    ['backslash protocol-relative', '/\\evil.test'],
    ['an absolute URL', 'https://evil.test/steal'],
    ['a scheme-relative absolute', 'https:/evil.test'],
    ['a bare path with no leading slash', 'board'],
    ['a caller-supplied fragment', '/board#fa_handoff=stolen'],
    ['a CRLF injection', '/board\r\nX-Evil: 1'],
    ['an over-long path', `/${'a'.repeat(600)}`],
    ['a non-string', 7],
  ])('rejects %s as a return path — the open-redirect surface', async (_label, returnPath) => {
    expect(validateReturnPath(returnPath, ORIGIN)).toBeNull();

    const fake = makeDb(activeHost());
    const result = await mintHandoff(
      { uid: UID, targetOrigin: ORIGIN, transactionId: transactionIdFor(VERIFIER), returnPath },
      mintDeps(fake),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-return-path' });
    expect(fake.docs.has(handoffPath(CODE))).toBe(false);
  });

  it('defaults an absent return path to the root', () => {
    expect(validateReturnPath(undefined, ORIGIN)).toBe('/');
    expect(validateReturnPath(null, ORIGIN)).toBe('/');
  });
});

// --- Exchange -------------------------------------------------------------------

describe('exchangeHandoff', () => {
  it('redeems a valid code once and consumes it in the same transaction', async () => {
    const fake = makeDb(seedHandoff());
    const result = await exchangeHandoff(
      { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN, headerOrigin: ORIGIN },
      exchangeDeps(fake),
    );

    expect(result).toEqual({ ok: true, customToken: `custom-token-for:${UID}`, uid: UID });
    expect(fake.docs.get(handoffPath(CODE))?.data.consumedAt).not.toBeNull();
  });

  it('rejects a replayed code', async () => {
    const fake = makeDb(seedHandoff());
    const deps = exchangeDeps(fake);
    const payload = { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN };

    expect(await exchangeHandoff(payload, deps)).toMatchObject({ ok: true });
    expect(await exchangeHandoff(payload, deps)).toEqual({ ok: false, reason: 'replayed' });
    expect(await exchangeHandoff(payload, deps)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('rejects an expired code, using the server clock and not the caller', async () => {
    const fake = makeDb(seedHandoff());
    const result = await exchangeHandoff(
      { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN },
      exchangeDeps(fake, { now: () => T0 + HANDOFF_TTL_MS }),
    );

    expect(result).toEqual({ ok: false, reason: 'expired' });
    // An expired code is not consumed — there was nothing to consume — but it is
    // also never redeemable again, because the deadline is in the document.
    expect(fake.docs.get(handoffPath(CODE))?.data.consumedAt).toBeNull();
  });

  it('treats an unreadable expiry as expired rather than as never expiring', async () => {
    const fake = makeDb(seedHandoff({ timestamp: () => 'not-a-timestamp' }));
    expect(
      await exchangeHandoff(
        { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN },
        exchangeDeps(fake),
      ),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects redemption from an origin the code was not minted for', async () => {
    const fake = makeDb(seedHandoff());
    const result = await exchangeHandoff(
      {
        code: CODE,
        transactionVerifier: VERIFIER,
        origin: OTHER_ORIGIN,
        headerOrigin: OTHER_ORIGIN,
      },
      exchangeDeps(fake),
    );

    expect(result).toEqual({ ok: false, reason: 'origin-mismatch' });
    // Crucially the code survives: a wrong-origin attempt must not burn a code
    // the rightful origin is still about to redeem.
    expect(fake.docs.get(handoffPath(CODE))?.data.consumedAt).toBeNull();
  });

  it('rejects a claimed origin that disagrees with the Origin header', async () => {
    const fake = makeDb(seedHandoff());
    const result = await exchangeHandoff(
      { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN, headerOrigin: OTHER_ORIGIN },
      exchangeDeps(fake),
    );

    expect(result).toEqual({ ok: false, reason: 'origin-mismatch' });
    expect(fake.reads.count).toBe(0);
  });

  it('redeems when the transport supplied no Origin header at all', async () => {
    const fake = makeDb(seedHandoff());
    expect(
      await exchangeHandoff(
        { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN, headerOrigin: null },
        exchangeDeps(fake),
      ),
    ).toMatchObject({ ok: true });
  });

  it('rejects the right code with the wrong transaction verifier', async () => {
    const fake = makeDb(seedHandoff());
    const result = await exchangeHandoff(
      { code: CODE, transactionVerifier: token('stolen-'), origin: ORIGIN },
      exchangeDeps(fake),
    );

    // The whole point of the PKCE binding: holding the code is not enough.
    expect(result).toEqual({ ok: false, reason: 'transaction-mismatch' });
    expect(fake.docs.get(handoffPath(CODE))?.data.consumedAt).toBeNull();
  });

  it('rejects a code that was never minted', async () => {
    const fake = makeDb(seedHandoff());
    expect(
      await exchangeHandoff(
        { code: token('unknown-'), transactionVerifier: VERIFIER, origin: ORIGIN },
        exchangeDeps(fake),
      ),
    ).toEqual({ ok: false, reason: 'unknown-code' });
  });

  it.each([
    ['a malformed code', { code: 'short', transactionVerifier: VERIFIER, origin: ORIGIN }],
    ['a malformed verifier', { code: CODE, transactionVerifier: '!', origin: ORIGIN }],
    ['a malformed origin', { code: CODE, transactionVerifier: VERIFIER, origin: 'nonsense' }],
  ])('rejects %s without a single Firestore read', async (_label, payload) => {
    const fake = makeDb(seedHandoff());
    const result = await exchangeHandoff(payload, exchangeDeps(fake));

    expect(result.ok).toBe(false);
    expect(fake.reads.count).toBe(0);
  });

  it('refuses a disabled account and still burns the code', async () => {
    const fake = makeDb(seedHandoff());
    const result = await exchangeHandoff(
      { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN },
      exchangeDeps(fake, { isAccountUsable: async () => false }),
    );

    expect(result).toEqual({ ok: false, reason: 'account-unusable' });
    // Consume commits before the token is minted, deliberately: the code is
    // spent even though no token came back.
    expect(fake.docs.get(handoffPath(CODE))?.data.consumedAt).not.toBeNull();
  });

  it('rejects the loser of two concurrent exchanges of the same code', async () => {
    const fake = makeDb(seedHandoff());

    // Hold both transactions until each has read, so they genuinely race rather
    // than running one after the other.
    let arrivals = 0;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.hooks.beforeCommit = async () => {
      arrivals += 1;
      if (arrivals >= 2) open();
      await gate;
    };

    const payload = { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN };
    const outcomes = await Promise.all([
      exchangeHandoff(payload, exchangeDeps(fake)),
      exchangeHandoff(payload, exchangeDeps(fake)),
    ]);

    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'replayed' }]);
  });

  it('mints and redeems end to end, then refuses the replay', async () => {
    const fake = makeDb(activeHost());
    const minted = await mintHandoff(
      {
        uid: UID,
        targetOrigin: ORIGIN,
        transactionId: transactionIdFor(VERIFIER),
        returnPath: '/board',
      },
      mintDeps(fake, { mintCode: undefined }),
    );
    if (!minted.ok) throw new Error('expected a mint');

    // The client reads the code back out of the fragment, exactly as #549 will.
    const code = new URL(minted.handoffUrl).hash.split('=')[1];
    const payload = { code, transactionVerifier: VERIFIER, origin: ORIGIN };

    expect(await exchangeHandoff(payload, exchangeDeps(fake))).toMatchObject({
      ok: true,
      uid: UID,
    });
    expect(await exchangeHandoff(payload, exchangeDeps(fake))).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });
});
