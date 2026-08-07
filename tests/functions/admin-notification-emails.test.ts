// specs/admin-notification-emails.md (#638) — the admin notification digest.
//
// Three layers, each testable on its own because every one of them is pure or
// dependency-injected: what earns an alert (`alertsForWrite`), what the digest
// SAYS (`buildAdminDigestModel` / `reviewDetail` / `currentThemeDay`), and how
// it is DELIVERED (`sendAdminDigestForEvent` / `runAdminAlertSweep`) against a
// fake Firestore. No Functions runtime, no emulator, no live Resend key.
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_ALERTS_PER_DIGEST,
  alertsForWrite,
  enqueueAdminAlerts,
  recordAdminAlerts,
  runAdminAlertSweep,
  sendAdminDigestForEvent,
  type AdminAlertFirestore,
  type AlertableDoc,
} from '../../functions/src/adminAlerts';
import {
  ROWS_PER_SECTION,
  buildAdminDigestModel,
  currentThemeDay,
  renderAdminDigestHtml,
  renderAdminDigestText,
  reviewDetail,
  type AdminAlertRecord,
} from '../../functions/src/adminAlertDigest';
import { EMAIL_THEME_TOKENS } from '../../functions/src/dailyEmailTheme';

// --- A minimal in-memory Firestore ----------------------------------------------
//
// Only the operations the queue and its sweep use: `collection(path).add`, an
// equality-filtered `.limit().get()`, `doc(path).get()` and a merging
// `doc(path).set()`. Paths are flat string keys, which is all the module needs —
// it never walks a hierarchy.

interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}

function fakeDb(
  seed: Record<string, Record<string, unknown>[]> = {},
  docs: Record<string, Record<string, unknown>> = {},
  /** Collection paths whose `.get()` rejects — the injectable backend failure. */
  throwOn: readonly string[] = [],
) {
  const collections = new Map<string, FakeDoc[]>();
  let autoId = 0;
  for (const [path, rows] of Object.entries(seed)) {
    collections.set(
      path,
      rows.map((data, i) => ({ id: (data.id as string) ?? `a${i + 1}`, data: { ...data } })),
    );
  }
  const singles = new Map<string, Record<string, unknown>>(Object.entries(docs));

  const makeQuery = (path: string, filters: Array<[string, unknown]>, cap: number | null) => {
    const query = {
      where: (field: string, _op: string, value: unknown) =>
        makeQuery(path, [...filters, [field, value]], cap),
      limit: (count: number) => makeQuery(path, filters, count),
      get: async () => {
        if (throwOn.includes(path)) throw new Error(`backend unavailable: ${path}`);
        let rows = collections.get(path) ?? [];
        for (const [field, value] of filters) {
          rows = rows.filter((row) => (row.data[field] ?? null) === value);
        }
        if (cap !== null) rows = rows.slice(0, cap);
        return { docs: rows.map((row) => ({ id: row.id, data: () => ({ ...row.data }) })) };
      },
      add: async (data: Record<string, unknown>) => {
        const id = `auto${++autoId}`;
        const rows = collections.get(path) ?? [];
        rows.push({ id, data: { ...data } });
        collections.set(path, rows);
        return { id };
      },
    };
    return query;
  };

  const db = {
    collection: (path: string) => makeQuery(path, [], null),
    doc: (path: string) => ({
      get: async () => {
        const single = singles.get(path);
        if (single) return { data: () => ({ ...single }) };
        // A document inside a seeded collection, addressed directly.
        const slash = path.lastIndexOf('/');
        const rows = collections.get(path.slice(0, slash)) ?? [];
        const found = rows.find((r) => r.id === path.slice(slash + 1));
        return { data: () => (found ? { ...found.data } : undefined) };
      },
      set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
        const slash = path.lastIndexOf('/');
        const collectionPath = path.slice(0, slash);
        const id = path.slice(slash + 1);
        const rows = collections.get(collectionPath) ?? [];
        const found = rows.find((r) => r.id === id);
        if (found) found.data = options?.merge ? { ...found.data, ...data } : { ...data };
        else rows.push({ id, data: { ...data } });
        collections.set(collectionPath, rows);
        return undefined;
      },
    }),
    /** Test-only reader. */
    rows: (path: string) => (collections.get(path) ?? []).map((r) => ({ id: r.id, ...r.data })),
  };
  return db as unknown as AdminAlertFirestore & { rows: (path: string) => Record<string, unknown>[] };
}

