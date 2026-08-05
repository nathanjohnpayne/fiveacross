/**
 * Per-user email opt-out and the unsubscribe endpoint's core (issue #616).
 *
 * CONSENT IS THE NON-NEGOTIABLE HALF of the daily engagement email, so it lives
 * in its own module rather than as a branch inside the sender: recipients are
 * signed-in participants only, every send carries a working unsubscribe, the
 * opt-out is persisted durably, and it is applied BEFORE the send rather than
 * filtered afterwards.
 *
 * STORAGE. `events/{eventId}/emailPrefs/{uid}`, one doc per participant per
 * Event:
 *
 *   { optedOut: boolean, token: string, lastSentDayIndex?: number, updatedAt: number }
 *
 * Event-scoped rather than global because that is what the unsubscribe link in
 * a given Event's email actually promises ("stop sending me THIS Event's daily
 * mail"), and because the Event is already the isolation boundary the whole
 * schema is built on. `token` is an unguessable per-user capability: it is the
 * ONLY authority the unsubscribe endpoint accepts, which is what lets the link
 * work from a mail client with no session — and why the collection is
 * server-owned (`firestore.rules` denies clients outright; the Admin SDK
 * bypasses rules).
 *
 * NO SECRET REQUIRED, deliberately. An HMAC scheme would need a Secret Manager
 * entry set out of band, and an unresolved secret would break unsubscribe —
 * the one part of this feature that must never break. A stored random token has
 * the same unguessability with no key management, and revoking it is a field
 * write rather than a rotation.
 *
 * Pure and injectable: the Firestore surface is a minimal passed-in interface
 * and randomness/time are injectable, so every branch is unit-testable without
 * a Functions runtime (mirrors `unlockDay.ts`).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

// --- Minimal admin-SDK Firestore surface ----------------------------------------

interface PrefsSnapshot {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface PrefsDocRef {
  get(): Promise<PrefsSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  /** Admin-SDK `DocumentReference.create` — writes ONLY if the document does
   *  not exist, rejecting with ALREADY_EXISTS otherwise. Load-bearing: it is
   *  what makes minting a preference doc atomic (see `ensureEmailPrefs`). */
  create(data: Record<string, unknown>): Promise<unknown>;
}
/** The minimal surface the opt-out store uses. */
export interface EmailPrefsFirestore {
  doc(path: string): PrefsDocRef;
}

/** The stored per-user preference doc. */
export interface EmailPrefs {
  optedOut: boolean;
  token: string;
  /** The last Day index this participant was emailed for — the once-per-day
   *  guard. Absent until the first send. */
  lastSentDayIndex?: number;
}

export interface OptOutDeps {
  now?: () => number;
  /** Injectable entropy so a test can pin a token. Defaults to 32 random bytes. */
  mintToken?: () => string;
}

/** `events/{eventId}/emailPrefs/{uid}` — the one place this path is spelled. */
export function emailPrefsPath(eventId: string, uid: string): string {
  return `events/${eventId}/emailPrefs/${uid}`;
}

function defaultMintToken(): string {
  // 32 bytes / 256 bits of entropy, hex-encoded: unguessable, URL-safe with no
  // escaping, and short enough to survive a mail client's line wrapping intact.
  return randomBytes(32).toString('hex');
}

/**
 * The outcome of reading one participant's prefs. THREE states, not two, and
 * the distinction is the whole point: collapsing "the document is not there"
 * into "I could not read it" is how a transient Firestore error silently
 * RESUBSCRIBES someone who had opted out (Codex #623 P1) — the caller sees
 * "absent", mints a fresh opted-in doc over the top, and the next sweep mails
 * a person who asked not to be mailed. A consent record may only ever be
 * created from a confirmed absence.
 */
export type EmailPrefsRead =
  | { status: 'found'; prefs: EmailPrefs }
  | { status: 'absent' }
  | { status: 'error' };

/** Read one participant's prefs, reporting absence and failure separately.
 *  Never throws. A doc that exists with no usable token is still `found` — it
 *  cannot authorize an unsubscribe, but it is NOT absent, and its `optedOut`
 *  must be preserved. */
