import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyHost, NAMESPACES } from '../worker/src/host';
import { TABS } from './components/tabs';
import {
  isReservedLabel,
  isReservedPathSegment,
  parseAddress,
  RESERVED_LABELS,
  RESERVED_PATH_SEGMENTS,
  RESERVED_SLUGS,
  validateSlug,
} from './slug';

// `specs/path-addressing-and-root.md` § Reserved paths and § D3 step 1 (#1387).
// The reserved list is ONE module holding the union of two floors, and the
// address parser reads it. Everything below is pure: no Firestore, no router,
// no network.

const readRepoFile = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf-8');

describe('the reserved-path union', () => {
  it('pins the path-segment floor, including the wizard mount point (#1223)', () => {
    // `setup` is the Event-setup wizard's own top-level route (`/setup/*` in
    // `src/App.tsx`); the owner decided on 2026-10-02 (#1223) to keep it there
    // and reserve the word rather than move the wizard under `/more`.
    expect([...RESERVED_PATH_SEGMENTS]).toEqual([
      '__',
      'admin',
      'assets',
      'feed',
      'items',
      'leaderboard',
      'more',
      'setup',
      'unsubscribe',
    ]);
  });

  it('is exactly the sorted, de-duplicated union of both floors', () => {
    const union = [...new Set([...RESERVED_LABELS, ...RESERVED_PATH_SEGMENTS])].sort();
    expect([...RESERVED_SLUGS]).toEqual(union);
    // `admin` is in both floors and appears once.
    expect(RESERVED_SLUGS.filter((word) => word === 'admin')).toHaveLength(1);
  });

  it('lets neither floor shrink the other', () => {
    for (const word of [...RESERVED_LABELS, ...RESERVED_PATH_SEGMENTS]) {
      expect(RESERVED_SLUGS, word).toContain(word);
    }
  });

  it.each([...RESERVED_PATH_SEGMENTS])('validateSlug refuses the path segment %s as reserved', (word) => {
    expect(validateSlug(word)).toEqual({ ok: false, reason: 'reserved-label' });
    expect(isReservedLabel(word)).toBe(true);
  });

  it('does not reserve words that merely contain a reserved segment', () => {
    expect(validateSlug('feedback-fest')).toEqual({ ok: true, slug: 'feedback-fest' });
    expect(validateSlug('setup-day')).toEqual({ ok: true, slug: 'setup-day' });
    expect(validateSlug('moreton-bay')).toEqual({ ok: true, slug: 'moreton-bay' });
  });

  it.each(['sw.js', 'manifest.webmanifest', 'build-floor.json', 'og-gcb.png', '.well-known', 'a.b'])(
    'treats %s as a reserved path segment by the structural dot rule',
    (segment) => {
      expect(isReservedPathSegment(segment)).toBe(true);
    },
  );

  it('compares reserved words without regard to case, because the router matches routes that way', () => {
    expect(isReservedPathSegment('Feed')).toBe(true);
    expect(isReservedPathSegment('SETUP')).toBe(true);
    expect(isReservedPathSegment('bodega-bay')).toBe(false);
  });
});

describe('parseAddress', () => {
  it('splits the first segment off a path address, with no I/O', () => {
    expect(parseAddress('fiveacross.app', '/bodega-bay/feed')).toEqual({
      slug: 'bodega-bay',
      basename: '/bodega-bay',
    });
  });

  it.each([
    ['/bodega-bay', 'bodega-bay'],
    ['/bodega-bay/', 'bodega-bay'],
    ['/med-2026/more/admin/prompts', 'med-2026'],
  ])('answers the candidate for %s', (pathname, slug) => {
    expect(parseAddress('fiveacross.app', pathname)).toEqual({ slug, basename: `/${slug}` });
  });

  it.each([...RESERVED_SLUGS])('answers no slug and an empty basename for the reserved segment /%s', (word) => {
    expect(parseAddress('fiveacross.app', `/${word}`)).toEqual({ slug: null, basename: '' });
    expect(parseAddress('fiveacross.app', `/${word}/anything`)).toEqual({ slug: null, basename: '' });
  });

  it.each(['/sw.js', '/manifest.webmanifest', '/assets/index-abc123.js', '/og-fiveacross.png', '/.well-known/fiveacross-path-capability'])(
    'never mistakes the asset or endpoint request %s for an Event address',
    (pathname) => {
      expect(parseAddress('fiveacross.app', pathname)).toEqual({ slug: null, basename: '' });
    },
  );

  it.each(['', '/', '//bodega-bay', 'bodega-bay'])('answers no slug for the non-address pathname %j', (pathname) => {
    expect(parseAddress('fiveacross.app', pathname)).toEqual({ slug: null, basename: '' });
  });

  it('refuses the reserved Firebase helper namespace /__/auth/handler', () => {
    expect(parseAddress('fiveacross.app', '/__/auth/handler')).toEqual({ slug: null, basename: '' });
  });

  it('is host-blind: whether a host addresses by path is decided later, by its pathNamespace', () => {
    // Step 1 runs before the host's capability is known, so its answer is
    // speculative on every host. The effective basename is resolution's job
    // (D3 step 3), never this function's.
    for (const hostname of ['fiveacross.app', 'bodega-bay.fiveacross.app', 'fiveacross.vercel.app', 'localhost']) {
      expect(parseAddress(hostname, '/bodega-bay/feed')).toEqual({ slug: 'bodega-bay', basename: '/bodega-bay' });
      expect(parseAddress(hostname, '/feed')).toEqual({ slug: null, basename: '' });
    }
  });
});