const ITEM = (over: Partial<AlertableDoc> = {}): AlertableDoc => ({
  status: 'active',
  reportCount: 0,
  text: 'Spot a speedo at breakfast',
  ...over,
});

const ALERT = (over: Partial<AdminAlertRecord> = {}): AdminAlertRecord => ({
  id: 'a1',
  kind: 'content-reported',
  collection: 'items',
  docId: 'i1',
  label: 'Spot a speedo at breakfast',
  status: 'active',
  visionFlag: null,
  reportCount: 1,
  createdAt: 1_000,
  ...over,
});

const EVENT = {
  name: 'Trieste → Barcelona',
  days: [
    { index: 0, unlockAt: 1_000, theme: 'welcome-aboard' },
    { index: 1, unlockAt: 2_000, theme: 'sporty-splash' },
    { index: 2, unlockAt: 9_000, theme: 'revival-disco' },
  ],
  settings: { reportHideThreshold: 4 },
};

const NOW = 5_000;

// --- What earns an alert ---------------------------------------------------------

describe('alertsForWrite', () => {
  it('queues item-created for a player submission landing pending, and for nothing else on the items path', () => {
    // `addItem` (the player path) writes status: 'pending'.
    expect(alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' })).map((a) => a.kind)).toEqual([
      'item-created',
    ]);
    // `adminAddItem` and every seed write 'active' — an admin's own Prompt notifies nobody.
    expect(alertsForWrite('items', 'i1', undefined, ITEM({ status: 'active' }))).toEqual([]);
    // The admin's approval (pending → active) is not news; it IS the response.
    expect(alertsForWrite('items', 'i1', ITEM({ status: 'pending' }), ITEM({ status: 'active' }))).toEqual([]);
    // A same-status re-write of a pending Prompt does not re-queue it.
    expect(alertsForWrite('items', 'i1', ITEM({ status: 'pending' }), ITEM({ status: 'pending' }))).toEqual([]);
    // A delete leaves nothing to review.
    expect(alertsForWrite('items', 'i1', ITEM({ status: 'pending' }), undefined)).toEqual([]);
  });

  it('never queues item-created on the proofs path — a Proof has no approval queue', () => {
    expect(alertsForWrite('proofs', 'p1', undefined, { status: 'pending' })).toEqual([]);
  });

  it('queues content-reported only when reportCount strictly ROSE', () => {
    const kinds = (before: AlertableDoc | undefined, after: AlertableDoc) =>
      alertsForWrite('items', 'i1', before, after).map((a) => a.kind);
    // The explicit report action.
    expect(kinds(ITEM({ reportCount: 1 }), ITEM({ reportCount: 2 }))).toEqual(['content-reported']);
    // An admin Clear-reports is a FALL, not a rise.
    expect(kinds(ITEM({ reportCount: 5 }), ITEM({ reportCount: 0 }))).toEqual([]);
    // A restore leaves the count alone — `status` goes active, nothing rises.
    expect(kinds(ITEM({ status: 'hidden', reportCount: 5 }), ITEM({ status: 'active', reportCount: 5 }))).toEqual([]);
    // A create already carrying reports is a rise from zero.
    expect(kinds(undefined, ITEM({ reportCount: 2 }))).toEqual(['content-reported']);
  });

  it('queues moderation on a transition INTO flagged/hidden, including a create straight into one', () => {
    const kinds = (before: AlertableDoc | undefined, after: AlertableDoc) =>
      alertsForWrite('proofs', 'p1', before, after).map((a) => a.kind);
    expect(kinds({ status: 'active' }, { status: 'hidden' })).toEqual(['moderation']);
    // moderateProof's merge-set can create the doc already flagged (#101 Codex F2).
    expect(kinds(undefined, { status: 'flagged', visionFlag: 'violence' })).toEqual(['moderation']);
    // A same-status re-write, a restore, and a create into active are all quiet.
    expect(kinds({ status: 'hidden' }, { status: 'hidden' })).toEqual([]);
    expect(kinds({ status: 'hidden' }, { status: 'active' })).toEqual([]);
    expect(kinds(undefined, { status: 'active' })).toEqual([]);
  });

  it('queues both alerts for a single hide-plus-report write', () => {
    const kinds = alertsForWrite(
      'items',
      'i1',
      ITEM({ status: 'active', reportCount: 3 }),
      ITEM({ status: 'hidden', reportCount: 4 }),
    ).map((a) => a.kind);
    expect(kinds).toEqual(['content-reported', 'moderation']);
  });

  it('labels an item with its own words and a proof with its Prompt text, falling back to the doc id', () => {
    expect(alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' }))[0].label).toBe(
      'Spot a speedo at breakfast',
    );
    expect(
      alertsForWrite('proofs', 'p1', { status: 'active' }, { status: 'hidden', itemText: 'Deck wine' })[0].label,
    ).toBe('Deck wine');
    expect(alertsForWrite('proofs', 'p9', { status: 'active' }, { status: 'hidden' })[0].label).toBe('p9');
    // Whitespace-only text is not a label.
    expect(alertsForWrite('items', 'i7', undefined, ITEM({ status: 'pending', text: '   ' }))[0].label).toBe('i7');
  });

  it('clips a runaway label rather than mailing an essay', () => {
    const label = alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending', text: 'x'.repeat(500) }))[0]
      .label;
    expect(label.length).toBe(80);
    expect(label.endsWith('…')).toBe(true);
  });
});

