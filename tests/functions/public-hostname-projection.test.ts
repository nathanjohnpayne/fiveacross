import { describe, it, expect } from 'vitest';
import { hasOnlyPublicHostnameFields, PUBLIC_HOSTNAME_FIELDS, projectPublicHostname } from '../../functions/src/publicHostnameFields';

describe('public hostname projection serialization boundary', () => {
  it('retains the seven routing and four nested preview fields without altering canonical recovery data', () => {
    const preview = { eventName: 'Quoted “Event”', dateRange: 'Aug 7–9', days: [{ date: '2026-08-07', title: 'Birds', emoji: '🐦' }], hostedBy: 'Kim', internalNote: 'secret' };
    const source = { eventId: 'event', canonicalHost: 'a.fiveacross.app', edition: 'vacay', status: 'archived', adultContent: true, slug: 'a', isCanonical: false, preview, root: 'doorway', pathNamespace: null, apexPath: true, contactEmail: 'secret' };
    const result = projectPublicHostname(source);
    expect(Object.keys(result)).toEqual([...PUBLIC_HOSTNAME_FIELDS.routing, 'preview']);
    expect(Object.keys(result.preview!)).toEqual(PUBLIC_HOSTNAME_FIELDS.preview);
    expect(result).toEqual({ eventId: 'event', canonicalHost: 'a.fiveacross.app', edition: 'vacay', status: 'archived', adultContent: true, slug: 'a', isCanonical: false, preview: { eventName: preview.eventName, dateRange: preview.dateRange, days: preview.days, hostedBy: preview.hostedBy } });
    expect(source.pathNamespace).toBe(null);
    expect(source.preview.internalNote).toBe('secret');
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it.each([null, [], 'not a document'])('refuses a non-document canonical source (%j)', value => {
    expect(() => projectPublicHostname(value)).toThrow('canonical document');
  });
  it('omits undefined and unsupported preview containers without inventing values', () => {
    expect(projectPublicHostname({ eventId: 'event', edition: undefined, preview: [] })).toEqual({ eventId: 'event' });
    expect(projectPublicHostname({ preview: { eventName: undefined, hostedBy: 'Kim' } })).toEqual({ preview: { hostedBy: 'Kim' } });
  });
  it('denies extra public keys rather than redacting a supplied read', () => {
    expect(hasOnlyPublicHostnameFields({ eventId: 'event', contactEmail: 'secret' })).toBe(false);
    expect(hasOnlyPublicHostnameFields({ preview: { eventName: 'Event', roster: [] } })).toBe(false);
    expect(hasOnlyPublicHostnameFields({ eventId: 'event', preview: { days: [] } })).toBe(true);
  });
});
