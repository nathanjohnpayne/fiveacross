// How much of the Approvals queue one "Approve all" click sends (#1279). Its own
// module, like ./approvalFailure.ts, so the Review queue uses the real bound even
// where a test replaces the admin write module (./admin.ts) with doubles.

/**
 * The most rows one `approvePrompts` call accepts. Mirrors
 * `MAX_APPROVE_PROMPTS_ITEMS` in `functions/src/approvePrompts.ts` (400): the
 * callable refuses a larger batch whole, as `invalid-argument`, because one call
 * is one transaction and one shared `approvedAt` instant (ADR 0015). Kept as a
 * client copy rather than an import so `src/` never reaches into `functions/`;
 * change both together.
 */
export const MAX_APPROVE_ALL_ITEMS = 400;

/**
 * The rows one Approve all sends: the first `MAX_APPROVE_ALL_ITEMS` of `pending`,
 * in the order given. The Approvals queue is already oldest-first
 * (`usePendingItems`), so this is the oldest 400, and the server's whole-batch
 * refusal is never reachable from the console. The remainder stays pending and
 * the next click, once the queue re-renders, takes the next oldest 400. Not
 * chunked into several calls on purpose (#1279): each chunk would carry its own
 * server instant and fence write, and a mid-run failure would leave the queue
 * partly approved.
 */
export function approveAllBatch<T>(pending: readonly T[]): T[] {
  return pending.slice(0, MAX_APPROVE_ALL_ITEMS);
}
