import { describe, expect, it } from 'vitest';
import { isAlreadyExists } from '../../functions/src/firestoreErrors';

describe('Firestore ALREADY_EXISTS classifier', () => {
  it('recognizes Admin SDK, canonical string, and emulator/message forms', () => {
    for (const error of [
      { code: 6 },
      { code: 'already-exists' },
      { code: 'ALREADY_EXISTS' },
      { code: '6' },
      { message: 'Document already exists: projects/test/databases/(default)' },
      { message: '6 ALREADY_EXISTS' },
    ]) {
      expect(isAlreadyExists(error)).toBe(true);
    }
  });

  it('does not classify unrelated failures as a create collision', () => {
    for (const error of [null, {}, { code: 5 }, { code: 'not-found' }, new Error('backend unavailable')]) {
      expect(isAlreadyExists(error)).toBe(false);
    }
  });
});