// --- Producing -------------------------------------------------------------------

describe('enqueueAdminAlerts', () => {
  it('writes sentAt: null EXPLICITLY, so the drain query can find the alert at all', async () => {
    const db = fakeDb();
    await enqueueAdminAlerts(db, 'med-2026', alertsForWrite('items', 'i1', undefined, ITEM({ status: 'pending' })), {
      now: () => 42,
    });
    const [row] = db.rows('events/med-2026/adminAlerts');
    // Firestore's equality filter matches a stored null but NOT a missing field.
    expect(row.sentAt).toBeNull();
    expect('sentAt' in row).toBe(true);
    expect(row.createdAt).toBe(42);
    expect(row.kind).toBe('item-created');
  });

  it('never throws when the queue write fails — a mail concern must not fail a moderation write', async () => {
    const db = {
      collection: () => ({ add: async () => Promise.reject(new Error('firestore down')) }),
      doc: () => ({ get: async () => ({ data: () => undefined }), set: async () => undefined }),
    } as unknown as AdminAlertFirestore;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      recordAdminAlerts(db, 'items', 'e', 'i1', undefined, ITEM({ status: 'pending' })),
    ).resolves.toBe(0);
    spy.mockRestore();
  });

  it('writes nothing at all for a write that earns nothing', async () => {
    const db = fakeDb();
    expect(await recordAdminAlerts(db, 'items', 'e', 'i1', ITEM(), ITEM())).toBe(0);
    expect(db.rows('events/e/adminAlerts')).toEqual([]);
  });
});

// --- What the digest says --------------------------------------------------------

describe('currentThemeDay', () => {
  it('picks the most recently unlocked Day, so a mid-cruise digest wears today’s palette', () => {
    expect(currentThemeDay(EVENT.days, NOW)?.theme).toBe('sporty-splash');
  });

  it('falls back to the first Day before the Event has started', () => {
    expect(currentThemeDay(EVENT.days, 0)?.theme).toBe('welcome-aboard');
  });

  it('ignores the unlockAt:0 live-pre-event sentinel rather than treating it as unlocked', () => {
    const days = [{ index: 0, unlockAt: 0, theme: 'welcome-aboard' }, { index: 1, unlockAt: 2_000, theme: 'marquee' }];
    expect(currentThemeDay(days, 1_000)?.theme).toBe('welcome-aboard'); // the [0] fallback, not the sentinel match
    expect(currentThemeDay(days, 3_000)?.theme).toBe('marquee');
  });

  it('returns undefined for an Event with no schedule, so the EDITION default takes over', () => {
    expect(currentThemeDay([], NOW)).toBeUndefined();
    expect(currentThemeDay(undefined, NOW)).toBeUndefined();
    const model = buildAdminDigestModel({
      event: { name: 'Bodega', days: [] },
      eventId: 'e',
      alerts: [ALERT()],
      edition: 'vacay',
      origin: 'https://vacaybingo.com',
      now: NOW,
    });
    // Vacay's own default Theme — never grey, never another product's identity.
    expect(model.theme).toEqual(EMAIL_THEME_TOKENS['the-birds']);
  });
});

