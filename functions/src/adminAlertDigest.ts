/**
 * Admin notification digest — the CONTENT and the rendering (issue #638,
 * specs/admin-notification-emails.md).
 *
 * The second family to render the wireframe's anatomy
 * (`plans/daily-cards-wireframes.html` § "Daily engagement email", frame
 * `#fx-email-anatomy`). It shares the skeleton with the daily engagement email
 * through `emailShell.ts` — the same 600px table, the same Theme header band,
 * the same bulletproof CTA — and supplies its own modules:
 *
 *   ① Preheader        ~85 characters: how much is waiting, for which Event.
 *   ② Theme header     the Day's palette and the admin brand line.
 *   ③ Abuse reports    bug reports the reporter marked `abuse` (#670) — first,
 *                       because it is the only module with no automated
 *                       backstop and no console queue behind it.
 *   ④ Awaiting approval community Prompts sitting `pending`.
 *   ⑤ Reported & hidden reported content and moderation transitions, one row
 *                       per piece of content rather than one per event.
 *   ⑥ Primary CTA      "Open the Review queue" — the moderation surface.
 *   ⑦ Footer           who this went to and why.
 *
 * TWO DELIBERATE DEPARTURES from the daily email's seven modules, both because
 * this is operational mail rather than engagement mail:
 *
 *   NO UNSUBSCRIBE. The daily email is opt-in marketing to participants and
 *   carries a visible link plus `List-Unsubscribe` headers. This goes to the
 *   people who administer the Event, about work only they can do; the way to
 *   stop receiving it is to stop being an admin (or to clear
 *   `ADMIN_NOTIFY_EMAIL`), not a per-message opt-out that would silently
 *   suppress moderation notices.
 *
 *   AN EMPTY MODULE IS OMITTED, not rendered empty. The daily email's standings
 *   module has a designed empty state because it appears every day either way;
 *   a digest with nothing to approve should simply not carry an approvals
 *   heading.
 *
 * Pure, like `dailyEmailContent.ts`: no `firebase-admin`, no
 * `firebase-functions`, no I/O. `adminAlerts.ts` reads Firestore and hands the
 * results in.
 */
import { deriveReason } from './notify';
import { registerFor } from './dailyEmailContent';
import { emailThemeTokens, type EmailThemeTokens } from './dailyEmailTheme';
import {
  BODY_STACK,
  ctaModule,
  esc,
  footerRow,
  moduleHeading,
  moduleOpen,
  renderEmailDocument,
  spacerRow,
  themeHeaderHtml,
} from './emailShell';

// --- Inputs ---------------------------------------------------------------------

/** One queued alert as the digest reads it back. Mirrors the stored document;
 *  `adminAlerts.ts` owns the read-boundary sanitization that produces it. */
export interface AdminAlertRecord {
  id: string;
  kind: 'item-created' | 'content-reported' | 'moderation' | 'abuse-reported';
  collection: 'items' | 'proofs' | 'bugReports';
  docId: string;
  label: string;
  status: string;
  visionFlag: string | null;
  reportCount: number;
  createdAt: number;
}

/** One Day, as the digest reads it — enough to pick the Theme and say which Day
 *  the Event is on. A `Pick` of the canonical `DayDef` in spirit; kept local and
 *  fully optional because this reads RAW Firestore documents. */
export interface DigestDay {
  index?: number;
  unlockAt?: number;
  theme?: string;
}

/** The Event fields the digest reads. */
export interface DigestEvent {
  name?: string;
  days?: DigestDay[];
  settings?: { reportHideThreshold?: number };
}

// --- Model ----------------------------------------------------------------------

/** One rendered row: what it is, and what about it needs attention. */
export interface DigestRow {
  label: string;
  detail: string;
}

/** One rendered module. Sections with no rows are never built. */
export interface DigestSection {
  heading: string;
  rows: DigestRow[];
  /** Rows beyond the render cap, summarised rather than dropped silently. */
  overflow: number;
  /** Where the overflow rows can actually be found. The moderation modules
   *  point at the Review queue the CTA opens; the abuse module cannot, because
   *  bug reports have no console surface — they are pulled with
   *  `npm run bugs:pull` (specs/w4-bug-report-inbox.md). Naming the wrong place
   *  would be worse than naming none. */
  overflowIn: string;
}

/** The default overflow destination: the surface the digest's own CTA opens. */
const REVIEW_QUEUE = 'the Review queue';

