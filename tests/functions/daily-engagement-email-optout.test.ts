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

function makeDb(seed: Docs = {}): EmailPrefsFirestore & { docs: Docs } {
  const docs: Docs = { ...seed };
  return {
    docs,
    doc: (path: string) => ({
      get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
      set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
        docs[path] = options?.merge ? { ...(docs[path] ?? {}), ...data } : { ...data };
        return undefined;
      },
      // Admin-SDK `create` semantics: refuses when the document already exists.
      create: async (data: Record<string, unknown>) => {
        if (docs[path] !== undefined) throw new Error('ALREADY_EXISTS');
        docs[path] = { ...data };
        return undefined;
      },
    }),
  };
}

/** A Firestore stand-in whose every operation fails — the degraded-backend case
 *  that must never produce an email with a dead unsubscribe link. */
const brokenDb = (): EmailPrefsFirestore => ({
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
    expect(await applyOptOut(db, 'e', 'u', 'good', true, { now: () => 9 })).toBe('updated');
    expect(db.docs[emailPrefsPath('e', 'u')]).toMatchObject({ optedOut: true, token: 'good', updatedAt: 9 });
  });

  it('reverses to opted-in on the same token, so a mistake is self-service', async () => {
    const db = makeDb({ [emailPrefsPath('e', 'u')]: { token: 'good', optedOut: true } });
    expect(await applyOptOut(db, 'e', 'u', 'good', false)).toBe('updated');
    expect(db.docs[emailPrefsPath('e', 'u')]).toMatchObject({ optedOut: false });
  });

  it('answers the same "invalid" for a wrong token and for a uid that has no doc', async () => {
    // Identical answers on purpose: the endpoint must not double as a way to
    // enumerate which uids are participants in an Event.
    expect(await applyOptOut(seeded(), 'e', 'u', 'wrong', true)).toBe('invalid');
    expect(await applyOptOut(seeded(), 'e', 'nobody', 'good', true)).toBe('invalid');
    expect(await applyOptOut(seeded(), 'e', 'u', '', true)).toBe('invalid');
  });

  it('leaves the stored state untouched when the token is wrong', async () => {
    const db = seeded();
    await applyOptOut(db, 'e', 'u', 'wrong', true);
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

  it('resubscribes on the preferences action, so an accidental opt-out is reversible', async () => {
    const db = makeDb({ [emailPrefsPath('med-2026', 'theo')]: { token: 'good', optedOut: true } });
    const res = makeRes();
    await handleUnsubscribeRequest(db, { method: 'POST', query: query({ a: 'resubscribe' }) }, res);
    expect(res.body).toContain('You&#39;re back on the list');
    expect(db.docs[emailPrefsPath('med-2026', 'theo')]).toMatchObject({ optedOut: false });
  });

  it('offers the turn-them-back-on path from the confirmation page', async () => {
    const res = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: query() }, res);
    expect(res.body).toContain('a=resubscribe');
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
    // throws out of the call — and answers the same "invalid" a bad token gets,
    // because a read failure cannot be distinguished from one.
    const broken = makeRes();
    await expect(
      handleUnsubscribeRequest(brokenDb(), { method: 'POST', query: query() }, broken),
    ).resolves.toBeUndefined();
    expect(broken.code).toBe(404);
  });

  it('preserves a router parameter from the endpoint URL in the form action and links', async () => {
    // `EMAIL_UNSUBSCRIBE_URL` may carry its own query (a rewrite or router
    // selects the endpoint with it). A form action of `?e=…&u=…&t=…&a=…`
    // replaces the whole query, so the emailed GET would work and the POST
    // would go nowhere (Codex #623 P2).
    const res = makeRes();
    await handleUnsubscribeRequest(seeded(), { method: 'GET', query: { ...query(), fn: 'unsub' } }, res);
    expect(res.body).toContain('action="?fn=unsub&amp;e=med-2026&amp;u=theo&amp;t=good&amp;a=unsubscribe"');
    expect(res.body).toContain('fn=unsub&amp;e=med-2026&amp;u=theo&amp;t=good&amp;a=resubscribe');
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
    // form action and the href.
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
