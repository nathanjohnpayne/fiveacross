/**
 * Winner-announcement email TEMPLATE (issue #1192,
 * `plans/daily-cards-wireframes.html` frames `#fx-email-finale-gcb` /
 * `#fx-email-finale-fa`). Composes the same `emailShell.ts` skeleton the daily
 * card and the admin digest compose — the anatomy is a platform artifact, and
 * a third copy of the 600px table is how three families would drift.
 *
 * Module order is the frame's numbered legend and never moves: Theme header,
 * final standings, the ⭐, most-loved photo, where you finished, sign-off +
 * CTA, footer. Three of those modules are CONDITIONAL — the ⭐ and the award
 * are omitted when the Event has no holder rather than printing a withheld
 * honour (#1121's lesson), and the placing line is omitted for an off-roster
 * address — so the skeleton renders a shorter email, never an emptier one.
 *
 * Pure: takes a `PodiumEmailModel` and returns strings. No I/O, no SDKs.
 */
import type { FinaleStandingsRow, PodiumEmailModel } from './podiumEmailContent';
import { finaleStatLine } from './podiumEmailContent';
import {
  BODY_STACK,
  DISPLAY_STACK,
  ctaHtml,
  esc,
  footerRow,
  moduleHeading,
  moduleOpen,
  renderEmailDocument,
  safeUrl,
  spacerRow,
  themeHeaderHtml,
} from './emailShell';

/** One standings row. Structurally the daily card's row without the ⭐ append:
 *  the honour is its own module here (frame legend item 4). */
function standingsRowHtml(row: FinaleStandingsRow, model: PodiumEmailModel): string {
  const { ink, dim, accent } = model.theme;
  return (
    `<tr>` +
    `<td width="28" style="color:${accent};font-family:${DISPLAY_STACK};font-size:18px;` +
    `padding:3px 0;">${row.rank}</td>` +
    `<td style="color:${ink};font-size:15px;font-weight:bold;padding:3px 0;">` +
    `${esc(row.displayName)}</td>` +
    `<td align="right" style="color:${dim};font-size:13px;padding:3px 0;white-space:nowrap;">` +
    `${esc(finaleStatLine(row))}</td>` +
    `</tr>`
  );
}

/** A one-sentence module, or `''` when the model resolved its line to `null`.
 *  Returning the empty string rather than an empty panel is what makes the
 *  conditional modules disappear instead of rendering a blank box — and it
 *  takes the module's own spacer with it. */
function sentenceModule(
  model: PodiumEmailModel,
  heading: string,
  line: string | null,
  leadEmoji?: string,
): string {
  if (!line) return '';
  const { panel, ink, dim, accent } = model.theme;
  const lead = leadEmoji ? `${leadEmoji} ` : '';
  return (
    moduleOpen(panel, ink) +
    moduleHeading(heading, dim) +
    `<div>${lead}<strong style="color:${accent};">${esc(line)}</strong></div>` +
    `</td></tr>` +
    spacerRow()
  );
}

/**
 * Render the HTML part. Self-contained: no external stylesheet, no webfont
 * request, no tracking pixel and no image at all — the Theme is painted in
 * background colors, so an image-blocking client loses nothing.
 */
export function renderPodiumEmailHtml(model: PodiumEmailModel): string {
  const { panel, ink, dim } = model.theme;

  const standingsBody =
    model.standingsRows.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
        model.standingsRows.map((r) => standingsRowHtml(r, model)).join('') +
        `</table>`
      : `<div style="color:${ink};font-size:15px;">${esc(model.standingsEmptyLine ?? '')}</div>`;

  const rows =
    // ② Theme header — the farewell Day's own Theme, with "Final standings" in
    // the slot the daily card gives "Day N".
    themeHeaderHtml({
      theme: model.theme,
      brandLine: model.footerBrandLine,
      headline: model.themeHeadline,
      contextLine: model.contextLine,
    }) +
    spacerRow() +
    // ③ Final standings — row 1 is the podium's `champion` byte for byte.
    moduleOpen(panel, ink) +
    moduleHeading(model.standingsHeading, dim) +
    standingsBody +
    `</td></tr>` +
    spacerRow() +
    // ④ The ⭐, and ⑤ the Most-Loved Photo award — both conditional.
    sentenceModule(model, model.starHeading, model.starLine) +
    sentenceModule(model, model.mostLovedHeading, model.mostLovedLine, '📷') +
    // ⑥ Where you finished — the only per-recipient variance, omitted for an
    // address that is not on the roster.
    (model.youLine
      ? moduleOpen(panel, ink) +
        `<div style="color:${ink};font-size:14px;">${esc(model.youLine)}</div>` +
        `</td></tr>` +
        spacerRow()
      : '') +
    // ⑦ Sign-off + CTA in ONE module: the closing line is what the button is
    // for, so a spacer between them would read as two unrelated beats.
    moduleOpen(panel, ink) +
    `<div style="padding-bottom:16px;">${esc(model.signOffLine)}</div>` +
    `<div style="text-align:center;">${ctaHtml(model.theme, model.ctaUrl, model.ctaLabel)}</div>` +
    `</td></tr>` +
    // ⑧ Footer — identical to the daily card's, because this send is governed
    // by the same opt-in and the same unsubscribe.
    footerRow({
      theme: model.theme,
      brandLine: model.footerBrandLine,
      whyLine: model.footerWhyLine,
      linksHtml:
        `<a href="${safeUrl(model.unsubscribeUrl)}" style="color:${dim};">Unsubscribe</a> · ` +
        `<a href="${safeUrl(model.preferencesUrl)}" style="color:${dim};">Email preferences</a>`,
    });

  return renderEmailDocument({
    theme: model.theme,
    title: model.subject,
    preheader: model.preheader,
    rows,
  });
}

/**
 * The plain-text part. Same module order as the HTML, and the same conditional
 * omissions — so the two parts of one `multipart/alternative` message can
 * never state a different result.
 */
export function renderPodiumEmailText(model: PodiumEmailModel): string {
  const lines: string[] = [
    model.preheader,
    '',
    model.themeHeadline,
    model.contextLine,
    '',
    model.standingsHeading.toUpperCase(),
  ];
  if (model.standingsRows.length > 0) {
    for (const r of model.standingsRows) {
      // THE SHARED stat line, not a second spelling of it (CodeRabbit, round 2 on
      // PR #1207). `finaleStatLine` is documented as belonging to both parts, and
      // this renderer was quietly printing "16 bingos, 124 squares" where the
      // HTML printed "16 bingos · 124 sq" — two alternatives of one message
      // disagreeing about the same numbers' presentation is exactly what a
      // shared helper exists to prevent.
      lines.push(`${r.rank}. ${r.displayName}—${finaleStatLine(r)}`);
    }
  } else {
    lines.push(model.standingsEmptyLine ?? '');
  }
  if (model.starLine) lines.push('', model.starHeading.toUpperCase(), model.starLine);
  if (model.mostLovedLine) {
    lines.push('', model.mostLovedHeading.toUpperCase(), model.mostLovedLine);
  }
  if (model.youLine) lines.push('', model.youLine);
  lines.push(
    '',
    model.signOffLine,
    '',
    `${model.ctaLabel}: ${model.ctaUrl}`,
    '',
    `${model.footerBrandLine}—${model.footerWhyLine}`,
    `Unsubscribe: ${model.unsubscribeUrl}`,
    `Email preferences: ${model.preferencesUrl}`,
    '',
  );
  return lines.join('\n');
}

export { BODY_STACK };
