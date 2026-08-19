import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import BugReport, { BugReportProvider } from './BugReport';
import { UNSAVED_WORK_ATTRIBUTE } from '../swClientBridge';

const INDEX_CSS = readFileSync('src/index.css', 'utf8');

const { captureSpy, submitSpy, blobToDataUrlSpy, buildInputSpy, randomUuidSpy } = vi.hoisted(() => ({
  captureSpy: vi.fn(),
  submitSpy: vi.fn(),
  blobToDataUrlSpy: vi.fn(),
  buildInputSpy: vi.fn((value) => ({ ...value, schemaVersion: 1 })),
  randomUuidSpy: vi.fn(),
}));

vi.mock('../data/bugReports', () => ({
  BUG_REPORT_DESCRIPTION_MAX: 4000,
  captureAppSurface: captureSpy,
  submitBugReport: submitSpy,
  blobToDataUrl: blobToDataUrlSpy,
  buildBugReportInput: buildInputSpy,
}));

let createObjectURLMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  captureSpy.mockReset();
  submitSpy.mockReset();
  blobToDataUrlSpy.mockReset();
  buildInputSpy.mockClear();
  randomUuidSpy.mockReset();
  randomUuidSpy.mockReturnValue('00000000-0000-4000-8000-000000000001');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: randomUuidSpy });
  createObjectURLMock = vi.fn(() => 'blob:preview');
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: createObjectURLMock,
    revokeObjectURL: vi.fn(),
  });
});

// The sheet + pick bar render from BugReportProvider (the App.tsx shell
// mount, #324); `BugReport` itself is just the launcher. Every render below
// wraps in the provider exactly as the live shell does.
function renderFlow(ui: ReactElement = <BugReport />) {
  return render(<BugReportProvider>{ui}</BugReportProvider>);
}

