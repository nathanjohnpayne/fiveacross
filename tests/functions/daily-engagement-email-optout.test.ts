import { describe, it, expect } from 'vitest';
import {
  applyOptOut,
  emailPrefsPath,
  ensureEmailPrefs,
  handleUnsubscribeRequest,
  listUnsubscribeHeaders,
  markDailyEmailSent,
  preferencesLink,
  readEmailPrefs,
  readEmailPrefsOutcome,
  tokenMatches,
  unsubscribeLink,
  type EmailPrefsFirestore,
  type UnsubResponse,
} from '../../functions/src/emailOptOut';

// Covers specs/daily-engagement-email.md § Consent, functions layer: the durable
// per-user opt-out store and the unsubscribe endpoint's core. Pure + DI — no
// Functions runtime, no live Firestore.

type Docs = Record<string, Record<string, unknown>>;

/**
 * A deliberately faithful mini-transaction: it records the version of every
 * document READ, buffers writes, and on commit re-runs the whole function if
 * any of those versions moved. A fake that just applied the writes would let
 * the concurrency test below pass against the very bug it exists to catch.
 */
function makeDb(seed: Docs = {}): EmailPrefsFirestore & { docs: Docs; onTxRead?: (path: string) => void } {
  const docs: Docs = { ...seed };
  const versions: Record<string, number> = {};
  const bump = (path: string) => {
    versions[path] = (versions[path] ?? 0) + 1;
  };
  const self = {
    docs,
    /** Test hook: fires inside a transaction's read, the window a competing
     *  writer would land in. */
    onTxRead: undefined as ((path: string) => void) | undefined,
    runTransaction: async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const readVersions: Record<string, number> = {};
        const writes: Array<[string, Record<string, unknown>, boolean]> = [];
        const tx = {
          get: async (ref: { path: string }) => {
            // Snapshot version AND data first, then let a competing writer in.
            // The transaction therefore reads genuinely STALE data and is
            // forced through the retry, which is the behaviour under test — a
            // fake that read after the write would pass without ever retrying.
            readVersions[ref.path] = versions[ref.path] ?? 0;
            const at = docs[ref.path] === undefined ? undefined : { ...docs[ref.path] };
            self.onTxRead?.(ref.path);
            return { exists: at !== undefined, data: () => at };
          },
          set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
            writes.push([ref.path, data, options?.merge === true]);
          },
        };
        const result = await fn(tx as never);
        const stale = Object.entries(readVersions).some(([path, v]) => (versions[path] ?? 0) !== v);
        if (stale) continue; // contention — discard the buffered writes and retry
        for (const [path, data, merge] of writes) {
          docs[path] = merge ? { ...(docs[path] ?? {}), ...data } : { ...data };
          bump(path);
        }
        return result;
      }
      throw new Error('transaction retries exhausted');
    },
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
      set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
        docs[path] = options?.merge ? { ...(docs[path] ?? {}), ...data } : { ...data };
        bump(path);
        return undefined;
      },
      // Admin-SDK `create` semantics: refuses when the document already exists.
      create: async (data: Record<string, unknown>) => {
        if (docs[path] !== undefined) throw new Error('ALREADY_EXISTS');
        docs[path] = { ...data };
        bump(path);
        return undefined;
      },
    }),
  };
  return self;
}

/** A Firestore stand-in whose every operation fails — the degraded-backend case
 *  that must never produce an email with a dead unsubscribe link. */
const brokenDb = (): EmailPrefsFirestore => ({
  runTransaction: async () => {
    throw new Error('firestore unavailable');
  },
  doc: () => ({
    get: async () => {
      throw new Error('firestore unavailable');
    },
    set: async () => {
      throw new Error('firestore unavailable');
    },
    create: async () => {
      throw new Error('firestore unavailable');
    },
  }),
});

/** A store whose READ fails but whose writes succeed — the exact shape that
 *  used to resurrect an opted-out participant (Codex #623 P1). */
const readBrokenDb = (seed: Docs): EmailPrefsFirestore & { docs: Docs } => {
  const inner = makeDb(seed);
  return {
    docs: inner.docs,
    runTransaction: inner.runTransaction,
    doc: (path: string) => ({
      ...inner.doc(path),
      get: async () => {
        throw new Error('transient read failure');
      },
    }),
  };
};

/** Minimal response recorder shaped like the Express response `onRequest` hands
 *  the endpoint. */
