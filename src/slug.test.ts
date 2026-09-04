import { describe, expect, it } from 'vitest';
import {
  isReservedLabel,
  normalizeSlug,
  RESERVED_LABELS,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  validateSlug,
} from './slug';

describe('reserved infrastructure labels', () => {
  // Pinned verbatim, and exhaustively. This list is a cross-project contract
  // (#529, #545, and the wizard's address step #790); a silent addition or
  // removal here changes what an organizer may claim AND what the edge router
  // will serve, so it should never move without a test moving with it.
  it('is exactly the eight infrastructure labels, sorted', () => {
    expect([...RESERVED_LABELS]).toEqual([
      'admin',
      'api',
      'auth',
      'd',
      'play',
      'send',
      'status',
      'www',
    ]);
  });

  it('includes the PostHog ingest proxy label the PRD omitted', () => {
    expect(isReservedLabel('d')).toBe(true);
  });

  it('includes the Resend return-path label, which carries MX and outranks the wildcard', () => {
    // `send` is the one reserved label an organizer could plausibly have typed:
    // three characters, LDH-clean, and an ordinary English word, so nothing
    // else in `validateSlug` would have refused it. It carries the Resend
    // return-path MX and SPF for `fiveacross.app` (#1102), which makes it
    // doubly unclaimable — an Event dealt there would name a host whose DNS is
    // an SES bounce address, and because a wildcard does not apply to a name
    // that already exists with ANY record type (RFC 4592), the explicit records
    // occlude `*.fiveacross.app` for that label entirely once #529 attaches it.
    expect(isReservedLabel('send')).toBe(true);
  });

  it.each([...RESERVED_LABELS])('refuses %s as a Slug', (label) => {
    expect(validateSlug(label)).toEqual({ ok: false, reason: 'reserved-label' });
  });

  it('rejects a reserved label AS reserved, not incidentally as too short', () => {
    // `d` is one character, so a length-first ordering would refuse it with the
    // wrong reason — and would start ADMITTING it the day SLUG_MIN_LENGTH
    // dropped to 1. The guarantee has to be the reserved list, not arithmetic.
    const check = validateSlug('d');
    expect(check).toEqual({ ok: false, reason: 'reserved-label' });
    expect(check).not.toEqual({ ok: false, reason: 'too-short' });
  });

  it('does not reserve labels that merely contain a reserved one', () => {
    expect(validateSlug('admiral')).toEqual({ ok: true, slug: 'admiral' });
    expect(validateSlug('api-summit')).toEqual({ ok: true, slug: 'api-summit' });
  });

  it.each(['r2-abcdefghijklmnopqrstuvwxyz', 'r2-root-abcdefghijklmnopqrst'])(
    'reserves the controller-only rehearsal class %s from ordinary claims',
    (label) => {
      expect(validateSlug(label)).toEqual({ ok: false, reason: 'reserved-label' });
    },
  );
});

describe('validateSlug', () => {
  it.each(['bodega-bay', 'med-2026', 'x7z', 'a-b-c', '2026', 'a'.repeat(SLUG_MAX_LENGTH)])(
    'accepts %s',
    (candidate) => {
      expect(validateSlug(candidate)).toEqual({ ok: true, slug: candidate });
    },
  );

  it.each([
    ['', 'empty'],
    ['ab', 'too-short'],
    ['a'.repeat(SLUG_MAX_LENGTH + 1), 'too-long'],
    ['Bodega-Bay', 'invalid-characters'],
    ['bodega bay', 'invalid-characters'],
    ['bodega_bay', 'invalid-characters'],
    ['bodega.bay', 'invalid-characters'],
    ['bodega/bay', 'invalid-characters'],
    ['bodega​bay', 'invalid-characters'],
    ['bodegabaÿ', 'invalid-characters'],
    ['-bodega', 'edge-hyphen'],
    ['bodega-', 'edge-hyphen'],
    ['xn--80ak6aa92e', 'reserved-tag'],
    ['ab--cd', 'reserved-tag'],
  ] as const)('refuses %s as %s', (candidate, reason) => {
    expect(validateSlug(candidate)).toEqual({ ok: false, reason });
  });

  it('accepts a hyphen pair anywhere other than the reserved third-fourth position', () => {
    expect(validateSlug('bodega--bay')).toEqual({ ok: true, slug: 'bodega--bay' });
  });

  it('is strict about case rather than normalising, so a wire label is judged as written', () => {
    // The router hands this function bytes that arrived over the network. If
    // the validator normalised, the router's guard would become lenient about a
    // distinction it is supposed to have already resolved.
    expect(validateSlug('BODEGA-BAY').ok).toBe(false);
    expect(validateSlug(normalizeSlug('BODEGA-BAY'))).toEqual({ ok: true, slug: 'bodega-bay' });
  });

  it('rejects a candidate one character below the floor and accepts it at the floor', () => {
    expect(validateSlug('a'.repeat(SLUG_MIN_LENGTH - 1))).toEqual({ ok: false, reason: 'too-short' });
    expect(validateSlug('a'.repeat(SLUG_MIN_LENGTH)).ok).toBe(true);
  });
});

describe('normalizeSlug', () => {
  it('trims and lowercases and does nothing else', () => {
    expect(normalizeSlug('  Bodega-Bay \n')).toBe('bodega-bay');
    // Notably it does NOT repair an invalid candidate — normalisation is a
    // typing affordance, not a sanitiser.
    expect(normalizeSlug('Bodega Bay')).toBe('bodega bay');
    expect(validateSlug(normalizeSlug('Bodega Bay')).ok).toBe(false);
  });
});
