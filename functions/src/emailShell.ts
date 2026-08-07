/**
 * The email SHELL — the wireframe's one skeleton, shared by every Theme-styled
 * send (`plans/daily-cards-wireframes.html` § "Daily engagement email", frame
 * `#fx-email-anatomy` and the binding `sec-email` constraints callout).
 *
 * WHY THIS FILE EXISTS. The wireframe is explicit that the anatomy is a
 * PLATFORM artifact — "the Editions change the words and the Day changes the
 * palette, but the module order never moves" — and #638 adds a second family
 * (the admin digest) that has to look like the first. Two renderers each
 * carrying their own copy of the 600px table, the literal-hex painting rules
 * and the VML button is exactly how the two would drift apart, so the skeleton
 * lives here once and each family supplies only its own module CONTENT.
 *
 * Every constraint below is a real mail-client limitation, not a stylistic
 * preference, and each is asserted in the suites of both consumers:
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
 *     that proves it, and both families are exercised against it.
 *   - A BULLETPROOF CTA — padded table cell with a border, plus a VML fill for
 *     Outlook — never an image, so the primary action survives image blocking.
 *
 * COLOR PAIRINGS are the app's audited ones, used in both directions. Body copy
 * is `--ink` on `--panel` and secondary copy is `--dim` on `--panel`/`--bg` —
 * three of the eight pairs `src/theme/w1-themes.test.tsx` holds to the 4.5:1
 * floor for every Theme. The Theme band and the CTA invert one of them, painting
 * `--bg` ON `--primary`, which carries the SAME ratio (contrast is symmetric)
 * rather than an unaudited one. That is why the header sets its type in `--bg`
 * instead of `--ink`: on a light Theme, `--ink` on `--primary` would be
 * dark-on-dark.
 *
 * Pure: every export takes its arguments and returns a string. No I/O, no SDKs.
 */
import type { EmailThemeTokens } from './dailyEmailTheme';

/** Escape text before it is interpolated into markup. Every string that reaches
 *  a body here is Firestore-sourced (Event name, Player display names, Prompt
 *  text, Day copy), so none of it may be interpolated raw. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A URL safe to put in `href`. Only `https:` survives — the links in these
 * emails are built from Firestore data (the Event's canonical host) and a
 * param, and a `javascript:`/`data:` scheme reaching an anchor is the one
 * templating mistake that turns a newsletter into a delivery vector. Anything
 * else renders as `#`, a dead link rather than a live hazard.
 */
export function safeUrl(url: string): string {
  try {
    return new URL(url).protocol === 'https:' ? esc(url) : '#';
  } catch {
    return '#';
  }
}

export const WIDTH = 600;
export const DISPLAY_STACK = "'Bebas Neue','Arial Narrow',Arial,Helvetica,sans-serif";
export const BODY_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** One content module's opening cell: an explicitly-painted panel row.
 *  `bgcolor` AND an inline `background-color` because Outlook honors the
 *  attribute and Gmail the style. */
export function moduleOpen(panel: string, ink: string): string {
  return (
    `<tr><td bgcolor="${panel}" style="background-color:${panel};color:${ink};` +
    `padding:20px 24px;font-family:${BODY_STACK};font-size:15px;line-height:1.5;">`
  );
}

/** A module's small-caps heading rule. */
export function moduleHeading(text: string, dim: string): string {
  return (
    `<div style="font-family:${BODY_STACK};font-size:11px;letter-spacing:.12em;` +
    `text-transform:uppercase;color:${dim};padding-bottom:10px;">${esc(text)}</div>`
  );
}

/** The 8px gutter between modules. A painted row rather than margin: Outlook
 *  collapses margins on table cells but always honors a sized row. */
export function spacerRow(): string {
  return `<tr><td height="8" style="font-size:0;line-height:0;">&nbsp;</td></tr>`;
}

/**
 * The bulletproof CTA: a bordered, padded table cell that every client can
 * paint, wrapped in the Outlook-only VML rectangle that gives the Word renderer
 * a real fill (it ignores `background-color` on `<a>` and cell padding around
 * one). The conditional comments are invisible everywhere else, so the two
 * constructions never both render.
 */