describe('reviewDetail', () => {
  it('derives the cause from stored facts and never fabricates a threshold', () => {
    const mod = (over: Partial<AdminAlertRecord>) => ALERT({ kind: 'moderation', ...over });
    expect(reviewDetail(mod({ status: 'hidden', reportCount: 4 }), 4)).toBe('hidden (reports >= threshold) · 4 reports');
    expect(reviewDetail(mod({ status: 'hidden', reportCount: 1 }), 4)).toBe('hidden (by an admin) · 1 report');
    expect(reviewDetail(mod({ status: 'hidden', reportCount: 1 }), null)).toBe('hidden · 1 report');
    expect(reviewDetail(mod({ status: 'flagged', visionFlag: 'violence', reportCount: 0 }), 4)).toBe(
      'flagged (violence) · 0 reports',
    );
  });

  it('states the distance to the auto-hide bar for a live report', () => {
    expect(reviewDetail(ALERT({ reportCount: 1 }), 4)).toBe('reported · 1 report · 3 more to auto-hide');
    expect(reviewDetail(ALERT({ reportCount: 3 }), 4)).toBe('reported · 3 reports · 1 more to auto-hide');
    // At/over the bar there is no distance left to state.
    expect(reviewDetail(ALERT({ reportCount: 4 }), 4)).toBe('reported · 4 reports');
    // No threshold configured → no claim about auto-hiding.
    expect(reviewDetail(ALERT({ reportCount: 2 }), null)).toBe('reported · 2 reports');
  });
});

describe('buildAdminDigestModel', () => {
  const build = (alerts: AdminAlertRecord[], over: Partial<Parameters<typeof buildAdminDigestModel>[0]> = {}) =>
    buildAdminDigestModel({
      event: EVENT,
      eventId: 'med-2026',
      alerts,
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
      ...over,
    });

  it('renders both modules and names both counts', () => {
    const model = build([
      ALERT({ id: 'a1', kind: 'item-created', docId: 'i1', label: 'Spot a speedo', status: 'pending' }),
      ALERT({ id: 'a2', kind: 'content-reported', docId: 'i2', label: 'Rude one', reportCount: 2, createdAt: 2_000 }),
    ]);
    expect(model.sections.map((s) => s.heading)).toEqual(['Awaiting approval', 'Reported & hidden']);
    expect(model.subject).toBe('Admin · Trieste → Barcelona—1 to approve, 1 to review');
    expect(model.preheader).toBe('2 items in the review queue for Trieste → Barcelona.');
    expect(model.sections[0].rows).toEqual([{ label: 'Spot a speedo', detail: 'new Prompt · pending approval' }]);
    expect(model.sections[1].rows[0].label).toBe('Prompt: Rude one');
  });

  it('omits a module with no rows rather than rendering an empty one', () => {
    const model = build([ALERT({ kind: 'item-created', status: 'pending' })]);
    expect(model.sections.map((s) => s.heading)).toEqual(['Awaiting approval']);
    expect(model.subject).toBe('Admin · Trieste → Barcelona—1 to approve');
  });

  it('collapses a report and the auto-hide it caused into ONE row carrying the hide', () => {
    const model = build([
      ALERT({ id: 'a1', kind: 'content-reported', docId: 'i1', reportCount: 4, createdAt: 1_000 }),
      ALERT({ id: 'a2', kind: 'moderation', docId: 'i1', status: 'hidden', reportCount: 4, createdAt: 1_100 }),
    ]);
    const review = model.sections.find((s) => s.heading === 'Reported & hidden');
    expect(review?.rows).toHaveLength(1);
    expect(review?.rows[0].detail).toBe('hidden (reports >= threshold) · 4 reports');
    // Two things did not happen to two things.
    expect(model.subject).toBe('Admin · Trieste → Barcelona—1 to review');
  });

  it('does NOT collapse approvals — each pending Prompt is its own piece of work', () => {
    const model = build([
      ALERT({ id: 'a1', kind: 'item-created', docId: 'i1', label: 'One', status: 'pending' }),
      ALERT({ id: 'a2', kind: 'item-created', docId: 'i2', label: 'Two', status: 'pending', createdAt: 1_100 }),
    ]);
    expect(model.sections[0].rows.map((r) => r.label)).toEqual(['One', 'Two']);
  });

  it('states the overflow rather than truncating silently', () => {
    const many = Array.from({ length: ROWS_PER_SECTION + 7 }, (_, i) =>
      ALERT({ id: `a${i}`, kind: 'item-created', docId: `i${i}`, label: `P${i}`, status: 'pending', createdAt: i }),
    );
    const section = build(many).sections[0];
    expect(section.rows).toHaveLength(ROWS_PER_SECTION);
    expect(section.overflow).toBe(7);
    expect(renderAdminDigestHtml(build(many))).toContain('+7 more in the Review queue');
  });

  it('deep-links the Review queue, not the /admin route that goes nowhere', () => {
    // `/admin` matches no route in the app — the console lives at
    // /more/admin[/section] (specs/admin-console-ia.md), and the pre-#638
    // notifier linked the dead one.
    expect(build([ALERT()]).ctaUrl).toBe('https://gaycruisebingo.com/more/admin/queue');
  });

  it('carries the Edition brand line and the Day’s Theme', () => {
    const model = build([ALERT()], { edition: 'vacay' });
    expect(model.brandLine).toBe('Vacay Bingo · by Five Across · Admin');
    expect(model.footerBrandLine).toBe('Vacay Bingo · by Five Across');
    expect(model.theme).toEqual(EMAIL_THEME_TOKENS['sporty-splash']);
    expect(model.contextLine).toBe('Trieste → Barcelona · Day 2 of 3 · 💦 Sporty Splash');
  });
});

