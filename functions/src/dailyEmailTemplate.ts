/**
 * Daily engagement email TEMPLATE (issue #616, plans/daily-cards-wireframes.html
 * frame `#fx-email-anatomy` and the binding `sec-email` constraints callout).
 * One skeleton, skinned by the Day's Theme tokens; the module order is the
 * wireframe's numbered legend and never moves.
 *
 * Every constraint the design states is implemented here, and each is a real
 * mail-client limitation rather than a stylistic preference:
 *
 *   - 600px SINGLE-COLUMN TABLE layout. Outlook 2016-2019 renders through Word,
 *     which supports neither flexbox nor grid; nested `<table>` is the only
 *     layout primitive every client agrees on.
 *   - STYLES INLINE, literal hex on `bgcolor`/`style`. Gmail strips `<style>`
 *     blocks in several contexts and resolves no CSS custom properties at all,
 *     so a Theme token has to arrive as `#33c6ff`, never `var(--primary)`.
 *   - DISPLAY TYPE declared `'Bebas Neue','Arial Narrow',Arial` and designed to
 *     survive the fallback: Bebas Neue does not load in mail clients, so the
 *     header is set in the fallback's metrics, not the webfont's.
 *   - EXPLICIT bg AND ink on EVERY module. Gmail and Outlook dark modes invert
 *     colors they consider unmanaged; a module that declares both leaves them
 *     nothing to grab. The light-Theme Day (`fog-froth-farewells`) is the case
 *     that proves it, and `renderDailyEmailHtml` is exercised against it.
 *   - A BULLETPROOF CTA — padded table cell with a border, plus a VML fill for
 *     Outlook — never an image, so the primary action survives image blocking.
 *   - A PLAIN-TEXT MIRROR (`renderDailyEmailText`) in the same module order, so
 *     `multipart/alternative` degrades to something still worth reading.
 *
 * COLOR PAIRINGS are the app's audited ones, used in both directions. Body
 * copy is `--ink` on `--panel` and secondary copy is `--dim` on `--panel`/
 * `--bg` — three of the eight pairs `src/theme/w1-themes.test.tsx` holds to the
 * 4.5:1 floor for every Theme. The Theme band and the CTA invert one of them,
 * painting `--bg` ON `--primary`, which carries the SAME ratio (contrast is
 * symmetric) rather than an unaudited one. That is why the header sets its type
 * in `--bg` instead of `--ink`: on a light Theme, `--ink` on `--primary` would
 * be dark-on-dark.
 *
 * Pure: takes a `DailyEmailModel` and returns strings. No I/O, no SDKs.
 */
import type { DailyEmailModel, StandingsRow } from './dailyEmailContent';

/** Escape text before it is interpolated into markup. Mirrors `notify.ts`'s
 *  helper — every model string is Firestore-sourced (Event name, Player display
 *  names, Day copy), so none of it may reach the body unescaped. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A URL safe to put in `href`. Only `https:` survives — the links in this email
 * are built from Firestore data (the Event's canonical host) and a param, and a
 * `javascript:`/`data:` scheme reaching an anchor is the one templating mistake
 * that turns a newsletter into a delivery vector. Anything else renders as `#`,
 * a dead link rather than a live hazard.
 */
export function safeUrl(url: string): string {
  try {
    return new URL(url).protocol === 'https:' ? esc(url) : '#';
  } catch {
    return '#';
  }
}

const WIDTH = 600;
const DISPLAY_STACK = "'Bebas Neue','Arial Narrow',Arial,Helvetica,sans-serif";
const BODY_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** One content module: an explicitly-painted panel row. `bgcolor` AND an inline
 *  `background-color` because Outlook honors the attribute and Gmail the style. */
function moduleOpen(panel: string, ink: string): string {
  return (
    `<tr><td bgcolor="${panel}" style="background-color:${panel};color:${ink};` +
    `padding:20px 24px;font-family:${BODY_STACK};font-size:15px;line-height:1.5;">`
  );
}

function moduleHeading(text: string, dim: string): string {
  return (
    `<div style="font-family:${BODY_STACK};font-size:11px;letter-spacing:.12em;` +
    `text-transform:uppercase;color:${dim};padding-bottom:10px;">${esc(text)}</div>`
  );
}