function makeRes(): UnsubResponse & { code: number; headers: Record<string, string>; body: string } {
  const res = {
    code: 0,
    headers: {} as Record<string, string>,
    body: '',
    status(code: number) {
      res.code = code;
      return res;
    },
    set(field: string, value: string) {
      res.headers[field] = value;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const LINK = { baseUrl: 'https://fn.example.com/emailUnsubscribe', eventId: 'med-2026', uid: 'theo', token: 'tok' };

// --- Storage --------------------------------------------------------------------

describe('the opt-out store', () => {
  it('mints an opted-IN doc with a token on first contact, and reuses it after', async () => {
    const db = makeDb();
    const first = await ensureEmailPrefs(db, 'med-2026', 'theo', { mintToken: () => 'tok-1', now: () => 42 });
    expect(first).toEqual({ optedOut: false, token: 'tok-1' });
    expect(db.docs[emailPrefsPath('med-2026', 'theo')]).toMatchObject({
      optedOut: false,
      token: 'tok-1',
      createdAt: 42,
    });
    const second = await ensureEmailPrefs(db, 'med-2026', 'theo', { mintToken: () => 'tok-2' });
    expect(second?.token).toBe('tok-1'); // never re-minted — that would break live links
  });

  it('mints a token with real entropy when none is injected', async () => {
    const a = await ensureEmailPrefs(makeDb(), 'e', 'u');
    const b = await ensureEmailPrefs(makeDb(), 'e', 'u');
    expect(a?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.token).not.toBe(b?.token);
  });

  it('returns null rather than a token-less pref when the backend is down', async () => {
    expect(await ensureEmailPrefs(brokenDb(), 'e', 'u')).toBeNull();
    expect(await readEmailPrefs(brokenDb(), 'e', 'u')).toBeNull();
  });

  it('treats a doc with no token as unusable — it could not authorize an unsubscribe', async () => {
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { optedOut: true } });
    expect(await readEmailPrefs(db, 'e', 'u')).toBeNull();
    // …but NOT as absent: the outcome reader still reports it as present, which
    // is what stops the mint path from writing `optedOut: false` over it.
    expect(await readEmailPrefsOutcome(db, 'e', 'u')).toEqual({
      status: 'found',
      prefs: { optedOut: true, token: '', lastSentDayIndex: undefined },
    });
  });

  it('reports a read FAILURE separately from an absence (#623 P1)', async () => {
    expect(await readEmailPrefsOutcome(brokenDb(), 'e', 'u')).toEqual({ status: 'error' });
    expect(await readEmailPrefsOutcome(makeDb(), 'e', 'u')).toEqual({ status: 'absent' });
  });

  it('NEVER resurrects an opted-out participant when the read fails but the write would succeed', async () => {
    // The #623 P1 defect: a transient read error looked like "no document",
    // and the mint merged `optedOut: false` over a real opt-out.
    const db = readBrokenDb({ [emailPrefsPath('e', 'u')]: { optedOut: true, token: 'theirs' } });
    expect(await ensureEmailPrefs(db, 'e', 'u', { mintToken: () => 'fresh' })).toBeNull();
    expect(db.docs[emailPrefsPath('e', 'u')]).toEqual({ optedOut: true, token: 'theirs' });
  });

  it('mints with create, so a doc that appears mid-flight wins over this run', async () => {
    const db = makeDb();
    // The race: the FIRST read sees nothing, then a concurrent unsubscribe
    // lands the document, then this run's create refuses and it re-reads.
    const realDoc = db.doc;
    let firstRead = true;
    const raced: EmailPrefsFirestore = {
      runTransaction: db.runTransaction,
      doc: (path: string) => ({
        ...realDoc(path),
        get: async () => {
          if (firstRead) {
            firstRead = false;
            db.docs[emailPrefsPath('e', 'u')] = { optedOut: true, token: 'winner' };
            return { exists: false, data: () => undefined };
          }
          return realDoc(path).get();
        },
      }),
    };
    expect(await ensureEmailPrefs(raced, 'e', 'u', { mintToken: () => 'loser' })).toEqual({
      optedOut: true,
      token: 'winner',
    });
    expect(db.docs[emailPrefsPath('e', 'u')]).toEqual({ optedOut: true, token: 'winner' });
  });

  it('returns the PERSISTED token when a concurrent sweep back-fills first', async () => {
    // Phase 4b P2: an unconditional merge let two sweeps each write their own
    // token and each return their own. The loser then mailed a
    // `List-Unsubscribe` link carrying a token the endpoint rejects — an
    // unsubscribe that looks fine and silently does not work.
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { optedOut: false } });
    let raced = false;
    db.onTxRead = (path) => {
      if (raced) return;
      raced = true; // the competing sweep commits inside our read window
      db.doc(path).set({ token: 'winner', updatedAt: 1 }, { merge: true });
    };
    const prefs = await ensureEmailPrefs(db, 'e', 'u', { mintToken: () => 'loser', now: () => 2 });
    expect(raced).toBe(true); // the competing write really did land mid-read
    expect(prefs?.token).toBe('winner');
    // …and the store agrees, so the emailed link and the endpoint match.
    expect(db.docs[emailPrefsPath('e', 'u')].token).toBe('winner');
    expect(await readEmailPrefs(db, 'e', 'u')).toMatchObject({ token: 'winner' });
  });

  it('back-fills exactly one token when nothing else is writing', async () => {
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { optedOut: false } });
    const prefs = await ensureEmailPrefs(db, 'e', 'u', { mintToken: () => 'mine', now: () => 4 });
    expect(prefs?.token).toBe('mine');
    expect(db.docs[emailPrefsPath('e', 'u')]).toEqual({ optedOut: false, token: 'mine', updatedAt: 4 });
  });

  it('back-fills a token onto a doc that has none WITHOUT resetting its opt-out', async () => {
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { optedOut: true } });
    expect(await ensureEmailPrefs(db, 'e', 'u', { mintToken: () => 'new-token', now: () => 3 })).toEqual({
      optedOut: true,
      token: 'new-token',
      lastSentDayIndex: undefined,
    });
    expect(db.docs[emailPrefsPath('e', 'u')]).toMatchObject({ optedOut: true, token: 'new-token' });
  });

  it('reads a malformed lastSentDayIndex as absent rather than as a suppression', async () => {
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { token: 't', lastSentDayIndex: 'soon' } });
    expect(await readEmailPrefs(db, 'e', 'u')).toEqual({ optedOut: false, token: 't' });
  });

  it('stamps lastSentDayIndex without clobbering the token or the opt-out flag', async () => {
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { token: 't', optedOut: false } });
    await markDailyEmailSent(db, 'e', 'u', 3, { now: () => 7 });
    expect(db.docs[emailPrefsPath('e', 'u')]).toEqual({
      token: 't',
      optedOut: false,
      lastSentDayIndex: 3,
      updatedAt: 7,
    });
  });

  it('never throws when the marker write fails — the idempotency key covers the duplicate', async () => {
    await expect(markDailyEmailSent(brokenDb(), 'e', 'u', 1)).resolves.toBeUndefined();
  });
});

