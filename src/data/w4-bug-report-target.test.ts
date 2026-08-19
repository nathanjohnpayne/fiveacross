// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bugReportFirebaseConfig } from '../../scripts/bug-report-target.mjs';

describe('bug-report operator target selection', () => {
  it.each([
    ['gaycruisebingo', 'gaycruisebingo', 'gaycruisebingo.firebasestorage.app'],
    ['fiveacross', 'fiveacross', 'fiveacross.firebasestorage.app'],
  ])('pins %s to its registered Firebase project and private bucket', (target, projectId, storageBucket) => {
    expect(bugReportFirebaseConfig(target)).toEqual({ projectId, storageBucket });
  });

  it('rejects any unregistered target rather than accepting an ambient project', () => {
    expect(() => bugReportFirebaseConfig('other-project')).toThrow(
      'Unknown deploy target "other-project". Expected one of: gaycruisebingo, fiveacross.',
    );
  });
});
