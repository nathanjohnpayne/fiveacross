import { supportedDayIndex } from './data/eventLimits';

/**
 * The one client-side answer to "is this `utm_*` set one of OUR email links
 * for THIS Event?" (#632, specs/posthog-analytics.md § Campaign attribution).
 * Both analytics sinks ask it before a campaign value leaves the browser:
 * `campaignQuery()` (`src/analytics.ts`) for GA4's initial `page_location`,
 * and `sanitizeUrls()` (`src/posthog.ts`) for the campaign properties
 * posthog-js parses off the landing URL on its own.
 *
 * The taxonomy is the one `functions/src/emailCampaign.ts` produces, matched
 * as exact strings rather than a shape: `utm_medium=email`, plus either
 * `utm_source=daily-email` with `utm_campaign=<eventId>-day-<index>` (a
 * supported Day index, 0–9, in canonical decimal) or `utm_source=podium-email`
 * with `utm_campaign=<eventId>-podium`, where `<eventId>` is the resolved
 * Event's id. Anything else (identifier-shaped free text, an email address,
 * another Event, a mismatched source/suffix pair, an out-of-range Day) is not
 * ours, so the caller forwards nothing. `utm_content` / `utm_term` are never
 * part of a match: the app does not set them.
 *
 * `eventId` is the registered `event_id` analytics dimension each caller
 * already holds (`ga4Dims` in `src/analytics.ts`, `registeredDims` in
 * `src/posthog.ts`). Before Event resolution registers it there is nothing to
 * match against, so a `null` or empty id matches nothing and the campaign is
 * dropped rather than trusted on shape alone.
 */
export type EmailCampaignTags = { utm_source: string; utm_medium: string; utm_campaign: string };

export function matchEmailCampaign(
  tags: { utm_source?: unknown; utm_medium?: unknown; utm_campaign?: unknown },
  eventId: string | null,
): EmailCampaignTags | null {
  if (!eventId) return null;
  const { utm_source: source, utm_medium: medium, utm_campaign: campaign } = tags;
  if (medium !== 'email' || typeof campaign !== 'string') return null;
  if (source === 'podium-email') {
    return campaign === `${eventId}-podium` ? { utm_source: source, utm_medium: medium, utm_campaign: campaign } : null;
  }
  if (source === 'daily-email') {
    const prefix = `${eventId}-day-`;
    if (!campaign.startsWith(prefix)) return null;
    const suffix = campaign.slice(prefix.length);
    if (!/^(?:0|[1-9]\d*)$/.test(suffix) || !supportedDayIndex(Number(suffix))) return null;
    return { utm_source: source, utm_medium: medium, utm_campaign: campaign };
  }
  return null;
}