// --- Token verification ---------------------------------------------------------

describe('tokenMatches', () => {
  it('accepts only an exact match, and never throws on a length mismatch', () => {
    expect(tokenMatches('abcd', 'abcd')).toBe(true);
    expect(tokenMatches('abcd', 'abce')).toBe(false);
    expect(tokenMatches('abcd', 'abc')).toBe(false); // timingSafeEqual would THROW here
    expect(tokenMatches('abcd', '')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('abcd', undefined as unknown as string)).toBe(false);
  });
});

describe('applyOptOut', () => {
  const seeded = () => makeDb({ [emailPrefsPath('e', 'u')]: { token: 'good', optedOut: false } });

  it('records the opt-out when the capability token matches', async () => {
    const db = seeded();
    expect(await applyOptOut(db, 'e', 'u', 'good', { now: () => 9 })).toBe('updated');
    expect(db.docs[emailPrefsPath('e', 'u')]).toMatchObject({ optedOut: true, token: 'good', updatedAt: 9 });
  });

  it('is unsubscribe-only even when the stored record is already opted out', async () => {
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { token: 'good', optedOut: true } });
    expect(await applyOptOut(db, 'e', 'u', 'good')).toBe('updated');
    expect(db.docs[emailPrefsPath('e', 'u')]).toMatchObject({ optedOut: true });
  });

  it('answers "error", not "invalid", when the read FAILS — a 500 is retryable, a 404 is not', async () => {
    // Phase 4b P1: the convenience reader collapses missing and unreadable into
    // null, so a transient backend blip used to answer a permanent 404 and an
    // RFC 8058 one-click client would never retry.
    expect(await applyOptOut(brokenDb(), 'e', 'u', 'anything')).toBe('error');
  });

  it('still answers "invalid" for a CONFIRMED absence, so the two stay distinguishable', async () => {
    expect(await applyOptOut(makeDb(), 'e', 'u', 'anything')).toBe('invalid');
  });

  it('answers the same "invalid" for a wrong token and for a uid that has no doc', async () => {
    // Identical answers on purpose: the endpoint must not double as a way to
    // enumerate which uids are participants in an Event.
    expect(await applyOptOut(seeded(), 'e', 'u', 'wrong')).toBe('invalid');
    expect(await applyOptOut(seeded(), 'e', 'nobody', 'good')).toBe('invalid');
    expect(await applyOptOut(seeded(), 'e', 'u', '')).toBe('invalid');
  });

  it('rejects a request whose token was ROTATED between the read and the write', async () => {
    // Codex #623 P2: read → compare → write in three steps let a request
    // bearing the OLD token land its write on the newly-secured document,
    // defeating the field-write revocation this module documents. Inside a
    // transaction the rotation forces a retry, and the retry sees the new token.
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { token: 'good', optedOut: false } });
    let rotated = false;
    db.onTxRead = (path) => {
      if (rotated) return;
      rotated = true; // the token is revoked inside our read window
      db.doc(path).set({ token: 'rotated' }, { merge: true });
    };
    expect(await applyOptOut(db, 'e', 'u', 'good')).toBe('invalid');
    expect(rotated).toBe(true);
    // The stale request changed nothing on the secured document.
    expect(db.docs[emailPrefsPath('e', 'u')]).toMatchObject({ token: 'rotated', optedOut: false });
  });

  it('still applies cleanly when nothing races the write', async () => {
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { token: 'good', optedOut: false } });
    expect(await applyOptOut(db, 'e', 'u', 'good', { now: () => 11 })).toBe('updated');
    expect(db.docs[emailPrefsPath('e', 'u')]).toEqual({ token: 'good', optedOut: true, updatedAt: 11 });
  });

  it('leaves the stored state untouched when the token is wrong', async () => {
    const db = seeded();
    await applyOptOut(db, 'e', 'u', 'wrong');
    expect(db.docs[emailPrefsPath('e', 'u')]).toEqual({ token: 'good', optedOut: false });
  });
});

