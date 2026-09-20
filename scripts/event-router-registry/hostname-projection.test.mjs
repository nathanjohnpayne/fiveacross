import { describe, expect, it } from 'vitest';
import {
  HostnameProjectionRefusal,
  buildLedgerDocument,
  deriveCanonicalProjection,
  isReservedClassHost,
  nextRevision,
  projectionDigest,
  validateHostShape,
  validateLedgerDocument,
} from './hostname-projection.mjs';

const EVENT_HOST = 'bodega-bay.fiveacross.app';
const MIRROR_HOST = 'vacaybingo.vercel.app';
const SYNTHETIC_HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const SYNTHETIC_ROOT_HOST = 'r2-root-abcdefghijklmnopqrst.fiveacross.app';

const eventDocument = (overrides = {}) => ({
  eventId: 'bodega-bay-2026',
  canonicalHost: EVENT_HOST,
  edition: 'fiveacross',
  status: 'active',
  slug: 'bodega-bay',
  isCanonical: true,
  adultContent: false,
  ...overrides,
});

const code = (fn) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof HostnameProjectionRefusal) return error.code;
    throw error;
  }
  return null;
};

describe('canonical hostname projection', () => {
  it('copies exactly the projected fields and ignores every other one', () => {
    expect(deriveCanonicalProjection(EVENT_HOST, eventDocument({ preview: { eventName: 'Bodega' }, apexPath: true }))).toEqual({
      kind: 'route',
      eventId: 'bodega-bay-2026',
      status: 'active',
      slug: 'bodega-bay',
      edition: 'fiveacross',
      pathNamespace: null,
    });
  });

  it.each([
    ['adultContent', { adultContent: true }],
    ['canonicalHost', { canonicalHost: 'bodega-bay.vacaybingo.com' }],
    ['isCanonical', { isCanonical: false }],
    ['apexPath', { apexPath: true }],
    ['preview', { preview: { eventName: 'Bodega Bay' } }],
  ])('leaves the projection unchanged when only %s moves', (_field, overrides) => {
    expect(deriveCanonicalProjection(EVENT_HOST, eventDocument(overrides))).toEqual(
      deriveCanonicalProjection(EVENT_HOST, eventDocument()),
    );
  });

  it('derives a tombstone from an absent hostname document and nothing else', () => {
    expect(deriveCanonicalProjection(EVENT_HOST, null)).toEqual({ kind: 'tombstone' });
    expect(deriveCanonicalProjection(EVENT_HOST, undefined)).toEqual({ kind: 'tombstone' });
  });

  it('derives a root marker on a root host and refuses one anywhere else', () => {
    expect(
      deriveCanonicalProjection(MIRROR_HOST, { root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' }),
    ).toEqual({ kind: 'root', root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' });
    expect(code(() => deriveCanonicalProjection(EVENT_HOST, { root: 'doorway', edition: 'fiveacross', pathNamespace: null }))).toBe(
      'malformed-hostname-source',
    );
  });

  it('refuses a root marker whose Edition or capability disagrees with its host', () => {
    expect(
      code(() => deriveCanonicalProjection(MIRROR_HOST, { root: 'doorway', edition: 'gcb', pathNamespace: 'vacaybingo.com' })),
    ).toBe('malformed-hostname-source');
    expect(
      code(() => deriveCanonicalProjection(MIRROR_HOST, { root: 'doorway', edition: 'vacay', pathNamespace: null })),
    ).toBe('malformed-hostname-source');
  });

  it.each([
    ['both eventId and root', { root: 'doorway' }],
    ['neither eventId nor root', { eventId: undefined }],
    ['an unknown Edition', { edition: 'westminster' }],
    ['an unknown status', { status: 'paused' }],
    ['an unknown path namespace', { pathNamespace: 'example.com' }],
    ['a slug that is not the host label', { slug: 'sonoma' }],
    ['a reserved slug', { slug: 'admin' }],
  ])('refuses a hostname document carrying %s', (_why, overrides) => {
    const document = eventDocument(overrides);
    if (overrides.eventId === undefined) delete document.eventId;
    expect(code(() => deriveCanonicalProjection(EVENT_HOST, document))).toBe('malformed-hostname-source');
  });

  it('keeps the Namespace apex exception: a root host may carry a slug that is not its label', () => {
    expect(
      deriveCanonicalProjection('gaycruisebingo.com', {
        eventId: 'med-2026',
        edition: 'gcb',
        status: 'active',
        slug: 'med-2026-sailing',
        pathNamespace: null,
      }),
    ).toMatchObject({ kind: 'route', slug: 'med-2026-sailing' });
  });

  it('refuses a host that is neither a known root nor a wildcard Namespace subdomain', () => {
    for (const host of ['example.com', 'BODEGA-BAY.fiveacross.app', 'bodega-bay.fiveacross.app.', 'a/b']) {
      expect(code(() => validateHostShape(host)), host).toBe('invalid-host');
    }
  });
});

describe('the one canonicalizer', () => {
  it('produces a stable digest per arm and separates absent from present capability', () => {
    const route = { kind: 'route', eventId: 'e', status: 'active', slug: 'bodega-bay', edition: 'fiveacross', pathNamespace: null };
    const capable = { ...route, pathNamespace: 'fiveacross.app' };
    expect(projectionDigest('1', EVENT_HOST, route)).toMatch(/^[a-f0-9]{64}$/);
    expect(projectionDigest('1', EVENT_HOST, route)).not.toBe(projectionDigest('1', EVENT_HOST, capable));
    expect(projectionDigest('1', EVENT_HOST, route)).not.toBe(projectionDigest('2', EVENT_HOST, route));
    expect(projectionDigest('1', EVENT_HOST, { kind: 'tombstone' })).not.toBe(
      projectionDigest('1', MIRROR_HOST, { kind: 'tombstone' }),
    );
  });

  it('increments a revision exactly and refuses a non-canonical one', () => {
    expect(nextRevision('1')).toBe('2');
    expect(nextRevision('9007199254740993')).toBe('9007199254740994');
    for (const bad of ['0', '01', '', '-1', 'x']) expect(code(() => nextRevision(bad)), bad).toBe('malformed-revision');
  });
});

describe('stored ledger validation', () => {
  const ledger = (overrides = {}) => ({
    ...buildLedgerDocument(
      EVENT_HOST,
      '4',
      deriveCanonicalProjection(EVENT_HOST, eventDocument()),
      '2026-09-20T00:00:00.000Z',
    ),
    ...overrides,
  });

  it('accepts a well-formed ledger and recomputes its digest', () => {
    const stored = validateLedgerDocument(EVENT_HOST, ledger());
    expect(stored.revision).toBe('4');
    expect(stored.digest).toBe(projectionDigest('4', EVENT_HOST, stored.desired));
  });

  it.each([
    ['an extra field', { extra: true }],
    ['a wrong schema version', { schemaVersion: 2 }],
    ['a non-canonical revision', { revision: '04' }],
    ['a host that is not its own id', { host: MIRROR_HOST }],
    ['a desired shape no hostname document could produce', { desired: { kind: 'route', eventId: 'e', status: 'active', slug: 'admin', edition: 'fiveacross', pathNamespace: null } }],
  ])('refuses a ledger with %s', (_why, overrides) => {
    expect(code(() => validateLedgerDocument(EVENT_HOST, ledger(overrides)))).toBe('malformed-ledger');
  });

  it('reports a missing ledger distinctly from a malformed one', () => {
    expect(code(() => validateLedgerDocument(EVENT_HOST, null))).toBe('missing-ledger');
  });
});

describe('the globally reserved rehearsal classes', () => {
  it.each([SYNTHETIC_HOST, SYNTHETIC_ROOT_HOST, 'r2-short.fiveacross.app', 'r2-root-.vacaybingo.com'])(
    'recognises %s as reserved whatever its suffix',
    (host) => {
      expect(isReservedClassHost(host)).toBe(true);
    },
  );

  it.each([EVENT_HOST, MIRROR_HOST, 'r2.fiveacross.app', 'r2bodega.fiveacross.app', 'fiveacross.app'])(
    'leaves %s claimable',
    (host) => {
      expect(isReservedClassHost(host)).toBe(false);
    },
  );
});