function standingsRowHtml(row: StandingsRow, model: DailyEmailModel): string {
  const { ink, dim, accent } = model.theme;
  const star = row.starred ? ' ⭐' : '';
  const stat = `${row.bingoCount} bingo${row.bingoCount === 1 ? '' : 's'} · ${row.squaresMarked} sq`;
  return (
    `<tr>` +
    `<td width="28" style="color:${accent};font-family:${DISPLAY_STACK};font-size:18px;` +
    `padding:3px 0;">${row.rank}</td>` +
    `<td style="color:${ink};font-size:15px;font-weight:bold;padding:3px 0;">` +
    `${esc(row.displayName)}${star}</td>` +
    `<td align="right" style="color:${dim};font-size:13px;padding:3px 0;white-space:nowrap;">` +
    `${esc(stat)}</td>` +
    `</tr>`
  );
}

/**
 * The bulletproof "Open the Feed" button: a bordered, padded table cell that
 * every client can paint, wrapped in the Outlook-only VML rectangle that gives
 * the Word renderer a real fill (it ignores `background-color` on `<a>` and
 * cell padding around one). The conditional comments are invisible everywhere
 * else, so the two constructions never both render.
 */
function ctaHtml(model: DailyEmailModel): string {
  const { primary, secondary, bg } = model.theme;
  const href = safeUrl(model.ctaUrl);
  const label = esc(model.ctaLabel);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">` +
    `<tr><td align="center" bgcolor="${primary}" style="background-color:${primary};` +
    `background-image:linear-gradient(135deg,${primary},${secondary});border-radius:6px;">` +
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" ` +
    `xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" ` +
    `style="height:44px;v-text-anchor:middle;width:240px;" arcsize="14%" ` +
    `strokecolor="${primary}" fillcolor="${primary}"><w:anchorlock/>` +
    `<center style="color:${bg};font-family:${BODY_STACK};font-size:16px;font-weight:bold;">` +
    `${label}</center></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-- -->` +
    `<a href="${href}" style="display:inline-block;padding:13px 32px;font-family:${BODY_STACK};` +
    `font-size:16px;font-weight:bold;color:${bg};text-decoration:none;border:1px solid ${primary};` +
    `border-radius:6px;">${label}</a>` +
    `<!--<![endif]-->` +
    `</td></tr></table>`
  );
}

/**
 * Render the HTML part. Self-contained: no external stylesheet, no webfont
 * request, no tracking pixel, and no image at all — the Theme is painted in
 * background colors, so an image-blocking client loses nothing.
 */
