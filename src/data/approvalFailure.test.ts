import { describe, expect, it } from 'vitest';
import { approvalFailureLabel } from './approvalFailure';

// The approval controls' failure copy (#1275, Phase 4b P2 on PR #1278): a
// refusal a retry cannot fix carries the callable's own fixed message; anything
// else falls back to the control's generic retry copy.
describe('approvalFailureLabel', () => {
  it('returns the server message for every permanent refusal, in both code spellings', () => {
    for (const code of ['unauthenticated', 'permission-denied', 'failed-precondition', 'invalid-argument']) {
      expect(approvalFailureLabel({ code: `functions/${code}`, message: 'Fixed text.' })).toBe('Fixed text.');
      expect(approvalFailureLabel({ code, message: 'Fixed text.' })).toBe('Fixed text.');
    }
  });

  it('leaves a retryable failure to the generic copy', () => {
    for (const code of ['functions/aborted', 'functions/internal', 'functions/unavailable', 'functions/deadline-exceeded']) {
      expect(approvalFailureLabel({ code, message: 'Try again.' })).toBeUndefined();
    }
  });

  it('never labels a non-callable or malformed error', () => {
    expect(approvalFailureLabel(new Error('offline'))).toBeUndefined();
    expect(approvalFailureLabel({ code: 'functions/failed-precondition', message: '' })).toBeUndefined();
    expect(approvalFailureLabel({ code: 42, message: 'x' })).toBeUndefined();
    expect(approvalFailureLabel(null)).toBeUndefined();
    expect(approvalFailureLabel('failed-precondition')).toBeUndefined();
  });
});
