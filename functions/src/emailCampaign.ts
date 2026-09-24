/**
 * Campaign attribution for the app deep links an email carries (#632,
 * specs/posthog-analytics.md § Campaign attribution).
 *
 * Without these an email-driven session lands in GA4 and PostHog as direct
 * traffic. PostHog reads `utm_*` off the landing URL into `$utm_*` itself; the
 * client's initial GA4 `page_view` carries the same allowlisted keys on its
 * otherwise path-only `page_location` (`src/analytics.ts`). One tag feeds both
 * sinks. The client forwards a tag set to GA4 only when it is exactly what
 * this module produces for the resolved Event (`campaignQuery` in
 * `src/analytics.ts`), so a change to the taxonomy below must change that
 * matcher in the same edit.
 *
 * Only APP deep links are tagged. The unsubscribe and preference links hit the
 * `emailUnsubscribe` Cloud Function, never the app, so a tag there would be
 * noise on a capability URL that analytics never loads.
 *
 * Taxonomy:
 * - `utm_medium` is always `email`.
 * - `utm_source` names the email: `daily-email` or `podium-email`.
 * - `utm_campaign` names the Event and, for the daily email, the Day:
 *   `<eventId>-day-<index>` where `<index>` is the 0-based Day index (the same
 *   value as the `day_index` analytics dimension and the daily idempotency
 *   key), or `<eventId>-podium`.
 */

export const EMAIL_UTM_MEDIUM = 'email';

export type EmailCampaign = {
  /** `utm_source`: which email the click came from. */
  source: 'daily-email' | 'podium-email';
  /** `utm_campaign`: which Event (and Day) the email was about. */
  campaign: string;
};

export function dailyEmailCampaign(eventId: string, dayIndex: number): EmailCampaign {
  return { source: 'daily-email', campaign: `${eventId}-day-${dayIndex}` };
}

export function podiumEmailCampaign(eventId: string): EmailCampaign {
  return { source: 'podium-email', campaign: `${eventId}-podium` };
}

/**
 * `${origin}${path}` with the campaign's UTM set appended. Keeps the untagged
 * link's own trailing-slash tolerance. An origin that does not parse returns
 * the untagged concatenation, exactly what the senders built before #632: this
 * runs before the per-recipient loop, so throwing here would abort the whole
 * fan-out, whereas the untagged value still renders as a dead `#` link through
 * `safeUrl`, as it always did.
 */
export function campaignLink(origin: string, path: string, campaign: EmailCampaign): string {
  const untagged = `${origin.replace(/\/+$/, '')}${path}`;
  let url: URL;
  try {
    url = new URL(untagged);
  } catch {
    return untagged;
  }
  url.searchParams.set('utm_source', campaign.source);
  url.searchParams.set('utm_medium', EMAIL_UTM_MEDIUM);
  url.searchParams.set('utm_campaign', campaign.campaign);
  return url.toString();
}