export function renderDailyEmailHtml(model: DailyEmailModel): string {
  const { bg, panel, ink, dim, primary, secondary, accent } = model.theme;
  const s = model.standings;

  const standingsBody =
    s.rows.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
        s.rows.map((r) => standingsRowHtml(r, model)).join('') +
        `</table>` +
        (s.youLine
          ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid ${dim};` +
            `color:${ink};font-size:14px;">${esc(s.youLine)}</div>`
          : '')
      : `<div style="color:${ink};font-size:15px;">${esc(s.emptyLine ?? '')}</div>`;

  return (
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ` +
    `"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">` +
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">` +
    `<head>` +
    `<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    // Declaring both schemes tells Apple Mail and iOS not to re-tint a design
    // that has already committed to its own colors.
    `<meta name="color-scheme" content="light dark" />` +
    `<meta name="supported-color-schemes" content="light dark" />` +
    `<title>${esc(model.subject)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background-color:${bg};">` +
    // ① Preheader: hidden in the body, shown beside the subject. The trailing
    // zero-width run stops clients from pulling the Theme header's words in
    // after it and blowing past the ~85 characters the design budgets.
    `<div style="display:none;font-size:1px;color:${bg};line-height:1px;max-height:0;` +
    `max-width:0;opacity:0;overflow:hidden;">${esc(model.preheader)}` +
    '&#8203;'.repeat(60) +
    `</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `bgcolor="${bg}" style="background-color:${bg};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:${WIDTH}px;max-width:100%;">` +
    // ② Theme header — the module that makes the email resemble the Day.
    `<tr><td bgcolor="${primary}" style="background-color:${primary};` +
    `background-image:linear-gradient(135deg,${primary},${secondary});padding:22px 24px;">` +
    `<div style="font-family:${BODY_STACK};font-size:11px;letter-spacing:.14em;` +
    `text-transform:uppercase;color:${bg};opacity:.85;">${esc(model.footerBrandLine)}</div>` +
    `<div style="font-family:${DISPLAY_STACK};font-size:30px;line-height:1.15;` +
    `letter-spacing:.02em;color:${bg};padding-top:6px;">${esc(model.themeHeadline)}</div>` +
    `<div style="font-family:${BODY_STACK};font-size:13px;color:${bg};padding-top:6px;">` +
    `${esc(model.contextLine)}</div>` +
    // The Theme's palette strip: five literal-hex cells, no image.
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="margin-top:12px;"><tr>` +
    [primary, secondary, accent, panel, bg]
      .map(
        (hex) =>
          `<td width="34" height="6" bgcolor="${hex}" ` +
          `style="background-color:${hex};font-size:0;line-height:0;">&nbsp;</td>` +
          `<td width="4" style="font-size:0;line-height:0;">&nbsp;</td>`,
      )
      .join('') +
    `</tr></table>` +
    `</td></tr>` +
    `<tr><td height="8" style="font-size:0;line-height:0;">&nbsp;</td></tr>` +
    // ③ Standings snapshot.
    moduleOpen(panel, ink) +
    moduleHeading(s.heading, dim) +
    standingsBody +
    `</td></tr>` +
    `<tr><td height="8" style="font-size:0;line-height:0;">&nbsp;</td></tr>` +
    // ④ Participation nudge.
    moduleOpen(panel, ink) +
    moduleHeading(model.nudgeHeading, dim) +
    `<div>${esc(model.nudgeLine)}</div>` +
    (model.tonightLine
      ? `<div style="padding-top:8px;"><strong>Tonight:</strong> ${esc(model.tonightLine)}</div>`
      : '') +
    `</td></tr>` +
    `<tr><td height="8" style="font-size:0;line-height:0;">&nbsp;</td></tr>` +
    // ⑤ Photos + the Most-Loved Photo award (#534).
    moduleOpen(panel, ink) +
    moduleHeading(model.photosHeading, dim) +
    `<div><strong>${esc(model.photosLead)}</strong> ${esc(model.photosRest)}</div>` +
    `<div style="padding-top:8px;">📷 The <strong style="color:${accent};">` +
    `${esc(model.awardLead)}</strong>${esc(model.awardRest)}</div>` +
    `</td></tr>` +
    `<tr><td height="8" style="font-size:0;line-height:0;">&nbsp;</td></tr>` +
    // ⑥ Primary CTA.
    `<tr><td bgcolor="${panel}" align="center" style="background-color:${panel};padding:22px 24px;">` +
    ctaHtml(model) +
    `</td></tr>` +
    // ⑦ Footer: sender identity, why-you-got-this, visible unsubscribe.
    `<tr><td bgcolor="${bg}" style="background-color:${bg};color:${dim};padding:18px 24px;` +
    `font-family:${BODY_STACK};font-size:12px;line-height:1.6;">` +
    `<strong style="color:${ink};">${esc(model.footerBrandLine)}</strong> — ` +
    `${esc(model.footerWhyLine)}<br />` +
    `<a href="${safeUrl(model.unsubscribeUrl)}" style="color:${dim};">Unsubscribe</a> · ` +
    `<a href="${safeUrl(model.preferencesUrl)}" style="color:${dim};">Email preferences</a>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/**
 * The plain-text part. Same module order as the HTML — theme line, standings,
 * nudge, photos + award, Feed URL, unsubscribe URL — so the email still works
 * with images and styling stripped entirely, which is also how it reads in
 * every accessibility and deliverability tool that prefers `text/plain`.
 */
export function renderDailyEmailText(model: DailyEmailModel): string {
  const s = model.standings;
  const lines: string[] = [
    model.preheader,
    '',
    model.themeHeadline,
    model.contextLine,
    '',
    s.heading.toUpperCase(),
  ];
  if (s.rows.length > 0) {
    for (const r of s.rows) {
      const star = r.starred ? ' *' : '';
      lines.push(
        `${r.rank}. ${r.displayName}${star} — ${r.bingoCount} bingo${r.bingoCount === 1 ? '' : 's'}, ${r.squaresMarked} squares`,
      );
    }
    if (s.youLine) lines.push('', s.youLine);
  } else {
    lines.push(s.emptyLine ?? '');
  }
  lines.push('', model.nudgeHeading.toUpperCase(), model.nudgeLine);
  if (model.tonightLine) lines.push(`Tonight: ${model.tonightLine}`);
  lines.push(
    '',
    model.photosHeading.toUpperCase(),
    `${model.photosLead} ${model.photosRest}`,
    `The ${model.awardLead}${model.awardRest}`,
    '',
    `${model.ctaLabel}: ${model.ctaUrl}`,
    '',
    `${model.footerBrandLine} — ${model.footerWhyLine}`,
    `Unsubscribe: ${model.unsubscribeUrl}`,
    `Email preferences: ${model.preferencesUrl}`,
    '',
  );
  return lines.join('\n');
}