export async function readEmailPrefsOutcome(
  db: EmailPrefsFirestore,
  eventId: string,
  uid: string,
): Promise<EmailPrefsRead> {
  try {
    const snap = await db.doc(emailPrefsPath(eventId, uid)).get();
    if (!snap.exists) return { status: 'absent' };
    const data = snap.data() ?? {};
    return {
      status: 'found',
      prefs: {
        optedOut: data.optedOut === true,
        token: typeof data.token === 'string' ? data.token : '',
        lastSentDayIndex:
          typeof data.lastSentDayIndex === 'number' && Number.isFinite(data.lastSentDayIndex)
            ? data.lastSentDayIndex
            : undefined,
      },
    };
  } catch (err) {
    console.error('readEmailPrefs failed', eventId, uid, err);
    return { status: 'error' };
  }
}

/** The convenience shape: usable prefs, or `null` for absent, unreadable, or
 *  token-less. Callers that must tell those apart use
 *  `readEmailPrefsOutcome`. */
export async function readEmailPrefs(
  db: EmailPrefsFirestore,
  eventId: string,
  uid: string,
): Promise<EmailPrefs | null> {
  const read = await readEmailPrefsOutcome(db, eventId, uid);
  return read.status === 'found' && read.prefs.token !== '' ? read.prefs : null;
}

/**
 * The participant's prefs, minting the doc (opted IN, with a fresh token) when
 * — and ONLY when — it is confirmed absent. Opt-in-by-default is the correct
 * default HERE and only here: the Event-level admin toggle decides whether
 * anyone is emailed at all, and it ships OFF, so the consent decision is made
 * once by the Event admin rather than implied per participant by this function.
 *
 * TWO GUARDS PROTECT AN EXISTING OPT-OUT (Codex #623 P1), because a mint that
 * lands on a doc that already exists would write `optedOut: false` over
 * somebody's opt-out even through a merge — merge is field-level, and this
 * payload names the field:
 *
 *   1. A READ FAILURE is not an absence. `error` returns `null` (skip the
 *      recipient entirely) rather than falling through to the mint.
 *   2. The mint is `create`, not `set`. Even given a correct absent read, a
 *      concurrent unsubscribe could land between the read and the write;
 *      `create` rejects rather than overwriting, and the recovery is to re-read
 *      and use whatever is actually there.
 *
 * A doc that exists but carries no token gets a token merged in — that write
 * names only `token`/`updatedAt`, so an existing `optedOut: true` survives it.
 *
 * Returns `null` when the prefs could neither be read nor established — the
 * sender treats that as "do not send", because an email whose unsubscribe link
 * cannot be honored must not go out.
 */
export async function ensureEmailPrefs(
  db: EmailPrefsFirestore,
  eventId: string,
  uid: string,
  deps: OptOutDeps = {},
): Promise<EmailPrefs | null> {
  const read = await readEmailPrefsOutcome(db, eventId, uid);
  if (read.status === 'error') return null; // NOT an absence — never mint over it
  const mint = deps.mintToken ?? defaultMintToken;
  const now = (deps.now ?? Date.now)();

  if (read.status === 'found') {
    if (read.prefs.token !== '') return read.prefs;
    // Present but token-less: back-fill ONLY the token, preserving optedOut.
    const token = mint();
    try {
      await db.doc(emailPrefsPath(eventId, uid)).set({ token, updatedAt: now }, { merge: true });
      return { ...read.prefs, token };
    } catch (err) {
      console.error('ensureEmailPrefs: token back-fill failed', eventId, uid, err);
      return null;
    }
  }

  const token = mint();
  try {
    await db
      .doc(emailPrefsPath(eventId, uid))
      .create({ optedOut: false, token, createdAt: now, updatedAt: now });
    return { optedOut: false, token };
  } catch (err) {
    // Lost the race (ALREADY_EXISTS) or the write failed. Either way, believe
    // the stored document over this one's intent: re-read and use it.
    const after = await readEmailPrefs(db, eventId, uid);
    if (after) return after;
    console.error('ensureEmailPrefs: mint failed', eventId, uid, err);
    return null;
  }
}

/** Record that this participant has been emailed for `dayIndex`. Best-effort:
 *  a failure here re-sends at most once, and Resend's idempotency key collapses
 *  that duplicate inside its 24h window. */
export async function markDailyEmailSent(
  db: EmailPrefsFirestore,
  eventId: string,
  uid: string,
  dayIndex: number,
  deps: OptOutDeps = {},
): Promise<void> {
  try {
    await db
      .doc(emailPrefsPath(eventId, uid))
      .set({ lastSentDayIndex: dayIndex, updatedAt: (deps.now ?? Date.now)() }, { merge: true });
  } catch (err) {
    console.error('markDailyEmailSent failed', eventId, uid, dayIndex, err);
  }
}

