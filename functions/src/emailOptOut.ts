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

/** Read one participant's prefs, or `null` when none has been minted yet.
 *  Never throws — a read failure is reported as "unknown", and the caller
 *  decides (the sender skips; the endpoint refuses). */
export async function readEmailPrefs(
  db: EmailPrefsFirestore,
  eventId: string,
  uid: string,
): Promise<EmailPrefs | null> {
  try {
    const snap = await db.doc(emailPrefsPath(eventId, uid)).get();
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    const token = typeof data.token === 'string' ? data.token : '';
    if (!token) return null; // a doc with no token cannot authorize an unsubscribe
    return {
      optedOut: data.optedOut === true,
      token,
      lastSentDayIndex:
        typeof data.lastSentDayIndex === 'number' && Number.isFinite(data.lastSentDayIndex)
          ? data.lastSentDayIndex
          : undefined,
    };
  } catch (err) {
    console.error('readEmailPrefs failed', eventId, uid, err);
    return null;
  }
}

/**
 * The participant's prefs, minting the doc (opted IN, with a fresh token) when
 * it does not exist yet. Opt-in-by-default is the correct default HERE and only
 * here: the Event-level admin toggle is what decides whether anyone is emailed
 * at all, and it ships OFF, so the consent decision is made once by the Event
 * admin rather than implied per participant by this function.
 *
 * Returns `null` when the doc could neither be read nor written — the sender
 * treats that as "do not send", because an email whose unsubscribe link cannot
 * be honored must not go out.
 */
export async function ensureEmailPrefs(
  db: EmailPrefsFirestore,
  eventId: string,
  uid: string,
  deps: OptOutDeps = {},
): Promise<EmailPrefs | null> {
  const existing = await readEmailPrefs(db, eventId, uid);
  if (existing) return existing;
  const token = (deps.mintToken ?? defaultMintToken)();
  const now = (deps.now ?? Date.now)();
  try {
    await db
      .doc(emailPrefsPath(eventId, uid))
      .set({ optedOut: false, token, createdAt: now, updatedAt: now }, { merge: true });
    return { optedOut: false, token };
  } catch (err) {
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
      const q = new URLSearchParams({ e: eventId, u: uid, t: token, a: resubscribe ? 'resubscribe' : 'unsubscribe' });
      const verb = resubscribe ? 'Resume' : 'Stop';
      const body =
        `<p>${resubscribe ? 'Start receiving the daily email for this event again?' : 'Stop the daily email for this event?'}</p>` +
        `<form method="POST" action="?${escapeAttr(q.toString())}">` +
        `<button type="submit" style="font:inherit;padding:.7em 1.4em;border:0;border-radius:6px;` +
        `background:#20232a;color:#fff;cursor:pointer;">${verb} these emails</button></form>` +
        (resubscribe
          ? ''
          : `<p style="margin-top:1.5rem;font-size:.9rem;color:#5a5f6a;">Changed your mind later? ` +
            `<a href="?${escapeAttr(new URLSearchParams({ e: eventId, u: uid, t: token, a: 'resubscribe' }).toString())}">Turn them back on</a>.</p>`);
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
