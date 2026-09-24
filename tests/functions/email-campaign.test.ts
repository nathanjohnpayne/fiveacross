import { describe, it, expect } from 'vitest';
import {
  EMAIL_UTM_MEDIUM,
  campaignLink,
  dailyEmailCampaign,
  podiumEmailCampaign,
} from '../../functions/src/emailCampaign';
import { safeUrl } from '../../functions/src/emailShell';
import { matchEmailCampaign } from '../../src/emailCampaignMatch';

// Campaign attribution on outbound email deep links (#632, specs/posthog-analytics.md
// § Campaign attribution). Every app deep link an email carries is tagged, so an
// email-driven session is attributable in PostHog (its parsed utm_* /
// $initial_utm_* properties) and GA4 (the initial page_view's page_location)
// instead of landing as direct traffic.

describe('the email UTM taxonomy (#632)', () => {
  it('tags the daily email with its Event and 0-based Day index (the day_index dimension)', () => {
    expect(dailyEmailCampaign('med-2026', 3)).toEqual({
      source: 'daily-email',
      campaign: 'med-2026-day-3',
    });
  });

  it('tags the podium email with its Event alone — it is sent once per Event', () => {
    expect(podiumEmailCampaign('bodega-bay-2026')).toEqual({
      source: 'podium-email',
      campaign: 'bodega-bay-2026-podium',
    });
  });

  it('uses the one medium every email shares', () => {
    expect(EMAIL_UTM_MEDIUM).toBe('email');
  });
});

describe('campaignLink (#632)', () => {
  it('appends utm_source, utm_medium and utm_campaign to the deep link in that order', () => {
    expect(campaignLink('https://bodega-bay.fiveacross.app', '/feed', dailyEmailCampaign('bodega-bay-2026', 0))).toBe(
      'https://bodega-bay.fiveacross.app/feed?utm_source=daily-email&utm_medium=email&utm_campaign=bodega-bay-2026-day-0',
    );
  });

  it('tolerates a trailing slash on the origin, as the untagged link did', () => {
    expect(campaignLink('https://gaycruisebingo.com//', '/feed', podiumEmailCampaign('med-2026'))).toBe(
      'https://gaycruisebingo.com/feed?utm_source=podium-email&utm_medium=email&utm_campaign=med-2026-podium',
    );
  });

  it('percent-encodes an Event id rather than letting it break the query', () => {
    const url = new URL(campaignLink('https://x.test', '/feed', dailyEmailCampaign('a&b=c d', 1)));
    expect(url.searchParams.get('utm_campaign')).toBe('a&b=c d-day-1');
    expect([...url.searchParams.keys()]).toEqual(['utm_source', 'utm_medium', 'utm_campaign']);
  });

  it('falls back to the untagged link when the origin does not parse, so the send still proceeds', () => {
    // The old `${origin}/feed` concatenation never threw; a malformed origin
    // rendered a dead `#` link through safeUrl rather than aborting the fan-out.
    const link = campaignLink('not a url', '/feed', dailyEmailCampaign('med-2026', 3));
    expect(link).toBe('not a url/feed');
    expect(safeUrl(link)).toBe('#');
  });

  it('survives safeUrl as an https link, with the ampersands HTML-escaped for the href', () => {
    const link = campaignLink('https://gaycruisebingo.com', '/feed', dailyEmailCampaign('med-2026', 3));
    expect(safeUrl(link)).toBe(
      'https://gaycruisebingo.com/feed?utm_source=daily-email&amp;utm_medium=email&amp;utm_campaign=med-2026-day-3',
    );
  });
});

// Drift guard: the client forwards a tag set to GA4 and PostHog only when
// `matchEmailCampaign` (src/emailCampaignMatch.ts) recognizes it as this
// Event's own email campaign. If the taxonomy above changed without that
// matcher, every email click would silently lose its attribution.
describe('the client matcher accepts exactly what the senders produce (#632)', () => {
  const tagsOf = (link: string) => Object.fromEntries(new URL(link).searchParams);

  it('recognizes every daily Day index and the podium link for the same Event', () => {
    for (let day = 0; day < 10; day += 1) {
      const link = campaignLink('https://bodega-bay.fiveacross.app', '/feed', dailyEmailCampaign('bodega-bay-2026', day));
      expect(matchEmailCampaign(tagsOf(link), 'bodega-bay-2026')).not.toBeNull();
    }
    const podium = campaignLink('https://bodega-bay.fiveacross.app', '/feed', podiumEmailCampaign('bodega-bay-2026'));
    expect(matchEmailCampaign(tagsOf(podium), 'bodega-bay-2026')).not.toBeNull();
  });

  it('rejects a real link when the client resolved a different Event', () => {
    const link = campaignLink('https://gaycruisebingo.com', '/feed', podiumEmailCampaign('med-2026'));
    expect(matchEmailCampaign(tagsOf(link), 'bodega-bay-2026')).toBeNull();
  });
});