/** Constant-time token comparison. Length is compared first because
 *  `timingSafeEqual` THROWS on a length mismatch, and an unequal-length token
 *  is already a mismatch — there is no secret in the length of a fixed-width
 *  hex string. */
export function tokenMatches(expected: string, supplied: string): boolean {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  if (expected.length === 0 || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(supplied, 'utf8'));
}

export type OptOutResult = 'updated' | 'invalid' | 'error';

/**
 * Apply an unsubscribe (or a re-subscribe) after verifying the capability
 * token. Returns `'invalid'` for a bad/absent token — deliberately the SAME
 * answer for "no such doc" and "wrong token", so the endpoint cannot be used to
 * enumerate which uids are participants.
 */
export async function applyOptOut(
  db: EmailPrefsFirestore,
  eventId: string,
  uid: string,
  suppliedToken: string,
  optedOut: boolean,
  deps: OptOutDeps = {},
): Promise<OptOutResult> {
  const prefs = await readEmailPrefs(db, eventId, uid);
  if (!prefs || !tokenMatches(prefs.token, suppliedToken)) return 'invalid';
  try {
    await db
      .doc(emailPrefsPath(eventId, uid))
      .set({ optedOut, updatedAt: (deps.now ?? Date.now)() }, { merge: true });
    return 'updated';
  } catch (err) {
    console.error('applyOptOut: write failed', eventId, uid, err);
    return 'error';
  }
}

// --- Link construction ----------------------------------------------------------

export interface UnsubscribeLinkArgs {
  /** The endpoint's own base URL, e.g. `https://us-central1-p.cloudfunctions.net/emailUnsubscribe`. */
  baseUrl: string;
  eventId: string;
  uid: string;
  token: string;
}

function linkWith(args: UnsubscribeLinkArgs, action: 'unsubscribe' | 'preferences'): string {
  const q = new URLSearchParams({
    e: args.eventId,
    u: args.uid,
    t: args.token,
    a: action,
  });
  const sep = args.baseUrl.includes('?') ? '&' : '?';
  return `${args.baseUrl}${sep}${q.toString()}`;
}

/** The visible "Unsubscribe" link AND the `List-Unsubscribe` header target. */
export function unsubscribeLink(args: UnsubscribeLinkArgs): string {
  return linkWith(args, 'unsubscribe');
}

/** The footer's "Email preferences" link — the same endpoint, showing current
 *  state with both actions available, so a mistaken unsubscribe is reversible
 *  without a support round-trip. */
export function preferencesLink(args: UnsubscribeLinkArgs): string {
  return linkWith(args, 'preferences');
}

/**
 * RFC 8058 headers. `List-Unsubscribe-Post` is what makes Gmail and Apple Mail
 * surface their NATIVE one-click control, and it commits the endpoint to
 * honoring a bare POST with no confirmation step — which is exactly why the
 * GET path below confirms instead of acting (see `handleUnsubscribeRequest`).
 */
export function listUnsubscribeHeaders(unsubUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// --- The HTTP endpoint's core ---------------------------------------------------

/** The minimal Express-shaped request the endpoint reads. */
export interface UnsubRequest {
  method: string;
  query: Record<string, unknown>;
}
/** The minimal Express-shaped response the endpoint writes. */
export interface UnsubResponse {
  status(code: number): UnsubResponse;
  set(field: string, value: string): UnsubResponse;
  send(body: string): unknown;
}

// Single-quoted font names, deliberately: this string lands INSIDE a
// double-quoted `style="..."` attribute, and a nested double quote would end
// the attribute early and spill the rest of the declaration into the markup.
const PAGE_STYLE =
  "font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
  'max-width:34em;margin:12vh auto;padding:0 1.25rem;color:#20232a;background:#fff;';

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A tiny self-contained page. Deliberately not the app: this has to render for
 *  someone with no session, on a device that may never have opened the app. */
export function renderPage(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    `<title>${escapeAttr(title)}</title></head>` +
    `<body style="${PAGE_STYLE}"><h1 style="font-size:1.35rem;">${escapeAttr(title)}</h1>${body}</body></html>`
  );
}

function readParam(query: Record<string, unknown>, key: string): string {
  const raw = query[key];
  return typeof raw === 'string' ? raw : '';
}

/** The reserved parameter names this endpoint owns. Everything else in the
 *  incoming query belongs to whatever fronts it. */
const RESERVED_PARAMS = ['e', 'u', 't', 'a'];