export interface AdminDigestModel {
  theme: EmailThemeTokens;
  subject: string;
  preheader: string;
  brandLine: string;
  headline: string;
  contextLine: string;
  sections: DigestSection[];
  ctaLabel: string;
  ctaUrl: string;
  footerBrandLine: string;
  footerWhyLine: string;
  footerNote: string;
}

/** Rows rendered per module before the overflow line takes over. Generous
 *  enough that a normal digest never truncates, small enough that a runaway
 *  import produces a readable email rather than a 200-row wall. */
export const ROWS_PER_SECTION = 15;

/**
 * The Day whose Theme skins this digest: the most recently unlocked one, so an
 * admin email arriving mid-cruise carries the same palette as the app they are
 * about to open. Falls back to the first Day before the Event has started, and
 * to `undefined` for an Event with no schedule at all — at which point
 * `emailThemeTokens` degrades to the EDITION's default Theme rather than to
 * grey or to another product's identity (#623 P2).
 *
 * `unlockAt <= 0` is the "live pre-event" sentinel (#289), not a real instant,
 * so it never counts as unlocked.
 */
export function currentThemeDay(
  days: readonly DigestDay[] | undefined,
  now: number,
): DigestDay | undefined {
  const list = Array.isArray(days) ? days : [];
  let latest: DigestDay | undefined;
  for (const day of list) {
    const at = day?.unlockAt;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now) continue;
    if (!latest || at > (latest.unlockAt as number)) latest = day;
  }
  return latest ?? list[0];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The detail line for a reported/moderated row — the one place this family
 * makes a causal claim, and it makes only claims the stored facts support.
 *
 * `deriveReason` is `notify.ts`'s, reused rather than re-derived: it names a
 * Vision flag from itself, calls a hide `reports >= threshold` only when the
 * count and the Event threshold are both known and the count is at/over it,
 * `by an admin` when both are known and it is under, and nothing at all when
 * either is unknown. So a manual hide of an unreported Prompt is never
 * mislabelled as a threshold hide (#101 Codex R2 F1).
 *
 * A still-active report additionally shows the distance to the auto-hide bar,
 * which is the number an admin actually acts on.
 */
export function reviewDetail(alert: AdminAlertRecord, threshold: number | null): string {
  const reports = plural(alert.reportCount, 'report', 'reports');
  if (alert.kind === 'moderation') {
    const reason = deriveReason(
      { status: alert.status, visionFlag: alert.visionFlag, reportCount: alert.reportCount },
      threshold,
    );
    return `${alert.status}${reason ? ` (${reason})` : ''} · ${reports}`;
  }
  if (typeof threshold === 'number' && threshold > 0 && alert.reportCount < threshold) {
    const remaining = threshold - alert.reportCount;
    return `reported · ${reports} · ${plural(remaining, 'more', 'more')} to auto-hide`;
  }
  return `reported · ${reports}`;
}

function sectionFrom(heading: string, rows: DigestRow[], overflowIn = REVIEW_QUEUE): DigestSection | null {
  if (rows.length === 0) return null;
  return {
    heading,
    rows: rows.slice(0, ROWS_PER_SECTION),
    overflow: Math.max(0, rows.length - ROWS_PER_SECTION),
    overflowIn,
  };
}

export interface BuildAdminDigestArgs {
  event: DigestEvent;
  eventId: string;
  alerts: readonly AdminAlertRecord[];
  edition: string | null;
  /** The Event's canonical origin — `https://host`, no trailing slash. */
  origin: string;
  now: number;
}

/**
 * Assemble one Event's digest.
 *
 * THE REVIEW MODULE IS KEYED BY CONTENT, NOT BY ALERT. A report that trips the
 * auto-hide produces two queued alerts — the `reportCount` rise, then the
 * server's `status → hidden` write — and both are true. Rendering them as two
 * rows would tell an admin that two things happened to two things. They are
 * collapsed to one row per document. Approvals are not collapsed, because each
 * `pending` Prompt is genuinely its own piece of work.
 *
 * THE MODERATION STATE WINS THE COLLAPSE, ahead of `createdAt`. The two writes
 * reach two independent trigger invocations whose handler wall-clocks can
 * interleave, so a late report enqueue can carry a NEWER `createdAt` than the
 * hide it preceded — and "latest wins" would then render hidden content as
 * merely reported. The sender re-reads the document and stamps every row with
 * its live state before this runs, so in practice both candidates already agree;
 * this ordering is the second line, for the fail-open path where that re-read
 * failed and only the stored facts are available.
 */
export function buildAdminDigestModel(args: BuildAdminDigestArgs): AdminDigestModel {
  const { event, alerts, origin, now } = args;
  const register = registerFor(args.edition);
  const days = Array.isArray(event.days) ? event.days : [];
  const day = currentThemeDay(days, now);
  const theme = emailThemeTokens(day?.theme, args.edition);
  const eventName = (event.name ?? '').trim() || 'this event';
  const threshold =
    typeof event.settings?.reportHideThreshold === 'number' ? event.settings.reportHideThreshold : null;

  const ordered = [...alerts].sort((a, b) => a.createdAt - b.createdAt);

  // ③ Abuse reports — one row per REPORT, never collapsed and never merged into
  // the moderation module (#670).
  //
  // The moderation module keys by content because two reports about one Proof
  // are one piece of work. There is no equivalent key here: a bug report has no
  // subject document to collapse toward, only its own text. So each row stands
  // for one report and says so — the detail line carries the report ID, which is
  // what `npm run bugs:pull` and the inbox key on, and is how an admin tells two
  // rows apart. Deliberately NOT read as "two people": intake has no submission
  // idempotency yet, so a retried submission after a lost response can produce a
  // second report from one reporter (tracked as a follow-up). Two rows mean two
  // reports, which is a claim the digest can actually support.
  const abuse: DigestRow[] = ordered
    .filter((a) => a.kind === 'abuse-reported')
    .map((a) => ({ label: a.label, detail: `abuse report · ${a.docId}` }));

  // ④ Awaiting approval — one row per pending Prompt.
  const approvals: DigestRow[] = ordered
    .filter((a) => a.kind === 'item-created')
    .map((a) => ({ label: a.label, detail: 'new Prompt · pending approval' }));

  // ⑤ Reported & hidden — one row per piece of CONTENT. Moderation outranks a
  // report; among equals the later alert wins. Map insertion order is preserved
  // on overwrite, so a document keeps the position of its FIRST alert and the
  // module still reads in the order things started happening.
  const bestByDoc = new Map<string, AdminAlertRecord>();
  for (const alert of ordered) {
    if (alert.kind === 'item-created' || alert.kind === 'abuse-reported') continue;
    const key = `${alert.collection}/${alert.docId}`;
    const held = bestByDoc.get(key);
    if (held && held.kind === 'moderation' && alert.kind !== 'moderation') continue;
    bestByDoc.set(key, alert);
  }
  const review: DigestRow[] = [...bestByDoc.values()].map((a) => ({
    label: `${a.collection === 'items' ? 'Prompt' : 'Proof'}: ${a.label}`,
    detail: reviewDetail(a, threshold),
  }));

  // ABUSE LEADS. The wireframe's module order is fixed for the six modules it
  // designs, and this one is new rather than moved: it goes first because it is
  // the only module with no automated backstop behind it. A reported Prompt has
  // the auto-hide threshold, a flagged Proof has Vision, and both sit in a
  // console queue an admin can open later; an abuse report has none of that —
  // nothing acts on it until a person does. It is also the only module that can
  // describe harm happening to a person rather than to content.
  const sections = [
    sectionFrom('Abuse reports', abuse, 'the bug-report inbox'),
    sectionFrom('Awaiting approval', approvals),
    sectionFrom('Reported & hidden', review),
  ].filter((s): s is DigestSection => s !== null);

  // ① Subject and preheader — the counts, in the order an admin triages them.
  const parts: string[] = [];
  if (abuse.length > 0) parts.push(plural(abuse.length, 'abuse report', 'abuse reports'));
  if (approvals.length > 0) parts.push(`${approvals.length} to approve`);
  if (review.length > 0) parts.push(`${review.length} to review`);
  const summary = parts.join(', ');
  const total = abuse.length + approvals.length + review.length;

  // ② Theme header. The Day supplies the palette, so the digest looks like the
  // Event it is about; the headline states the job, because an admin opening
  // this is not being told what the Day's Theme is — they are being told there
  // is work. The Theme's own name rides the context line instead.
  const dayNumber = typeof day?.index === 'number' ? day.index + 1 : null;
  const contextLine = [
    eventName,
    dayNumber !== null && days.length > 0 ? `Day ${dayNumber} of ${days.length}` : '',
    `${theme.emoji} ${theme.label}`,
  ]
    .filter((part) => part !== '')
    .join(' · ');

  return {
    theme,
    subject: `Admin · ${eventName}—${summary}`,
    // DESTINATION-NEUTRAL. It used to say "in the review queue", which is true
    // of approvals and moderation and false of abuse reports — those are not in
    // that queue at all, so an abuse-only digest would send an admin looking at
    // a surface holding none of its work (#670). The count is the useful half;
    // the location belongs to the modules, which each name their own.
    preheader: `${plural(total, 'item', 'items')} waiting for ${eventName}.`,
    brandLine: `${register.brandLine} · Admin`,
    headline: 'Needs your eyes',
    contextLine,
    sections,
    ctaLabel: 'Open the Review queue',
    // The admin console lives at REAL sub-routes (specs/admin-console-ia.md):
    // `/more/admin/queue` is the Review queue, which houses reports, pending
    // approvals and claims together. NOT `/admin`, which routes nowhere and is
    // what the pre-#638 notifier linked to.
    ctaUrl: `${origin}/more/admin/queue`,
    footerBrandLine: register.brandLine,
    footerWhyLine: `You're getting this because you're an admin of ${eventName}.`,
    footerNote: 'Admin alerts are batched—one email per Event per sweep, never one per write.',
  };
}

// --- Rendering ------------------------------------------------------------------

/**
 * One row, STACKED rather than the daily email's label/stat two-column pair.
 *
 * That family's right-hand cell is a fixed short stat (`4 bingos · 41 sq`) and
 * can safely be `nowrap`. These details are variable-length sentences —
 * `reported · 2 reports · 2 more to auto-hide` — sitting beside a label that is
 * up to eighty characters of somebody's Prompt. Side by side, that pair either
 * blows past the 600px canvas on a phone or crushes the label to one word per
 * line. Stacking makes the row's height the only thing that varies, which is
 * the one dimension an email can afford to vary in.
 */
function rowHtml(row: DigestRow, ink: string, dim: string): string {
  return (
    `<tr><td style="padding:5px 0;">` +
    `<div style="color:${ink};font-size:15px;font-weight:bold;line-height:1.35;">${esc(row.label)}</div>` +
    `<div style="color:${dim};font-size:13px;line-height:1.4;padding-top:2px;">${esc(row.detail)}</div>` +
    `</td></tr>`
  );
}

function sectionHtml(section: DigestSection, theme: EmailThemeTokens): string {
  const { panel, ink, dim, accent } = theme;
  const rows = section.rows.map((row) => rowHtml(row, ink, dim)).join('');
  const overflow =
    section.overflow > 0
      ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid ${dim};` +
        `color:${accent};font-size:13px;">${esc(`+${section.overflow} more in ${section.overflowIn}`)}</div>`
      : '';
  return (
    moduleOpen(panel, ink) +
    moduleHeading(section.heading, dim) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    rows +
    `</table>` +
    overflow +
    `</td></tr>`
  );
}

/** Render the HTML part. Self-contained — no stylesheet, no webfont, no image,
 *  no tracking pixel — so it survives image blocking and dark-mode inversion
 *  exactly as the daily email does. */
export function renderAdminDigestHtml(model: AdminDigestModel): string {
  const rows =
    themeHeaderHtml({
      theme: model.theme,
      brandLine: model.brandLine,
      headline: model.headline,
      contextLine: model.contextLine,
    }) +
    model.sections.map((section) => spacerRow() + sectionHtml(section, model.theme)).join('') +
    spacerRow() +
    ctaModule(model.theme, model.ctaUrl, model.ctaLabel) +
    footerRow({
      theme: model.theme,
      brandLine: model.footerBrandLine,
      whyLine: model.footerWhyLine,
      linksHtml:
        `<span style="font-family:${BODY_STACK};">${esc(model.footerNote)}</span>`,
    });

  return renderEmailDocument({
    theme: model.theme,
    title: model.subject,
    preheader: model.preheader,
    rows,
  });
}

/** The plain-text part, in the same module order, so `multipart/alternative`
 *  degrades to something an admin can still triage from a watch. */
export function renderAdminDigestText(model: AdminDigestModel): string {
  const lines: string[] = [model.preheader, '', model.headline, model.contextLine];
  for (const section of model.sections) {
    lines.push('', section.heading.toUpperCase());
    for (const row of section.rows) lines.push(`- ${row.label}—${row.detail}`);
    if (section.overflow > 0) lines.push(`+${section.overflow} more in ${section.overflowIn}`);
  }
  lines.push(
    '',
    `${model.ctaLabel}: ${model.ctaUrl}`,
    '',
    `${model.footerBrandLine}—${model.footerWhyLine}`,
    model.footerNote,
    '',
  );
  return lines.join('\n');
}