describe('W4 bug-report inbox', () => {
  it('pins responsive, safe-area, install-prompt, and modal-suppression CSS contracts', () => {
    const css = INDEX_CSS;
    expect(css).toMatch(/\.bug-report-trigger\s*\{[^}]*right:\s*max\(12px, env\(safe-area-inset-right\)\)/s);
    expect(css).toMatch(/bottom:\s*calc\(76px \+ env\(safe-area-inset-bottom\)\)/);
    expect(css).toMatch(/body\.install-prompt-visible \.bug-report-trigger/);
    expect(css).toMatch(/body:has\(\.celebrate\) \.bug-report-trigger/);
    expect(css).toMatch(/body:has\(\.sheet-backdrop\) \.bug-report-trigger/);
    expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*\.bug-report-trigger span/);
  });

  it('pins the pick bar above the generic sheet layer with tab-bar and toast clearance (#324)', () => {
    const css = INDEX_CSS;
    const pickBlock = css.match(/\.bug-report-pick\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(pickBlock).toMatch(/position:\s*fixed/);
    expect(pickBlock).toMatch(/bottom:\s*calc\(76px \+ env\(safe-area-inset-bottom\)\)/);
    // Above claim/proof sheets (z 70) so an open sheet is itself capturable;
    // below the report sheet's own backdrop (z 80).
    expect(pickBlock).toMatch(/z-index:\s*75/);
    expect(css).toMatch(/body\.install-prompt-visible \.bug-report-pick/);
  });

  it('renders a persistent accessible utility control, not a navigation link', () => {
    renderFlow();
    const trigger = screen.getByRole('button', { name: 'Report a bug' });
    expect(trigger).toHaveClass('bug-report-trigger');
    expect(screen.queryByRole('link', { name: 'Report a bug' })).not.toBeInTheDocument();
  });

  it('captures the app surface on open and previews the image before submission', async () => {
    captureSpy.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(await screen.findByAltText('Screenshot that will be submitted with this bug report')).toHaveAttribute('src', 'blob:preview');
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  it('allows text-only submission after capture fails and returns a receipt id', async () => {
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    submitSpy.mockResolvedValue({ reportId: 'report-123' });
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    expect(await screen.findByText(/Screenshot unavailable/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The card froze after I marked a square.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(buildInputSpy).toHaveBeenCalledWith({
      submissionId: '00000000-0000-4000-8000-000000000001',
      description: 'The card froze after I marked a square.',
      // A reporter who never touches the kind control sends `bug` — the same
      // thing an already-shipped client sends by sending nothing (#670).
      kind: 'bug',
      screenshotDataUrl: null,
      captureError: 'Canvas unavailable',
      route: undefined,
    });
    expect(await screen.findByText('report-123')).toBeInTheDocument();
  });

  it('lets the reporter mark a report as abuse, defaulting to bug (#670)', async () => {
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    submitSpy.mockResolvedValue({ reportId: 'report-abuse' });
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    const bug = await screen.findByRole('radio', { name: 'Something is broken' });
    const abuse = screen.getByRole('radio', { name: 'Abuse or harmful content' });
    // Bug is pre-selected, so the default is visible rather than implied.
    expect(bug).toBeChecked();
    expect(abuse).not.toBeChecked();
    // The consequence is stated only once the reporter has chosen it, and it is
    // stated as an ATTEMPT: whether an admin is actually reached depends on a
    // membership fact only the server holds.
    const promise = /try to raise this with the event.s admins/i;
    expect(screen.queryByText(promise)).not.toBeInTheDocument();
    fireEvent.click(abuse);
    expect(abuse).toBeChecked();
    expect(screen.getByText(promise)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'Someone is posting slurs.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(buildInputSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'abuse' }));
  });

  it('reports what the SERVER did about an abuse report, rather than what the sheet promised (#670)', async () => {
    // A person reporting harm must not be left believing an admin was reached
    // when the report only entered the inbox — the sheet cannot know, so the
    // receipt states the outcome the callable returned.
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    const fileAbuse = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
      fireEvent.click(await screen.findByRole('radio', { name: 'Abuse or harmful content' }));
      fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'Someone is posting slurs.' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    };

    submitSpy.mockResolvedValue({ reportId: 'report-alerted', escalationEligible: true });
    renderFlow();
    await fileAbuse();
    expect(await screen.findByText('Your report is marked for this event’s admins.')).toBeInTheDocument();
    // The safety line is UNCONDITIONAL: even the positive branch reflects only
    // checks made before the alert is queued, so neither branch can promise that
    // an admin sees this — and a reporter must not be steered away from a faster
    // route by a receipt that sounds like one is already underway.
    expect(screen.getByText(/If someone may be in danger, tell an/)).toBeInTheDocument();

    submitSpy.mockResolvedValue({ reportId: 'report-quiet', escalationEligible: false });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await fileAbuse();
    expect(await screen.findByText(/isn’t marked for this event’s admins/)).toBeInTheDocument();

    // An older deployed callable returns only `reportId`. That is "no claim
    // made", not a success — it must degrade to the honest half.
    submitSpy.mockResolvedValue({ reportId: 'report-legacy' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await fileAbuse();
    expect(await screen.findByText(/isn’t marked for this event’s admins/)).toBeInTheDocument();
  });

  it('freezes the classification while a submit is in flight, so the receipt cannot describe a report nobody filed (#670)', async () => {
    // The sheet stays mounted across a slow submit. Reading the LIVE `kind` on
    // the receipt would describe whatever is selected now rather than what was
    // sent — select abuse, press Send, switch to bug, and the abuse outcome
    // silently disappears.
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    let resolveSubmit!: (result: { reportId: string; escalationEligible: boolean }) => void;
    submitSpy.mockReturnValue(new Promise((resolve) => { resolveSubmit = resolve; }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    const abuse = await screen.findByRole('radio', { name: 'Abuse or harmful content' });
    fireEvent.click(abuse);
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'Someone is posting slurs.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    // Frozen at source: the control cannot move mid-flight in the first place.
    await waitFor(() => expect(abuse).toBeDisabled());
    expect(screen.getByRole('radio', { name: 'Something is broken' })).toBeDisabled();

    // And even if it did, the receipt reports the kind that was SENT.
    fireEvent.click(screen.getByRole('radio', { name: 'Something is broken' }));
    resolveSubmit({ reportId: 'report-abuse', escalationEligible: true });
    expect(await screen.findByText('Your report is marked for this event’s admins.')).toBeInTheDocument();
    expect(buildInputSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'abuse' }));
  });

  it('keeps the focus trap on controls the browser will actually focus, mid-submit included', async () => {
    // The radios are disabled by their parent `<fieldset disabled>` and carry no
    // attribute of their own, so an attribute-based query kept them in the trap's
    // list while the browser refused to focus them. Mid-submit, with Send
    // disabled too, the boundary stopped matching anything reachable and Tab
    // walked out of the modal (Phase 4b P2).
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    let resolveSubmit!: (result: { reportId: string; escalationEligible: boolean }) => void;
    submitSpy.mockReturnValue(new Promise((resolve) => { resolveSubmit = resolve; }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    const textarea = await screen.findByLabelText('What happened?');
    fireEvent.change(textarea, { target: { value: 'Something broke.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Something is broken' })).toBeDisabled());

    const dialog = screen.getByRole('dialog', { name: 'Report a bug' });
    const landed = () => document.activeElement as HTMLElement;
    const stillTrapped = () => {
      expect(dialog.contains(landed())).toBe(true);
      expect(landed()).not.toBeDisabled();
    };

    // The frozen draft leaves one reachable status target while every mutable
    // field and action is disabled. Both directions wrap onto that target,
    // never onto a disabled field or out of the dialog.
    const status = screen.getByRole('status');
    status.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    stillTrapped();
    expect(status).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(status).toHaveFocus();
    stillTrapped();
    resolveSubmit({ reportId: 'report-1', escalationEligible: false });
    await screen.findByText('report-1');
  });

  it('gives each report-kind label a real 44px tap target', () => {
    // A 13px line plus a few px of padding measures ~24px, which is the sort of
    // thing a comment can claim and the box model quietly refuse. Phone-first
    // UI, so the whole label has to reach the floor the rest of the app uses.
    const optionBlock = INDEX_CSS.match(/\.bug-report-kind-option\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(optionBlock).toMatch(/min-height:\s*44px/);
    expect(optionBlock).toMatch(/cursor:\s*pointer/);
  });

  it('opens the sheet on the kind choice, so forward navigation cannot skip it (#670)', async () => {
    // The textarea used to take autoFocus, and it sits BELOW the kind control —
    // so tabbing forward never reached the classification, and a report of harm
    // could be submitted under the default `bug` without the reporter ever
    // meeting the control that escalates it.
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    expect(await screen.findByRole('radio', { name: 'Something is broken' })).toHaveFocus();
    expect(screen.getByLabelText('What happened?')).not.toHaveFocus();
  });

  it('resets the kind to bug when a fresh report is opened', async () => {
    // The draft survives a park/reopen inside one flow (#324), but a NEW report
    // must not inherit the last one's abuse marking.
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    submitSpy.mockResolvedValue({ reportId: 'report-1' });
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Abuse or harmful content' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    expect(await screen.findByRole('radio', { name: 'Something is broken' })).toBeChecked();
  });

  it('encodes an approved screenshot and keeps the sheet open on a retryable submit error', async () => {
    const screenshot = new Blob(['png'], { type: 'image/png' });
    captureSpy.mockResolvedValue(screenshot);
    blobToDataUrlSpy.mockResolvedValue('data:image/png;base64,abc');
    submitSpy.mockRejectedValue({ code: 'functions/unavailable' });
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'Ranks did not update.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not submit');
    expect(blobToDataUrlSpy).toHaveBeenCalledWith(screenshot);
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
  });

  it('freezes one built payload and retry identity across an ambiguous retry', async () => {
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    submitSpy
      .mockRejectedValueOnce({ code: 'functions/unavailable' })
      .mockResolvedValueOnce({ reportId: 'report-recovered' });
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByText(/Screenshot unavailable/);
    const description = screen.getByLabelText('What happened?');
    fireEvent.change(description, { target: { value: 'The card froze.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not submit');
    expect(description).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Something is broken' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Try screenshot again' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText('report-recovered')).toBeInTheDocument();
    expect(buildInputSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(submitSpy.mock.calls[1][0]).toBe(submitSpy.mock.calls[0][0]);
    expect(submitSpy.mock.calls[0][0]).toEqual(expect.objectContaining({
      submissionId: '00000000-0000-4000-8000-000000000001',
      description: 'The card froze.',
    }));
  });

  it('unfreezes only a definitively pre-claim invalid payload and reuses its identity', async () => {
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    submitSpy
      .mockRejectedValueOnce({ code: 'functions/invalid-argument', message: 'Description is invalid.' })
      .mockResolvedValueOnce({ reportId: 'report-corrected' });
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByText(/Screenshot unavailable/);
    const description = screen.getByLabelText('What happened?');
    fireEvent.change(description, { target: { value: 'First description.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Description is invalid.');
    expect(description).not.toBeDisabled();
    fireEvent.change(description, { target: { value: 'Corrected description.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText('report-corrected')).toBeInTheDocument();
    expect(buildInputSpy).toHaveBeenCalledTimes(2);
    expect(buildInputSpy.mock.calls.map(([input]) => input.submissionId)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(buildInputSpy.mock.calls[1][0].description).toBe('Corrected description.');
  });

  it('keeps one identity through park/reopen, then mints a new one after success or cancel', async () => {
    randomUuidSpy
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    submitSpy.mockResolvedValue({ reportId: 'report-complete' });
    renderFlow();

    const launcher = screen.getByRole('button', { name: 'Report a bug' });
    fireEvent.click(launcher);
    await screen.findByText(/Screenshot unavailable/);
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));
    fireEvent.click(launcher);
    expect(randomUuidSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The route froze.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByText('report-complete');
    expect(buildInputSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      submissionId: '00000000-0000-4000-8000-000000000001',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(launcher);
    expect(randomUuidSpy).toHaveBeenCalledTimes(2);
    await screen.findByText(/Screenshot unavailable/);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(launcher);
    expect(randomUuidSpy).toHaveBeenCalledTimes(3);
    await screen.findByText(/Screenshot unavailable/);
  });

  it('pairs the ready-state capture actions in a wrappable row below the full-width preview (#362)', async () => {
    captureSpy.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    const preview = await screen.findByAltText('Screenshot that will be submitted with this bug report');
    const actions = screen.getByRole('button', { name: 'Retake screenshot' }).closest('.bug-report-capture-actions');
    expect(actions).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Capture a different screen' }).closest('.bug-report-capture-actions')).toBe(actions);
    // The preview stays a direct full-width row of the capture grid, outside the pair.
    expect(preview.closest('.bug-report-capture-actions')).toBeNull();
    expect(preview.parentElement).toBe(actions?.parentElement);
    // Side by side when space allows, stacked when narrow: width-driven wrap, no breakpoint.
    const actionsBlock = INDEX_CSS.match(/\.bug-report-capture-actions\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(actionsBlock).toMatch(/display:\s*flex/);
    expect(actionsBlock).toMatch(/flex-wrap:\s*wrap/);
  });

  it('pairs the failed-state capture actions in the same wrappable row (#362)', async () => {
    captureSpy.mockRejectedValue(new Error('Canvas unavailable'));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByText(/Screenshot unavailable/);
    const actions = screen.getByRole('button', { name: 'Try screenshot again' }).closest('.bug-report-capture-actions');
    expect(actions).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Capture a different screen' }).closest('.bug-report-capture-actions')).toBe(actions);
  });

  it('surfaces the server rejection reason on invalid-argument instead of connection copy (#361)', async () => {
    captureSpy.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    blobToDataUrlSpy.mockResolvedValue('data:image/png;base64,abc');
    submitSpy.mockRejectedValueOnce({ code: 'functions/invalid-argument', message: 'Screenshot PNG header is invalid.' });
    submitSpy.mockRejectedValueOnce({ code: 'functions/invalid-argument' });
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'Sending always fails.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Screenshot PNG header is invalid.');
    // Without a server detail it still names the rejection, not the connection.
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The report was rejected. Adjust it and try again.'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('Check your connection');
  });

  it('closes with Escape and restores focus to the persistent trigger', async () => {
    captureSpy.mockRejectedValue(new Error('Capture unavailable'));
    renderFlow();
    const trigger = screen.getByRole('button', { name: 'Report a bug' });
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Report a bug' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Report a bug' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ignores a stale capture that finishes after the sheet is closed', async () => {
    let resolveCapture!: (image: Blob) => void;
    captureSpy.mockReturnValue(new Promise<Blob>((resolve) => { resolveCapture = resolve; }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByRole('dialog', { name: 'Report a bug' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    resolveCapture(new Blob(['late'], { type: 'image/png' }));
    await Promise.resolve();
    expect(screen.queryByAltText('Screenshot that will be submitted with this bug report')).not.toBeInTheDocument();
  });

  it('traps keyboard focus within the modal sheet', async () => {
    captureSpy.mockRejectedValue(new Error('Capture unavailable'));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByText(/Screenshot unavailable/);
    const textarea = screen.getByLabelText('What happened?');
    fireEvent.change(textarea, { target: { value: 'The board froze.' } });
    const send = screen.getByRole('button', { name: 'Send report' });
    expect(send).toBeEnabled();
    // The wrap targets whatever is FIRST in the sheet, which since #670 is the
    // kind control rather than the textarea — the reporter classifies the report
    // before they describe it.
    const first = screen.getByRole('radio', { name: 'Something is broken' });
    send.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(send).toHaveFocus();
  });

  it('treats the radio group as ONE tab stop, so focus cannot escape past a selected abuse radio', async () => {
    // Browsers visit only the CHECKED member of a radio group. Comparing the
    // backward-wrap against the first DOM radio therefore never matches once a
    // later member is selected, and focus walks out of the modal (#670 Codex P2).
    captureSpy.mockRejectedValue(new Error('Capture unavailable'));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    const abuse = await screen.findByRole('radio', { name: 'Abuse or harmful content' });
    fireEvent.click(abuse);
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'Someone is posting slurs.' } });
    const send = screen.getByRole('button', { name: 'Send report' });
    // Backward from the now-checked abuse radio wraps to the last stop rather
    // than leaving the dialog.
    abuse.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(send).toHaveFocus();
    // And forward from the last stop returns to the CHECKED radio, which is the
    // one the browser would actually focus.
    send.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(abuse).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Something is broken' })).not.toHaveFocus();
  });
});

describe('W4 pick-a-screen capture (#324)', () => {
  it('parks the sheet in pick mode and swaps in a capture of the newly visible screen', async () => {
    const firstBlob = new Blob(['more'], { type: 'image/png' });
    const secondBlob = new Blob(['card'], { type: 'image/png' });
    captureSpy.mockResolvedValueOnce(firstBlob).mockResolvedValueOnce(secondBlob);
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));
    expect(screen.queryByRole('dialog', { name: 'Report a bug' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Capture this screen' }));
    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    expect(captureSpy).toHaveBeenCalledTimes(2);
    expect(createObjectURLMock).toHaveBeenLastCalledWith(secondBlob);
  });

  it('offers pick mode from the capture-failed state too', async () => {
    captureSpy.mockRejectedValueOnce(new Error('Canvas unavailable'));
    captureSpy.mockResolvedValueOnce(new Blob(['card'], { type: 'image/png' }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByText(/Screenshot unavailable/);
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture this screen' }));
    expect(await screen.findByAltText('Screenshot that will be submitted with this bug report')).toBeInTheDocument();
  });

  it('steps back from pick mode with Escape, keeping the sheet and its capture, then closes', async () => {
    captureSpy.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByAltText('Screenshot that will be submitted with this bug report')).toBeInTheDocument();
    expect(captureSpy).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Report a bug' })).not.toBeInTheDocument();
  });

  it('keeps the prior capture when picking a replacement screen fails', async () => {
    const moreBlob = new Blob(['more'], { type: 'image/png' });
    captureSpy.mockResolvedValueOnce(moreBlob).mockRejectedValueOnce(new Error('Canvas unavailable'));
    blobToDataUrlSpy.mockResolvedValue('data:image/png;base64,more');
    submitSpy.mockResolvedValue({ reportId: 'report-kept' });
    window.history.replaceState({}, '', '/more');
    renderFlow();

    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The selected screen would not capture.' } });
    window.history.replaceState({}, '', '/');
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture this screen' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Keeping the previous screenshot');
    expect(screen.getByAltText('Screenshot that will be submitted with this bug report')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(blobToDataUrlSpy).toHaveBeenCalledWith(moreBlob);
    expect(buildInputSpy).toHaveBeenCalledWith({
      submissionId: '00000000-0000-4000-8000-000000000001',
      description: 'The selected screen would not capture.',
      kind: 'bug',
      screenshotDataUrl: 'data:image/png;base64,more',
      captureError: null,
      route: '/more',
    });
  });

  it('survives the launcher unmounting mid-pick and submits the picked screen with its draft (#324 regression)', async () => {
    // The live regression: the only launcher lives on /more, so leaving it to
    // reach the buggy screen unmounts the trigger. The flow must keep going.
    function TwoScreenHarness() {
      const [onMore, setOnMore] = useState(true);
      return (
        <BugReportProvider>
          {onMore ? <BugReport variant="row" /> : <p>Bingo card screen</p>}
          <button type="button" onClick={() => setOnMore(false)}>Go to Card</button>
        </BugReportProvider>
      );
    }
    const moreBlob = new Blob(['more'], { type: 'image/png' });
    const cardBlob = new Blob(['card'], { type: 'image/png' });
    captureSpy.mockResolvedValueOnce(moreBlob).mockResolvedValueOnce(cardBlob);
    blobToDataUrlSpy.mockResolvedValue('data:image/png;base64,card');
    submitSpy.mockResolvedValue({ reportId: 'report-324' });
    render(<TwoScreenHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'A tile on my card is broken.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));

    fireEvent.click(screen.getByRole('button', { name: 'Go to Card' }));
    expect(screen.queryByRole('button', { name: 'Report a bug' })).not.toBeInTheDocument();
    expect(screen.getByText('Bingo card screen')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Capture this screen' }));
    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByLabelText('What happened?')).toHaveValue('A tile on my card is broken.');
    expect(createObjectURLMock).toHaveBeenLastCalledWith(cardBlob);

    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(buildInputSpy).toHaveBeenCalledWith({
      submissionId: '00000000-0000-4000-8000-000000000001',
      description: 'A tile on my card is broken.',
      kind: 'bug',
      screenshotDataUrl: 'data:image/png;base64,card',
      captureError: null,
      route: '/',
    });
    expect(await screen.findByText('report-324')).toBeInTheDocument();
  });

  it('marks the whole flow as holding unsaved work, dialog phase AND pick mode (#621)', async () => {
    // The other half of the `src/swClientBridge.ts` contract (Codex P2 round
    // 4): an automatic post-deploy reload defers on `[data-unsaved-work]`.
    // Only the dialog phase carries `role="dialog" aria-modal="true"`, so
    // without the marker on the flow container, "Capture a different screen"
    // let the reload through and destroyed the description and the screenshot
    // — both of which live only in this component's state until submit.
    captureSpy.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    const marker = `[${UNSAVED_WORK_ATTRIBUTE}]`;
    renderFlow();
    expect(document.querySelector(marker)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    expect(document.querySelector(marker)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));
    expect(screen.queryByRole('dialog', { name: 'Report a bug' })).not.toBeInTheDocument();
    expect(document.querySelector(marker)).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector(marker)).toBeNull());
  });

  it('recalls the parked sheet, draft intact, when a launcher is tapped mid-pick', async () => {
    captureSpy.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'Draft in progress.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByLabelText('What happened?')).toHaveValue('Draft in progress.');
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  it('labels the capture with the route where it STARTED, not where a slow capture resolves', async () => {
    // The tab bar stays usable while a pick capture is in flight, so a slow
    // capture followed by a quick tab change must not relabel the image with
    // the later route (Codex P2 on #328).
    const cardBlob = new Blob(['card'], { type: 'image/png' });
    let resolveCapture!: (image: Blob) => void;
    captureSpy
      .mockResolvedValueOnce(new Blob(['more'], { type: 'image/png' }))
      .mockReturnValueOnce(new Promise<Blob>((resolve) => { resolveCapture = resolve; }));
    blobToDataUrlSpy.mockResolvedValue('data:image/png;base64,card');
    submitSpy.mockResolvedValue({ reportId: 'report-race' });
    window.history.replaceState({}, '', '/');
    renderFlow();

    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await screen.findByAltText('Screenshot that will be submitted with this bug report');
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'Slow capture race.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Capture a different screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture this screen' }));
    // Capture is in flight on '/'; the reporter switches tabs before it lands.
    window.history.replaceState({}, '', '/feed');
    resolveCapture(cardBlob);

    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(buildInputSpy).toHaveBeenCalledWith({
      submissionId: '00000000-0000-4000-8000-000000000001',
      description: 'Slow capture race.',
      kind: 'bug',
      screenshotDataUrl: 'data:image/png;base64,card',
      captureError: null,
      route: '/',
    });
    window.history.replaceState({}, '', '/');
  });
});
