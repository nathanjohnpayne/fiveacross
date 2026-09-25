// #1279: the console's Approve all bound is a client copy of the `approvePrompts`
// callable's per-call cap (src/ never imports functions/ at runtime). This pins
// the two together, so a change to either side that leaves the other behind
// fails here rather than in production as a whole-batch refusal.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_APPROVE_ALL_ITEMS, approveAllBatch } from './approvalBatch';

describe('Approve all batch bound (#1279)', () => {
  it('matches MAX_APPROVE_PROMPTS_ITEMS in functions/src/approvePrompts.ts', () => {
    const source = readFileSync('functions/src/approvePrompts.ts', 'utf8');
    const declarations = [...source.matchAll(/^export const MAX_APPROVE_PROMPTS_ITEMS = (\d+);$/gm)];
    expect(declarations).toHaveLength(1);
    expect(Number(declarations[0][1])).toBe(MAX_APPROVE_ALL_ITEMS);
  });

  it('takes the first MAX_APPROVE_ALL_ITEMS rows in order and leaves a shorter queue whole', () => {
    const queue = Array.from({ length: MAX_APPROVE_ALL_ITEMS + 3 }, (_, i) => i);
    expect(approveAllBatch(queue)).toEqual(queue.slice(0, MAX_APPROVE_ALL_ITEMS));
    expect(approveAllBatch(queue.slice(0, 3))).toEqual([0, 1, 2]);
    expect(approveAllBatch([])).toEqual([]);
  });
});