/**
 * The query string for a same-page link or form action, carrying this
 * endpoint's own four parameters PLUS every other parameter the request
 * arrived with.
 *
 * The pass-through is the point (Codex #623 P2). `EMAIL_UNSUBSCRIBE_URL` is
 * configurable precisely so the endpoint can sit behind a rewrite or a router
 * that selects it with its own parameter — `linkWith` explicitly supports a
 * base URL that already has a query string. A form action of `?e=…&u=…&t=…&a=…`
 * REPLACES the whole query, so that router parameter would survive the emailed
 * GET and then vanish on the POST, sending the confirmation nowhere and leaving
 * unsubscribe visibly broken on exactly the deployments that configured it.
 */
function samePageQuery(query: Record<string, unknown>, own: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_PARAMS.includes(key)) continue;
    if (typeof value === 'string') q.append(key, value);
  }
  for (const [key, value] of Object.entries(own)) q.append(key, value);
  return q.toString();
}

/**
 * Handle one unsubscribe request. Never throws — a failure renders a page that
 * tells the reader what to do next rather than a stack trace.
 *
 * GET CONFIRMS, POST ACTS, and the split is load-bearing rather than tidy.
 * Corporate link scanners (Outlook Safe Links, mail-security gateways) and
 * client prefetchers issue GETs on every URL in a message; a GET that
 * unsubscribed would silently opt people out of mail they never opened. So the
 * GET renders a one-button form and the POST — which is also what RFC 8058
 * one-click sends — performs the change.
 */
export async function handleUnsubscribeRequest(
  db: EmailPrefsFirestore,
  req: UnsubRequest,
  res: UnsubResponse,
  deps: OptOutDeps = {},
): Promise<void> {
  const html = (code: number, page: string): void => {
    res.status(code).set('Content-Type', 'text/html; charset=utf-8').send(page);
  };
  try {
    const eventId = readParam(req.query, 'e');
    const uid = readParam(req.query, 'u');
    const token = readParam(req.query, 't');
    const action = readParam(req.query, 'a') || 'unsubscribe';
    const resubscribe = action === 'resubscribe';

    if (!eventId || !uid || !token) {
      html(400, renderPage('That link is incomplete', '<p>Use the Unsubscribe link from the email itself.</p>'));
      return;
    }

    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
      html(405, renderPage('Method not allowed', '<p>Use the Unsubscribe link from the email itself.</p>'));
      return;
    }

    if (method !== 'POST') {
      // Confirmation page. It never reveals whether the token is valid — the
      // form posts and the POST answers — so a scanner learns nothing.
      const same = (action: string): string =>
        escapeAttr(samePageQuery(req.query, { e: eventId, u: uid, t: token, a: action }));
      const verb = resubscribe ? 'Resume' : 'Stop';
      const body =
        `<p>${resubscribe ? 'Start receiving the daily email for this event again?' : 'Stop the daily email for this event?'}</p>` +
        `<form method="POST" action="?${same(resubscribe ? 'resubscribe' : 'unsubscribe')}">` +
        `<button type="submit" style="font:inherit;padding:.7em 1.4em;border:0;border-radius:6px;` +
        `background:#20232a;color:#fff;cursor:pointer;">${verb} these emails</button></form>` +
        (resubscribe
          ? ''
          : `<p style="margin-top:1.5rem;font-size:.9rem;color:#5a5f6a;">Changed your mind later? ` +
            `<a href="?${same('resubscribe')}">Turn them back on</a>.</p>`);
      html(200, renderPage(resubscribe ? 'Daily email' : 'Unsubscribe', body));
      return;
    }

    const result = await applyOptOut(db, eventId, uid, token, !resubscribe, deps);
    if (result === 'invalid') {
      html(
        404,
        renderPage(
          'That link is no longer valid',
          '<p>It may have expired or already been used. Open the most recent email and use its Unsubscribe link.</p>',
        ),
      );
      return;
    }
    if (result === 'error') {
      html(500, renderPage('Something went wrong', '<p>Please try that link again in a minute.</p>'));
      return;
    }
    html(
      200,
      renderPage(
        resubscribe ? "You're back on the list" : 'Unsubscribed',
        resubscribe
          ? '<p>The daily email for this event will start arriving again.</p>'
          : '<p>You will not get the daily email for this event again. Nothing else changes—your card, your marks and the Feed are untouched.</p>',
      ),
    );
  } catch (err) {
    console.error('handleUnsubscribeRequest failed', err);
    html(500, renderPage('Something went wrong', '<p>Please try that link again in a minute.</p>'));
  }
}