/**
 * The shared-source guard the spec's Test coverage section asks for: the client
 * parse, the Worker's namespace check and the wizard's availability check all
 * read ONE list. Proven twice, behaviourally (every reserved word is refused by
 * each consumer) and structurally (each consumer imports the shared module and
 * declares no list of its own), because a consumer that copied today's list
 * would pass the behavioural half until the day the list changed.
 */
describe('one reserved list, read by every slug consumer', () => {
  it.each([...RESERVED_SLUGS])('%s is refused by the client parse, the Worker check and the wizard check', (word) => {
    expect(parseAddress('fiveacross.app', `/${word}`).slug).toBeNull();
    for (const namespace of NAMESPACES) {
      expect(classifyHost(`${word}.${namespace}`)).toEqual({
        kind: 'rejected',
        host: `${word}.${namespace}`,
        reason: 'reserved-label',
      });
    }
    // `validateSlug` is what `StepBasics` (availability) and
    // `eventCompletenessIssues` (the launch gate) both call.
    expect(validateSlug(word)).toEqual({ ok: false, reason: 'reserved-label' });
  });

  it.each([
    ['src/components/setup/StepBasics.tsx', /from '\.\.\/\.\.\/slug'/],
    ['src/data/draftValidation.ts', /from '\.\.\/slug'/],
    ['worker/src/host.ts', /from '\.\.\/\.\.\/src\/slug'/],
    ['worker/src/resolve.ts', /from '\.\.\/\.\.\/src\/slug'/],
    ['worker/src/registry/contracts.ts', /from '\.\.\/\.\.\/\.\.\/src\/slug'/],
  ])('%s reads the shared module and declares no reserved list of its own', (path, importPattern) => {
    const src = readRepoFile(path);
    expect(src).toMatch(importPattern);
    // A second literal of reserved words is the drift this module exists to
    // prevent. `'leaderboard'` and `'unsubscribe'` appear in no other context
    // in these files, so their presence would mean a copied list.
    expect(src).not.toMatch(/'unsubscribe'|'leaderboard'|RESERVED_[A-Z_]*\s*=/);
  });

  it('reserves every frozen tab path, so a tab-table edit cannot silently free a word', () => {
    expect(TABS.length).toBeGreaterThan(0);
    for (const tab of TABS) {
      const first = tab.path.split('/')[1] ?? '';
      if (first === '') continue; // `/` is the root itself, never a segment.
      expect(RESERVED_PATH_SEGMENTS, `${tab.id} → ${tab.path}`).toContain(first);
      expect(parseAddress('fiveacross.app', tab.path)).toEqual({ slug: null, basename: '' });
    }
  });

  it('reserves every literal top-level route in src/App.tsx, including the wizard', () => {
    // The tab table covers the four tabs; the wizard is a sibling `<Route>`
    // outside it (`specs/event-setup-wizard.md` § Mount point), so this reads
    // the route literals too. An unreserved top-level route would be parsed as
    // a slug before the router could mount it.
    const app = readRepoFile('src/App.tsx');
    const literals = [...app.matchAll(/<Route\s[^>]*path="\/([^/"*]+)/g)].map((m) => m[1]);
    expect(literals).toContain('setup');
    for (const segment of literals) {
      expect(RESERVED_PATH_SEGMENTS, segment).toContain(segment);
    }
  });
});