export function ctaHtml(theme: EmailThemeTokens, url: string, label: string): string {
  const { primary, secondary, bg } = theme;
  const href = safeUrl(url);
  const text = esc(label);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">` +
    `<tr><td align="center" bgcolor="${primary}" style="background-color:${primary};` +
    `background-image:linear-gradient(135deg,${primary},${secondary});border-radius:6px;">` +
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" ` +
    `xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" ` +
    `style="height:44px;v-text-anchor:middle;width:240px;" arcsize="14%" ` +
    `strokecolor="${primary}" fillcolor="${primary}"><w:anchorlock/>` +
    `<center style="color:${bg};font-family:${BODY_STACK};font-size:16px;font-weight:bold;">` +
    `${text}</center></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-- -->` +
    `<a href="${href}" style="display:inline-block;padding:13px 32px;font-family:${BODY_STACK};` +
    `font-size:16px;font-weight:bold;color:${bg};text-decoration:none;border:1px solid ${primary};` +
    `border-radius:6px;">${text}</a>` +
    `<!--<![endif]-->` +
    `</td></tr></table>`
  );
}

/** A whole CTA module row — the painted panel the button sits on. */
export function ctaModule(theme: EmailThemeTokens, url: string, label: string): string {
  return (
    `<tr><td bgcolor="${theme.panel}" align="center" ` +
    `style="background-color:${theme.panel};padding:22px 24px;">` +
    ctaHtml(theme, url, label) +
    `</td></tr>`
  );
}

/**
 * ② The Theme header — the module that makes an email resemble the Day: the
 * Theme name in display type over a two-token gradient band, with the small
 * brand line above it, the context line below, and the Theme's five-swatch
 * palette strip. Five literal-hex cells, no image.
 */
export function themeHeaderHtml(args: {
  theme: EmailThemeTokens;
  brandLine: string;
  headline: string;
  contextLine: string;
}): string {
  const { bg, panel, primary, secondary, accent } = args.theme;
  return (
    `<tr><td bgcolor="${primary}" style="background-color:${primary};` +
    `background-image:linear-gradient(135deg,${primary},${secondary});padding:22px 24px;">` +
    `<div style="font-family:${BODY_STACK};font-size:11px;letter-spacing:.14em;` +
    `text-transform:uppercase;color:${bg};opacity:.85;">${esc(args.brandLine)}</div>` +
    `<div style="font-family:${DISPLAY_STACK};font-size:30px;line-height:1.15;` +
    `letter-spacing:.02em;color:${bg};padding-top:6px;">${esc(args.headline)}</div>` +
    `<div style="font-family:${BODY_STACK};font-size:13px;color:${bg};padding-top:6px;">` +
    `${esc(args.contextLine)}</div>` +
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
    `</td></tr>`
  );
}

/**
 * ⑦ The footer row: brand line, the why-you-got-this sentence, and whatever
 * links the family carries (the daily email's unsubscribe pair; the admin
 * digest's console link). `linksHtml` is pre-rendered markup, so a caller with
 * no links passes `''` and gets no trailing separator.
 */
export function footerRow(args: {
  theme: EmailThemeTokens;
  brandLine: string;
  whyLine: string;
  linksHtml?: string;
}): string {
  const { bg, ink, dim } = args.theme;
  return (
    `<tr><td bgcolor="${bg}" style="background-color:${bg};color:${dim};padding:18px 24px;` +
    `font-family:${BODY_STACK};font-size:12px;line-height:1.6;">` +
    `<strong style="color:${ink};">${esc(args.brandLine)}</strong>—` +
    `${esc(args.whyLine)}` +
    (args.linksHtml ? `<br />${args.linksHtml}` : '') +
    `</td></tr>`
  );
}

/**
 * Wrap a family's rows in the document: the head that declares both color
 * schemes, ① the hidden preheader, and the outer/inner 600px tables.
 *
 * Self-contained by construction — no external stylesheet, no webfont request,
 * no tracking pixel and no `<img>` at all, because every Theme surface is
 * painted in background colors, so an image-blocking client loses nothing.
 */
export function renderEmailDocument(args: {
  theme: EmailThemeTokens;
  title: string;
  preheader: string;
  /** The inner table's `<tr>` rows, in module order. */
  rows: string;
}): string {
  const { bg } = args.theme;
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
    `<title>${esc(args.title)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background-color:${bg};">` +
    // ① Preheader: hidden in the body, shown beside the subject. The trailing
    // zero-width run stops clients from pulling the Theme header's words in
    // after it and blowing past the ~85 characters the design budgets.
    `<div style="display:none;font-size:1px;color:${bg};line-height:1px;max-height:0;` +
    `max-width:0;opacity:0;overflow:hidden;">${esc(args.preheader)}` +
    '&#8203;'.repeat(60) +
    `</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `bgcolor="${bg}" style="background-color:${bg};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:${WIDTH}px;max-width:100%;">` +
    args.rows +
    `</table></td></tr></table></body></html>`
  );
}