// --- Rendering -------------------------------------------------------------------

describe('renderAdminDigestHtml', () => {
  const model = buildAdminDigestModel({
    event: EVENT,
    eventId: 'med-2026',
    alerts: [
      ALERT({ id: 'a1', kind: 'item-created', docId: 'i1', label: 'Spot a speedo', status: 'pending' }),
      ALERT({ id: 'a2', kind: 'moderation', docId: 'p1', collection: 'proofs', status: 'hidden', reportCount: 4 }),
    ],
    edition: 'gcb',
    origin: 'https://gaycruisebingo.com',
    now: NOW,
  });

  it('renders the wireframe’s email-safe shell', () => {
    const html = renderAdminDigestHtml(model);
    expect(html).toContain('width="600"'); // 600px single-column table
    expect(html).not.toMatch(/display:\s*(flex|grid)/); // Outlook renders through Word
    expect(html).not.toContain('var(--'); // Gmail resolves no custom properties
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('name="supported-color-schemes" content="light dark"');
    expect(html).toContain('v:roundrect'); // the Outlook VML half of the bulletproof CTA
    expect(html).not.toContain('<img'); // the CTA survives image blocking
    expect(html).toContain("'Bebas Neue','Arial Narrow',Arial");
    expect(html).toContain('Open the Review queue');
  });

  it('carries no unsubscribe link — this is operational mail, not engagement mail', () => {
    const html = renderAdminDigestHtml(model);
    expect(html.toLowerCase()).not.toContain('unsubscribe');
    expect(html).toContain('Admin alerts are batched');
  });

  it('escapes an unapproved Prompt’s own words', () => {
    // The one string here most likely to contain markup arrives straight from a
    // user submission that nobody has approved yet.
    const hostile = buildAdminDigestModel({
      event: EVENT,
      eventId: 'e',
      alerts: [
        ALERT({ kind: 'item-created', status: 'pending', label: '<script>alert("x")</script>' }),
      ],
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    const html = renderAdminDigestHtml(hostile);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses a non-https link', () => {
    const bad = buildAdminDigestModel({
      event: EVENT,
      eventId: 'e',
      alerts: [ALERT()],
      edition: 'gcb',
      origin: 'javascript:alert(1)//',
      now: NOW,
    });
    const html = renderAdminDigestHtml(bad);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  it('paints every module on a light Theme, so dark-mode inversion has nothing to grab', () => {
    const light = buildAdminDigestModel({
      event: { ...EVENT, days: [{ index: 0, unlockAt: 1_000, theme: 'fog-froth-farewells' }] },
      eventId: 'e',
      alerts: [ALERT()],
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    const tokens = EMAIL_THEME_TOKENS['fog-froth-farewells'];
    const html = renderAdminDigestHtml(light);
    expect(html).toContain(`bgcolor="${tokens.panel}"`);
    expect(html).toContain(`color:${tokens.ink}`);
    expect(html).toContain(`background-color:${tokens.bg}`);
  });
});

describe('renderAdminDigestText', () => {
  it('mirrors the module order so multipart/alternative degrades to something triage-able', () => {
    const model = buildAdminDigestModel({
      event: EVENT,
      eventId: 'e',
      alerts: [
        ALERT({ id: 'a1', kind: 'item-created', docId: 'i1', label: 'Spot a speedo', status: 'pending' }),
        ALERT({ id: 'a2', kind: 'content-reported', docId: 'i2', label: 'Rude one', reportCount: 2, createdAt: 2_000 }),
      ],
      edition: 'gcb',
      origin: 'https://gaycruisebingo.com',
      now: NOW,
    });
    const text = renderAdminDigestText(model);
    expect(text.indexOf('AWAITING APPROVAL')).toBeLessThan(text.indexOf('REPORTED & HIDDEN'));
    expect(text.indexOf('REPORTED & HIDDEN')).toBeLessThan(text.indexOf('Open the Review queue:'));
    expect(text).toContain('- Spot a speedo—new Prompt · pending approval');
    expect(text).toContain('https://gaycruisebingo.com/more/admin/queue');
  });
});

// --- Delivery --------------------------------------------------------------------

describe('sendAdminDigestForEvent', () => {
  const deps = (send: ReturnType<typeof vi.fn>) => ({
    send: send as never,
    getAdminUids: async () => ['u1'],
    getEmailForUid: async (uid: string) => `${uid}@example.com`,
    adminNotifyEmail: '',
    appBaseUrl: 'https://gaycruisebingo.com',
    from: 'Gay Cruise Bingo <bingo@example.com>',
    now: () => NOW,
  });

  const seeded = (alerts: Record<string, unknown>[], hostnames: Record<string, unknown>[] = []) =>
    fakeDb(
      { 'events/med-2026/adminAlerts': alerts, hostnames, events: [{ id: 'med-2026', status: 'active' }] },
      { 'events/med-2026': EVENT },
    );

  const pendingAlert = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'item-created',
    collection: 'items',
    docId: `i-${id}`,
    label: `Prompt ${id}`,
    status: 'pending',
    visionFlag: null,
    reportCount: 0,
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    sentAt: null,
    ...over,
  });

  it('sends ONE digest for a burst of eighty pending Prompts', async () => {
    // The acceptance criterion in its most literal form: a pool import writes
    // eighty rows in a second and the admins get one email.
    const send = vi.fn(async () => true);
    const db = seeded(Array.from({ length: 80 }, (_, i) => pendingAlert(`a${i + 1}`)));
    const result = await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    expect(result).toEqual({ sent: 80 });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0] as { subject: string; to: string[]; html: string };
    expect(arg.subject).toBe('Admin · Trieste → Barcelona—80 to approve');
    expect(arg.to).toEqual(['u1@example.com']);
    expect(arg.html).toContain(`+${80 - ROWS_PER_SECTION} more in the Review queue`);
  });

  it('is idempotent across sweeps: a second run after a clean drain sends nothing', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1'), pendingAlert('a2')]);
    expect((await sendAdminDigestForEvent(db, 'med-2026', deps(send))).sent).toBe(2);
    expect(db.rows('events/med-2026/adminAlerts').every((r) => r.sentAt === NOW)).toBe(true);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({ sent: 0, reason: 'no-alerts' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keys the send by the drained SET, so a stamp failure retries as the same email', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1'), pendingAlert('a2')]);
    await sendAdminDigestForEvent(db, 'med-2026', deps(send));
    const key = (send.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey;
    // newest alert id + count — stable for a given set, different once one more arrives.
    expect(key).toBe('admin-digest/med-2026/a2/2');
  });

  it('leaves alerts queued when the send fails, so nothing is silently dropped', async () => {
    const send = vi.fn(async () => false);
    const db = seeded([pendingAlert('a1')]);
    expect(await sendAdminDigestForEvent(db, 'med-2026', deps(send))).toEqual({ sent: 0, reason: 'send-failed' });
    expect(db.rows('events/med-2026/adminAlerts')[0].sentAt).toBeNull();
  });

  it('leaves alerts queued when no admin email resolves', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([pendingAlert('a1')]);
    const result = await sendAdminDigestForEvent(db, 'med-2026', {
      ...deps(send),
      getAdminUids: async () => [],
      getEmailForUid: async () => null,
    });
    expect(result).toEqual({ sent: 0, reason: 'no-recipients' });
    expect(send).not.toHaveBeenCalled();
    // They drain on the first sweep after a recipient exists, rather than being lost.
    expect(db.rows('events/med-2026/adminAlerts')[0].sentAt).toBeNull();
  });

  it('prefers the Event’s canonical host for the deep link, falling back to APP_BASE_URL', async () => {
    const send = vi.fn(async () => true);
    const withHost = seeded(
      [pendingAlert('a1')],
      [{ id: 'bingo.example.com', eventId: 'med-2026', status: 'active', isCanonical: true, edition: 'vacay' }],
    );
    await sendAdminDigestForEvent(withHost, 'med-2026', deps(send));
    expect((send.mock.calls[0][0] as { html: string }).html).toContain('https://bingo.example.com/more/admin/queue');

    const noHost = seeded([pendingAlert('a1')]);
    await sendAdminDigestForEvent(noHost, 'med-2026', deps(send));
    expect((send.mock.calls[1][0] as { html: string }).html).toContain(
      'https://gaycruisebingo.com/more/admin/queue',
    );
  });

  it('skips a malformed queue row instead of letting it suppress the whole Event’s digest', async () => {
    const send = vi.fn(async () => true);
    const db = seeded([
      { id: 'bad', kind: 'not-a-kind', collection: 'items', sentAt: null, createdAt: 1 },
      pendingAlert('a2'),
    ]);
    expect((await sendAdminDigestForEvent(db, 'med-2026', deps(send))).sent).toBe(1);
  });

  it('bounds the drain query rather than materialising a runaway queue', async () => {
    const send = vi.fn(async () => true);
    const db = seeded(Array.from({ length: 12 }, (_, i) => pendingAlert(`a${i + 1}`)));
    await sendAdminDigestForEvent(db, 'med-2026', { ...deps(send), maxAlerts: 5 });
    expect((send.mock.calls[0][0] as { subject: string }).subject).toContain('5 to approve');
    // The rest are untouched and drain on the next sweep.
    expect(db.rows('events/med-2026/adminAlerts').filter((r) => r.sentAt === null)).toHaveLength(7);
    expect(MAX_ALERTS_PER_DIGEST).toBeGreaterThan(5);
  });
});

describe('runAdminAlertSweep', () => {
  it('one Event’s failure never sinks the sweep', async () => {
    const send = vi.fn(async () => true);
    const db = fakeDb(
      {
        events: [{ id: 'broken', status: 'active' }, { id: 'med-2026', status: 'active' }],
        'events/med-2026/adminAlerts': [
          {
            id: 'a1',
            kind: 'item-created',
            collection: 'items',
            docId: 'i1',
            label: 'Prompt',
            status: 'pending',
            visionFlag: null,
            reportCount: 0,
            createdAt: 1,
            sentAt: null,
          },
        ],
      },
      { 'events/med-2026': EVENT, 'events/broken': EVENT },
      // The first Event's drain throws outright; the second must still send.
      ['events/broken/adminAlerts'],
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runAdminAlertSweep(db, {
      send: send as never,
      getAdminUids: async () => ['u1'],
      getEmailForUid: async (uid: string) => `${uid}@example.com`,
      adminNotifyEmail: '',
      appBaseUrl: 'https://gaycruisebingo.com',
      from: 'x <x@example.com>',
      now: () => NOW,
    });
    spy.mockRestore();
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.rows('events/med-2026/adminAlerts')[0].sentAt).toBe(NOW);
  });
});
