// The failure copy for the `approvePrompts` callable's refusals (#1275,
// Phase 4b P2 on PR #1278). Its own module, beside `approveItems` in
// ./admin.ts, so the Review queue can use the real mapping even where a test
// replaces the admin write module with doubles.

/** The `approvePrompts` refusals a retry cannot fix. Their messages are fixed,
 *  bounded strings the callable writes itself (never a thrown value), so they
 *  are safe to show verbatim. `aborted` and `internal` are left to the generic
 *  retry copy: retrying is exactly the right advice for those. */
const PERMANENT_APPROVAL_CODES: ReadonlySet<string> = new Set([
  'unauthenticated',
  'permission-denied',
  'failed-precondition',
  'invalid-argument',
]);

/**
 * The failure label an approval control shows for `error`: the server's own
 * message for a refusal a retry cannot fix (a closed Event, a non-admin, a batch
 * over the cap), otherwise `undefined` so the control keeps its generic "try
 * again" copy. Accepts the SDK's `functions/<code>` spelling and a bare code.
 */
export function approvalFailureLabel(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string' || message === '') return undefined;
  const bare = code.startsWith('functions/') ? code.slice('functions/'.length) : code;
  return PERMANENT_APPROVAL_CODES.has(bare) ? message : undefined;
}
