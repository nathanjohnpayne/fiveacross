import { describe, expect, it } from 'vitest';
import { CANONICAL_NAMESPACE_APEX } from './editions';
import { hostnameKey } from './hostnameKey';
import { joinCodeHostname } from './joinCode';
import { RESERVED_SLUGS } from './slug';

// Covers specs/hostnames-lookup.md § Join codes (#1934): a join code is the
// Event Slug, and it resolves through the Slug's hostname in the canonical
// Namespace, never through a record of its own.

describe('joinCodeHostname', () => {
  it('maps a Slug to its hostname in the canonical Namespace', () => {
    expect(CANONICAL_NAMESPACE_APEX).toBe('fiveacross.app');
    expect(joinCodeHostname('bodega-bay')).toEqual({
      ok: true,
      slug: 'bodega-bay',
      hostname: 'bodega-bay.fiveacross.app',
    });
  });

  // A code is typed into a form, often after being read out of a group chat,
  // so the typing affordance applies: surrounding whitespace and case fold.
  it('folds surrounding whitespace and case the way a form does', () => {
    expect(joinCodeHostname('  Bodega-Bay \n')).toEqual({
      ok: true,
      slug: 'bodega-bay',
      hostname: 'bodega-bay.fiveacross.app',
    });
  });

  // The result is used directly as a `publicHostnames/{host}` document key, so
  // it must already be in the one key shape the resolver and the watcher use.
  it('returns a hostname already in document-key shape', () => {
    const result = joinCodeHostname('Bodega-Bay');
    expect(result.ok && result.hostname).toBe(hostnameKey('Bodega-Bay.fiveacross.app'));
  });

  // Everything the edge router refuses as a first label is refused here before
  // any read. A join screen must not become a way to read a document the
  // Namespace guard would never serve.
  it.each([...RESERVED_SLUGS])('refuses the reserved label %s', (label) => {
    expect(joinCodeHostname(label)).toEqual({ ok: false, reason: 'reserved-label' });
  });

  it('refuses the controller-only rehearsal namespace', () => {
    expect(joinCodeHostname(`r2-${'a'.repeat(26)}`)).toEqual({ ok: false, reason: 'reserved-label' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['ab', 'too-short'],
    ['a'.repeat(64), 'too-long'],
    ['bodega bay', 'invalid-characters'],
    ['bodega.bay', 'invalid-characters'],
    ['-bodega', 'edge-hyphen'],
    ['xn--80ak6aa92e', 'reserved-tag'],
  ] as const)('refuses %j as %s', (input, reason) => {
    expect(joinCodeHostname(input)).toEqual({ ok: false, reason });
  });

  // A full address is not a code. Accepting a pasted invite URL is a separate
  // open question in the PRD, so a dotted host is refused rather than parsed.
  it('refuses a pasted hostname rather than guessing at it', () => {
    expect(joinCodeHostname('bodega-bay.fiveacross.app')).toEqual({ ok: false, reason: 'invalid-characters' });
  });
});
