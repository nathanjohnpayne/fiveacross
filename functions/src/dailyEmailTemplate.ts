/**
 * Daily engagement email TEMPLATE (issue #616, plans/daily-cards-wireframes.html
 * frame `#fx-email-anatomy` and the binding `sec-email` constraints callout).
 * One skeleton, skinned by the Day's Theme tokens; the module order is the
 * wireframe's numbered legend and never moves.
 *
 * The SKELETON — the 600px table, the literal-hex painting rules, the Theme
 * header band, the bulletproof CTA, the document wrapper — lives in
 * `emailShell.ts`, which this file composes. That split arrived with #638's
 * admin digest, the second family to render the same anatomy: the wireframe
 * calls the anatomy a platform artifact ("the Editions change the words and the
 * Day changes the palette, but the module order never moves"), so two copies of
 * it is how the two families would drift. Everything below is this family's
 * module CONTENT and nothing else.
 *
 * Pure: takes a `DailyEmailModel` and returns strings. No I/O, no SDKs.
 */
import type { DailyEmailModel, StandingsRow } from './dailyEmailContent';
import {
  BODY_STACK,
  DISPLAY_STACK,
  ctaModule,
  esc,
  footerRow,
  moduleHeading,
  moduleOpen,
  renderEmailDocument,
  safeUrl,
  spacerRow,
  themeHeaderHtml,
} from './emailShell';

/** Re-exported for the callers and tests that reached for it here before the
 *  shell existed; the implementation is `emailShell.safeUrl`. */
export { safeUrl };

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
 * Render the HTML part. Self-contained: no external stylesheet, no webfont
 * request, no tracking pixel, and no image at all — the Theme is painted in
 * background colors, so an image-blocking client loses nothing.
 */
export function renderDailyEmailHtml(model: DailyEmailModel): string {
  const { panel, ink, dim, accent } = model.theme;
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

  const rows =
    // ② Theme header — the module that makes the email resemble the Day.
    themeHeaderHtml({
      theme: model.theme,
      brandLine: model.footerBrandLine,
      headline: model.themeHeadline,
      contextLine: model.contextLine,
    }) +
    spacerRow() +
    // ③ Standings snapshot.
    moduleOpen(panel, ink) +
    moduleHeading(s.heading, dim) +
    standingsBody +
    `</td></tr>` +
    spacerRow() +
    // ④ Participation nudge.
    moduleOpen(panel, ink) +
    moduleHeading(model.nudgeHeading, dim) +
    `<div>${esc(model.nudgeLine)}</div>` +
    (model.tonightLine
      ? `<div style="padding-top:8px;"><strong>Tonight:</strong> ${esc(model.tonightLine)}</div>`
      : '') +
    `</td></tr>` +
    spacerRow() +
    // ⑤ Photos + the Most-Loved Photo award (#534).
    moduleOpen(panel, ink) +
    moduleHeading(model.photosHeading, dim) +
    `<div><strong>${esc(model.photosLead)}</strong> ${esc(model.photosRest)}</div>` +
    `<div style="padding-top:8px;">📷 The <strong style="color:${accent};">` +
    `${esc(model.awardLead)}</strong>${esc(model.awardRest)}</div>` +
    `</td></tr>` +
    spacerRow() +
    // ⑥ Primary CTA.
    ctaModule(model.theme, model.ctaUrl, model.ctaLabel) +
    // ⑦ Footer: sender identity, why-you-got-this, visible unsubscribe.
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
        `${r.rank}. ${r.displayName}${star}—${r.bingoCount} bingo${r.bingoCount === 1 ? '' : 's'}, ${r.squaresMarked} squares`,
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
    `${model.footerBrandLine}—${model.footerWhyLine}`,
    `Unsubscribe: ${model.unsubscribeUrl}`,
    `Email preferences: ${model.preferencesUrl}`,
    '',
  );
  return lines.join('\n');
}

// `BODY_STACK` is re-exported for the daily-email suite's font-stack assertions,
// which predate the shell split.
export { BODY_STACK };
