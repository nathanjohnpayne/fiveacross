import { describe, it, expect } from 'vitest';
import type { QueryDocumentSnapshot } from 'firebase/firestore';
import { perDayHonors, sortPlayers } from '../game/logic';
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
      isAllowedPhotoUrl('https://firebasestorage.googleapis.com/v0/b/gaycruisebingo.firebasestorage.app/o/avatars%2Fu1.jpg?alt=media&token=t'),
    ).toBe(true);
  });

  it('binds a Storage avatar to the two projects\' buckets, the avatars/ object, and — for a writer — its owner', () => {
    const own = 'https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/avatars%2Fu1.jpg?alt=media';
    expect(isAllowedPhotoUrl(own, 'u1')).toBe(true);
    expect(isAllowedPhotoUrl(own)).toBe(true); // the renderer has no owner to bind
    expect(isAllowedPhotoUrl(own, 'u2')).toBe(false); // somebody else's avatar object
    for (const value of [
      // another Firebase project's bucket — its owner reads the access logs
      'https://firebasestorage.googleapis.com/v0/b/attacker.appspot.com/o/avatars%2Fu1.jpg?alt=media',
      'https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app.evil/o/avatars%2Fu1.jpg',
      // the app's bucket, but not an avatar object
      'https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/proofs%2Fe%2Fu1%2Fp.jpg?alt=media',
      'https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/avatars%2Fu1.png',
    ]) {
      expect(isAllowedPhotoUrl(value)).toBe(false);
    }
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

// #1413: prove persisted malformed stats are safe before EVERY public consumer.
describe('playerConverter — malformed public stats', () => {
  it('bounds a legacy public name on read without changing stored data', () => {
    const raw = { displayName: 'x'.repeat(100_000) };
    expect(playerConverter.fromFirestore(snap('u1', raw)).displayName).toBe('x'.repeat(100));
    expect(playerConverter.fromFirestore(snap('u1', { displayName: 'x'.repeat(99) + '😀' })).displayName).toBe('x'.repeat(99));
    expect(raw.displayName).toHaveLength(100_000);
  });
  it.each([null, 'bad', [], { 0: null }, { 0: [] }, { 0: 42 }])('drops unreadable dayStats %j', (dayStats) => {
    const row = playerConverter.fromFirestore(snap('u1', {
      displayName: 'Ada', bingoCount: 2, squaresMarked: 9, firstBingoAt: 20, dayStats,
    }));
    expect(row.dayStats).toBeUndefined();
    expect(perDayHonors([row])).toEqual([]);
    expect(sortPlayers([row])[0].bingoCount).toBe(2);
  });

  it('retains usable honors while normalizing malformed fields and roots', () => {
    const row = playerConverter.fromFirestore(snap('u1', {
      displayName: 'Ada', bingoCount: { toString: null }, squaresMarked: Infinity,
      firstBingoAt: 'bad', dayStats: { 0: null, 1: { bingoCount: 'bad', squaresMarked: {}, firstBingoAt: 10 } },
    }));
    expect(row).toMatchObject({ bingoCount: 0, squaresMarked: 0, firstBingoAt: null,
      dayStats: { 1: { bingoCount: 0, squaresMarked: 0, firstBingoAt: 10 } } });
    expect(perDayHonors([row])).toEqual([{ dayIndex: 1, uid: 'u1', displayName: 'Ada', firstBingoAt: 10 }]);
  });
});
