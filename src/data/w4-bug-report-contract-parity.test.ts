import { describe, expect, it, vi } from 'vitest';

vi.mock('../firebase', () => ({ EVENT_ID: 'med-2026', functions: {} }));

import { BUG_REPORT_KINDS, buildBugReportInput } from './bugReports';
// The SERVER's contract, imported into the client suite on purpose. It is a
// dependency-free `.cjs` module — the same one `scripts/bug-reports-lib.mjs`
// loads — so pulling it in here costs nothing and buys the only assertion that
// actually matters: that a payload this app builds is one the callable accepts.
import contract from '../../functions/src/bugReportContract.cjs';

// Contract parity for the bug-report intake, the CLIENT half (#670).
//
// `src/data/bugReports.ts` deliberately RESTATES the server's field list rather
// than importing it: `functions/` is a separately-rooted project whose modules
// pull `firebase-admin` and `resend`, and importing across that boundary would
// drag the Functions tree into the browser bundle. A restatement is only safe if
// something proves the two statements still agree — this file is that proof, and
// its functions-side twin is `tests/functions/bug-report-contract-parity.test.ts`.

describe('the client payload and the server contract are the same contract', () => {
  it('a payload the client builds validates on the server, unchanged', () => {
    const input = buildBugReportInput({
      description: 'Someone is posting slurs in the feed.',
      kind: 'abuse',
      screenshotDataUrl: null,
      captureError: null,
      route: '/feed',
    });
    const validated = contract.validateClientReportFields(input);
    expect(validated.kind).toBe('abuse');
    // Field-for-field, not just the new one: a client field the server silently
    // drops is the same bug as a server field the client never sends.
    expect(validated).toEqual({
      schemaVersion: input.schemaVersion,
      kind: input.kind,
      description: input.description,
      captureError: input.captureError,
      route: input.route,
      eventId: input.eventId,
      appVersion: input.appVersion,
      browser: input.browser,
      viewport: input.viewport,
      online: input.online,
    });
  });

  it('declares the same kinds the server does, in the same order', () => {
    expect([...BUG_REPORT_KINDS]).toEqual([...contract.REPORT_KINDS]);
  });

  it('every kind the client can send is a kind the server keeps', () => {
    for (const kind of BUG_REPORT_KINDS) {
      const input = buildBugReportInput({
        description: 'A report.',
        kind,
        screenshotDataUrl: null,
        captureError: null,
      });
      expect(contract.validateClientReportFields(input).kind).toBe(kind);
    }
  });

  it('a payload from an ALREADY-SHIPPED client — no kind at all — still validates, as a bug', () => {
    // The back-compat guarantee from the client's side of the wire. An installed
    // PWA can hold a stale precached bundle for weeks after a deploy
    // (specs/app-update-reload-prompt.md), so the payload shape this app used to
    // send must keep working against the server this app now talks to.
    const legacy = buildBugReportInput({
      description: 'The board froze.',
      screenshotDataUrl: null,
      captureError: null,
    }) as unknown as Record<string, unknown>;
    delete legacy.kind;
    expect(contract.validateClientReportFields(legacy).kind).toBe('bug');
  });
});
