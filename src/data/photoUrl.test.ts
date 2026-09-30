import { describe, it, expect } from 'vitest';
import type { QueryDocumentSnapshot } from 'firebase/firestore';
import { playerConverter, proofConverter } from './converters';
import { allowedPhotoUrlOrNull, isAllowedPhotoUrl, PHOTO_URL_MAX } from './photoUrl';

// specs/sec-rules-shape-hardening.md — the client mirror of `firestore.rules`'
// `photoUrlOk`: every avatar writer stores through it and `Avatar` renders
// through it, so the two sides accept exactly the same URLs.

describe('isAllowedPhotoUrl — the avatar hosts the app itself produces', () => {
  it('accepts a Google account photo and a Firebase Storage download URL', () => {
    expect(isAllowedPhotoUrl('https://lh3.googleusercontent.com/a/ACg8oc-x=s96-c')).toBe(true);
    expect(isAllowedPhotoUrl('https://lh5.googleusercontent.com/-abc/photo.jpg')).toBe(true);
    expect(
      isAllowedPhotoUrl('https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/avatars%2Fu1.jpg?alt=media&token=t'),
    ).toBe(true);
  });

  it('refuses every other host, look-alike, scheme, type and over-long value', () => {
    for (const value of [
      'https://tracker.example/pixel.gif',
      'https://lh3.googleusercontent.com.tracker.example/x',
      'https://evil.example/https://lh3.googleusercontent.com/x',
      'http://lh3.googleusercontent.com/x',
      'https://lh3.googleusercontent.com',
      '//lh3.googleusercontent.com/x',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg/>',
      '',
      null,
      undefined,
      42,
      { url: 'https://lh3.googleusercontent.com/x' },
      `https://lh3.googleusercontent.com/${'a'.repeat(PHOTO_URL_MAX)}`,
    ]) {
      expect(isAllowedPhotoUrl(value)).toBe(false);
    }
  });

  it('stores null in place of anything it refuses', () => {
    expect(allowedPhotoUrlOrNull('https://tracker.example/p.gif')).toBeNull();
    expect(allowedPhotoUrlOrNull(undefined)).toBeNull();
    expect(allowedPhotoUrlOrNull('https://lh3.googleusercontent.com/x')).toBe('https://lh3.googleusercontent.com/x');
  });
});

// The converters coerce what a legacy row may still carry, so one malformed row
// cannot throw in every other viewer's render (the rules now refuse the shape on
// write; rows written before that still read back).

const snap = (id: string, data: Record<string, unknown>) =>
  ({ id, data: () => data }) as unknown as QueryDocumentSnapshot;

describe('playerConverter / proofConverter — rendered fields read as their contract types', () => {
  it('reads a non-string Player name as absent and a disallowed avatar as null', () => {
    const p = playerConverter.fromFirestore(snap('u1', { displayName: 42, photoURL: 'https://tracker.example/p.gif' }));
    expect('displayName' in p).toBe(false);
    expect(p.photoURL).toBeNull();
    const ok = playerConverter.fromFirestore(
      snap('u2', { displayName: 'Ada', photoURL: 'https://lh3.googleusercontent.com/x' }),
    );
    expect(ok.displayName).toBe('Ada');
    expect(ok.photoURL).toBe('https://lh3.googleusercontent.com/x');
  });

  it('reads a non-string Callout text and a disallowed avatar as null on a Proof', () => {
    const p = proofConverter.fromFirestore(snap('p1', { text: { rich: true }, photoURL: { src: 'x' } }));
    expect(p.text).toBeNull();
    expect(p.photoURL).toBeNull();
    expect(proofConverter.fromFirestore(snap('p2', { text: 'hi', photoURL: null })).text).toBe('hi');
    expect('text' in proofConverter.fromFirestore(snap('p3', { photoURL: null }))).toBe(false);
  });
});
