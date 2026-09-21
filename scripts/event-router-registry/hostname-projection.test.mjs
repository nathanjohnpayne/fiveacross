import { describe, expect, it } from 'vitest';
import {
  HostnameProjectionRefusal,
  LEDGER_MAX_BYTES,
  buildLedgerDocument,
  normalizeTimestamp,
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

  // A label the wildcard pattern accepts but no organizer could ever claim.
  // The publisher's `isRegistryHost` and the worker's sync parser both reach
  // `validateSlug` and refuse these, so a projection derived for one of them
  // is a desired state the edge can never accept.
  it.each([
    ['a reserved label', 'admin.fiveacross.app'],
    ['a label shorter than three characters', 'ab.fiveacross.app'],
    ['a double-hyphen label', 'ab--cd.fiveacross.app'],
    ['a trailing-hyphen label', 'bodega-.vacaybingo.com'],
    ['an r2- label that is not one of the closed classes', 'r2-short.fiveacross.app'],
  ])('refuses %s, which no downstream consumer would admit', (_why, host) => {
    expect(code(() => validateHostShape(host)), host).toBe('invalid-host');
  });

  it.each([SYNTHETIC_HOST, SYNTHETIC_ROOT_HOST, 'bodega-bay.fiveacross.app', 'gaycruisebingo.com'])(
    'still admits %s',
    (host) => {
      expect(code(() => validateHostShape(host)), host).toBe(null);
    },
  );

  // The tombstone arm is the one that derives from an ABSENT source, so it has
  // no slug of its own to check and reached only the syntactic gate before the
  // host rule moved into it. `advance-ledger` could therefore write a
  // tombstone for a host the sync endpoint refuses, and nothing on this side
  // would call the pair malformed.
  it.each(['admin.fiveacross.app', 'ab.fiveacross.app', 'ab--cd.fiveacross.app'])(
    'refuses to derive a tombstone for %s rather than projecting one that can never converge',
    (host) => {
      expect(code(() => deriveCanonicalProjection(host, null))).toBe('invalid-host');
      expect(code(() => deriveCanonicalProjection(host, undefined))).toBe('invalid-host');
    },
  );

  it('refuses a stored tombstone ledger keyed to a host no consumer admits', () => {
    const ledger = {
      schemaVersion: 1,
      revision: '4',
      host: 'admin.fiveacross.app',
      desired: { kind: 'tombstone' },
      updatedAt: { toDate: () => new Date('2026-09-20T00:00:00.000Z') },
    };
    expect(code(() => validateLedgerDocument('admin.fiveacross.app', ledger))).toBe('invalid-host');
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
    // A STORED row carries a Firestore `Timestamp`, never text.
    updatedAt: { toDate: () => new Date('2026-09-20T00:00:00.000Z') },
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

  // A Firestore `Timestamp` as the SDK hands one back: `toDate()` is the only
  // member the projection contracts for.
  const storedTimestamp = (iso) => ({ toDate: () => new Date(iso) });

  // Two readers, one instant. A RECEIPT is normalized JSON and carries text;
  // a STORED row carries a `Timestamp`. Both must answer the same canonical
  // form, or one ledger has two digests and a cross-layer comparison reports
  // a mismatch that is an artifact of the encoding.
  it('normalizes every spelling of one instant to one canonical text', () => {
    const texts = new Set(
      [
        '2026-09-20T12:00:00Z',
        '2026-09-20T12:00:00+00:00',
        '2026-09-20T12:00:00.000Z',
        '2026-09-20T14:00:00+02:00',
        '2026-09-20T12:00:00.000123Z',
        storedTimestamp('2026-09-20T12:00:00.000Z'),
      ].map((value) => normalizeTimestamp(value)),
    );
    expect(texts).toEqual(new Set(['2026-09-20T12:00:00.000Z']));
  });

  it('hashes two stored Timestamps for one instant to one documentDigest', () => {
    expect(validateLedgerDocument(EVENT_HOST, ledger({ updatedAt: storedTimestamp('2026-09-20T12:00:00.000Z') })).documentDigest).toBe(
      validateLedgerDocument(EVENT_HOST, ledger({ updatedAt: storedTimestamp('2026-09-20T14:00:00+02:00') })).documentDigest,
    );
  });

  // The stored path and the receipt path are deliberately different: the
  // deployed Eventarc parser accepts `updatedAt` only as a `timestampValue`,
  // so a partial Admin write storing text is a document whose trigger can
  // never publish it, and validating it as well formed let it serve as a
  // converged mutation pre-state and be classified converged by the
  // reconciler.
  it('refuses a stored ledger carrying text, while the receipt path still normalizes the same text', () => {
    expect(code(() => validateLedgerDocument(EVENT_HOST, ledger({ updatedAt: '2026-09-20T12:00:00.000Z' })))).toBe(
      'malformed-ledger',
    );
    expect(normalizeTimestamp('2026-09-20T12:00:00.000Z')).toBe('2026-09-20T12:00:00.000Z');
    expect(
      buildLedgerDocument(EVENT_HOST, '4', deriveCanonicalProjection(EVENT_HOST, eventDocument()), '2026-09-20T12:00:00.000Z'),
    ).toMatchObject({ updatedAt: '2026-09-20T12:00:00.000Z' });
  });

  // Both encodings must accept exactly the same instants, or `authoritativeNow`
  // can store a ledger the publisher refuses: the string branch rejects a year
  // below 0100, so the Timestamp branch has to as well.
  it.each([
    ['a year before 0100', '0099-12-31T23:59:59.000Z'],
    ['the year zero', '0000-01-01T00:00:00.000Z'],
  ])('refuses a stored Timestamp for %s, exactly as the string branch does', (_why, iso) => {
    const value = new Date(0);
    value.setUTCFullYear(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
    value.setUTCHours(23, 59, 59, 0);
    expect(value.toISOString().slice(0, 4)).toBe(iso.slice(0, 4));
    expect(code(() => validateLedgerDocument(EVENT_HOST, ledger({ updatedAt: { toDate: () => value } })))).toBe(
      'malformed-ledger',
    );
  });

  it('still separates two instants a millisecond apart', () => {
    expect(
      validateLedgerDocument(EVENT_HOST, ledger({ updatedAt: storedTimestamp('2026-09-20T12:00:00.000Z') })).documentDigest,
    ).not.toBe(
      validateLedgerDocument(EVENT_HOST, ledger({ updatedAt: storedTimestamp('2026-09-20T12:00:00.001Z') })).documentDigest,
    );
  });

  it.each([
    ['an offsetless string a machine would read as local time', '2026-09-20T12:00:00'],
    ['a text Date.parse accepts but RFC 3339 does not', 'Sep 20 2026 12:00:00 GMT+0000'],
    ['a date with no time of day', '2026-09-20'],
    ['an RFC 3339 shape that names no instant', '2026-13-40T25:00:00Z'],
    ['an empty string', ''],
    // The `Date.UTC` year bound, pinned as a decision rather than left as an
    // accident: this field is a publish instant, so a first-century year is
    // corruption and refusing it fails closed. The publisher and the worker
    // draw the same bound; moving one of the three means moving all three.
    ['a year before 0100, which this layer will not treat as a publish instant', '0099-12-31T23:59:59Z'],
    ['the year zero', '0000-01-01T00:00:00Z'],
    // Written components inside the range, canonical result outside it: the
    // offset is applied AFTER they are judged, so the emitted text has to be
    // validated too or the digest takes a form this layer refuses.
    ['an offset that carries the first supported year below the bound', '0100-01-01T00:00:00+01:00'],
    ['an offset that carries the last supported year into the expanded form', '9999-12-31T23:59:59-01:00'],
  ])('refuses %s, on the receipt path and in a stored row alike', (_why, updatedAt) => {
    expect(normalizeTimestamp(updatedAt)).toBe(null);
    expect(code(() => validateLedgerDocument(EVENT_HOST, ledger({ updatedAt })))).toBe('malformed-ledger');
  });

  // `Date.parse` ROLLS these forward rather than refusing them, so before the
  // calendar check a digest was taken over an instant the ledger never named:
  // `2026-02-30T12:00:00Z` parses to March 2.
  it.each([
    ['a day past the end of February', '2026-02-30T12:00:00Z'],
    ['a thirty-first of April', '2026-04-31T12:00:00Z'],
    ['a leap day in a year that has none', '2025-02-29T12:00:00Z'],
    ['a zeroth day', '2026-09-00T12:00:00Z'],
    ['a day past the end of a month under an offset', '2026-02-30T12:00:00+02:00'],
  ])('refuses %s rather than rolling it forward', (_why, updatedAt) => {
    expect(normalizeTimestamp(updatedAt)).toBe(null);
    expect(code(() => validateLedgerDocument(EVENT_HOST, ledger({ updatedAt })))).toBe('malformed-ledger');
  });

  it('accepts the leap day of a year that has one', () => {
    expect(normalizeTimestamp('2028-02-29T12:00:00Z')).toBe('2028-02-29T12:00:00.000Z');
    expect(
      validateLedgerDocument(EVENT_HOST, ledger({ updatedAt: storedTimestamp('2028-02-29T12:00:00Z') })).documentDigest,
    ).toBe(
      validateLedgerDocument(EVENT_HOST, ledger({ updatedAt: storedTimestamp('2028-02-29T12:00:00.000Z') })).documentDigest,
    );
  });

  it('refuses to build a ledger around a timestamp that does not round-trip', () => {
    expect(
      code(() =>
        buildLedgerDocument(EVENT_HOST, '4', deriveCanonicalProjection(EVENT_HOST, eventDocument()), '2026-09-20T12:00:00'),
      ),
    ).toBe('malformed-timestamp');
  });
});

describe('the 2 KiB sync envelope', () => {
  const desiredFor = (eventId) => ({
    kind: 'route',
    eventId,
    status: 'active',
    slug: 'bodega-bay',
    edition: 'fiveacross',
    pathNamespace: null,
  });

  // Nothing else bounds a projected value: `eventId` is only required to be
  // non-empty and a revision is any run of digits. Past 2 KiB the publisher
  // refuses the body and the edge never sees it, so a ledger written at that
  // size is a revision that can never converge and every trigger retry fails
  // on the same bytes.
  it.each([
    ['an oversized eventId', () => buildLedgerDocument(EVENT_HOST, '4', desiredFor('e'.repeat(2048)), '2026-09-20T00:00:00.000Z')],
    ['an oversized revision', () => buildLedgerDocument(EVENT_HOST, '9'.repeat(2048), desiredFor('e'), '2026-09-20T00:00:00.000Z')],
  ])('refuses a ledger document the publisher could never send, with %s', (_why, build) => {
    expect(code(build)).toBe('projection-exceeds-sync-limit');
  });

  it('measures the wire shape and admits a document just inside the limit', () => {
    const document = buildLedgerDocument(EVENT_HOST, '4', desiredFor('bodega-bay-2026'), '2026-09-20T00:00:00.000Z');
    // Weighed with `updatedAt` as the RFC 3339 text the publisher sends,
    // which is the shape the edge measures.
    const envelope = JSON.stringify({ ...document, updatedAt: '2026-09-20T00:00:00.000Z' });
    expect(new TextEncoder().encode(envelope).byteLength).toBeLessThanOrEqual(LEDGER_MAX_BYTES);
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