// --- Links and headers ----------------------------------------------------------

describe('unsubscribe links and RFC 8058 headers', () => {
  it('builds an unambiguous link for each action', () => {
    expect(unsubscribeLink(LINK)).toBe(
      'https://fn.example.com/emailUnsubscribe?e=med-2026&u=theo&t=tok&a=unsubscribe',
    );
    expect(preferencesLink(LINK)).toBe(
      'https://fn.example.com/emailUnsubscribe?e=med-2026&u=theo&t=tok&a=preferences',
    );
  });

  it('appends to a base URL that already carries a query string', () => {
    expect(unsubscribeLink({ ...LINK, baseUrl: 'https://h/api?fn=unsub' })).toContain('?fn=unsub&e=med-2026');
  });

  it('URL-encodes ids rather than emitting them raw', () => {
    expect(unsubscribeLink({ ...LINK, eventId: 'a b&c' })).toContain('e=a+b%26c');
  });

  it('emits the pair that makes a client show its own one-click control', () => {
    expect(listUnsubscribeHeaders('https://h/u?t=1')).toEqual({
      'List-Unsubscribe': '<https://h/u?t=1>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});

// --- The endpoint ---------------------------------------------------------------

describe('handleUnsubscribeRequest', () => {
  const seeded = () => makeDb({ [emailPrefsPath('med-2026', 'theo')]: { token: 'good', optedOut: false } });
  const query = (over: Record<string, string> = {}) => ({ e: 'med-2026', u: 'theo', t: 'good', ...over });

  it('CONFIRMS on GET instead of acting — a link scanner must not unsubscribe anyone', async () => {
    const db = seeded();
    const res = makeRes();
    await handleUnsubscribeRequest(db, { method: 'GET', query: query() }, res);
    expect(res.code).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain('<form method="POST"');
    expect(res.body).toContain('Stop these emails');
    // The state is untouched: nothing happened but a page render.
    expect(db.docs[emailPrefsPath('med-2026', 'theo')]).toEqual({ token: 'good', optedOut: false });
  });

  it('ACTS on POST — the method RFC 8058 one-click sends', async () => {
    const db = seeded();
    const res = makeRes();
    await handleUnsubscribeRequest(db, { method: 'POST', query: query() }, res, { now: () => 5 });
    expect(res.code).toBe(200);
    expect(res.body).toContain('Unsubscribed');
    expect(db.docs[emailPrefsPath('med-2026', 'theo')]).toMatchObject({ optedOut: true });
  });

  it('refuses anonymous re-subscribe so a leaked old email cannot reverse an opt-out', async () => {
    const db = makeDb({ [emailPrefsPath('med-2026', 'theo')]: { token: 'good', optedOut: true } });
    const res = makeRes();
    await handleUnsubscribeRequest(db, { method: 'POST', query: query({ a: 'resubscribe' }) }, res);
    expect(res.code).toBe(400);
    expect(res.body).not.toContain('back on the list');
    expect(db.docs[emailPrefsPath('med-2026', 'theo')]).toMatchObject({ optedOut: true });
  });

  it('does not expose a bearer-token path that can turn email back on', async () => {
    const res = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: query() }, res);
    expect(res.body).not.toContain('a=resubscribe');
    expect(res.body).not.toContain('Turn them back on');
  });

  it('reveals nothing about token validity on the GET, only on the POST', async () => {
    const good = makeRes();
    const bad = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: query() }, good);
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: query({ t: 'wrong' }) }, bad);
    expect(bad.code).toBe(good.code);
    expect(bad.body.replace(/t=wrong/g, 't=good')).toBe(good.body);
  });

  it('rejects a bad token and a missing parameter distinctly from a server fault', async () => {
    const bad = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'POST', query: query({ t: 'wrong' }) }, bad);
    expect(bad.code).toBe(404);
    expect(bad.body).toContain('no longer valid');

    const incomplete = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'POST', query: { e: 'med-2026' } }, incomplete);
    expect(incomplete.code).toBe(400);

    // A degraded backend resolves rather than rejecting — the endpoint never
    // throws out of the call — and answers a RETRYABLE 500 rather than the
    // permanent 404 a confirmed bad token gets (Phase 4b P1).
    const broken = makeRes();
    await expect(
      handleUnsubscribeRequest(brokenDb(), { method: 'POST', query: query() }, broken),
    ).resolves.toBeUndefined();
    expect(broken.code).toBe(500);
    expect(broken.body).toContain('try that link again');
  });

  it('preserves a router parameter from the endpoint URL in the form action', async () => {
    // `EMAIL_UNSUBSCRIBE_URL` may carry its own query (a rewrite or router
    // selects the endpoint with it). A form action of `?e=…&u=…&t=…&a=…`
    // replaces the whole query, so the emailed GET would work and the POST
    // would go nowhere (Codex #623 P2).
    const res = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: { ...query(), fn: 'unsub' } }, res);
    expect(res.body).toContain('action="?fn=unsub&amp;e=med-2026&amp;u=theo&amp;t=good&amp;a=unsubscribe"');
  });

  it('does not duplicate its own parameters when passing extras through', async () => {
    const res = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: query({ a: 'unsubscribe' }) }, res);
    expect((res.body.match(/a=unsubscribe/g) ?? []).length).toBe(1);
  });

  it('refuses a method it does not implement', async () => {
    const res = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'DELETE', query: query() }, res);
    expect(res.code).toBe(405);
  });

  it('never echoes a hostile parameter back into the confirmation form as markup', async () => {
    const res = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: query({ u: '"><script>x</script>' }) }, res);
    // Two layers, both load-bearing: URLSearchParams percent-encodes the value
    // into the query string, and the query string is then HTML-escaped into the
    // form action.
    expect(res.body).not.toContain('<script>x</script>');
    expect(res.body).not.toContain('"><script');
    expect(res.body).toContain('%3Cscript%3E');
    expect(res.body).toContain('&amp;');
  });

  it('escapes a page title that carries markup characters', async () => {
    const res = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: query() }, res);
    // The page's own copy carries an apostrophe; it must arrive escaped, not raw.
    expect(res.body).toContain('<title>Unsubscribe</title>');
    expect(res.body).not.toContain('font-family:"');
  });

  it('ignores a non-string query value instead of coercing it', async () => {
    const res = makeRes();
    await handleUnsubscribeRequest(
      seeded(),
      { method: 'POST', query: { e: 'med-2026', u: ['theo', 'other'], t: 'good' } },
      res,
    );
    expect(res.code).toBe(400);
  });
});
