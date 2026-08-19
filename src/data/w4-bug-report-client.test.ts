import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../firebase', () => ({ EVENT_ID: 'med-2026', functions: {} }));

const { html2canvasSpy, toBlobSpy } = vi.hoisted(() => ({
  html2canvasSpy: vi.fn(),
  toBlobSpy: vi.fn(),
}));

vi.mock('html2canvas', () => ({ default: html2canvasSpy }));
vi.mock('html-to-image', () => ({ toBlob: toBlobSpy }));

import { buildBugReportInput, captureAppSurface } from './bugReports';
import { BUG_REPORT_SCREENSHOT_MAX_DIMENSION, planCaptureScale } from './screenshotFit';

beforeEach(() => {
  html2canvasSpy.mockReset();
  toBlobSpy.mockReset();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
  document.body.innerHTML = '';
});

describe('bug-report client diagnostics', () => {
  it('keeps the unhashed service worker out of immutable hosting cache', () => {
    // sw.js is the unhashed artifact update detection rides on: UpdatePrompt's
    // periodic registration.update() (specs/app-update-reload-prompt.md) only
    // sees a new deploy if hosting never lets sw.js go immutable. Registration
    // itself moved in-bundle in #178 (UpdatePrompt's virtual:pwa-register/react
    // import), so there is no separate registerSW.js to guard anymore.
    const firebaseConfig = JSON.parse(readFileSync('firebase.json', 'utf8')) as {
      hosting: { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
    };
    const noCacheSources = firebaseConfig.hosting.headers
      .filter((entry) => entry.headers.some((header) => header.key === 'Cache-Control' && header.value === 'no-cache'))
      .map((entry) => entry.source);
    expect(noCacheSources.some((source) => source.includes('sw.js'))).toBe(true);
  });

  it('records the screen path without potentially sensitive query parameters', () => {
    window.history.replaceState({}, '', '/leaderboard?invite=secret-token');
    const input = buildBugReportInput({
      submissionId: 'submit_client_123',
      description: 'The board froze.',
      screenshotDataUrl: null,
      captureError: 'Capture unavailable',
    });
    expect(input.route).toBe('/leaderboard');
  });

  it('prefers the capture-time route over the submit-time pathname when one is passed (#324)', () => {
    // Pick mode can capture one screen and submit from another; the report
    // must be labeled with the screen the screenshot actually shows.
    window.history.replaceState({}, '', '/more');
    const input = buildBugReportInput({
      submissionId: 'submit_client_123',
      description: 'A tile on my card is broken.',
      screenshotDataUrl: 'data:image/png;base64,abc',
      captureError: null,
      route: '/',
    });
    expect(input.route).toBe('/');
    expect(
      buildBugReportInput({
        submissionId: 'submit_client_123',
        description: 'A tile on my card is broken.',
        screenshotDataUrl: 'data:image/png;base64,abc',
        captureError: null,
        route: `/${'x'.repeat(300)}`,
      }).route,
    ).toHaveLength(200);
  });

  it('defaults the report kind to bug, and carries an abuse marking when one is passed (#670)', () => {
    // The default matters as much as the marking: a caller with no opinion must
    // produce exactly the payload an already-shipped client sends, so adding the
    // control changed what an abuse report does and nothing about a bug report.
    const base = {
      submissionId: 'submit_client_123',
      description: 'The board froze.',
      screenshotDataUrl: null,
      captureError: null,
    };
    expect(buildBugReportInput(base).kind).toBe('bug');
    expect(buildBugReportInput({ ...base, kind: 'bug' }).kind).toBe('bug');
    expect(buildBugReportInput({ ...base, kind: 'abuse' }).kind).toBe('abuse');
  });

  it('retries screenshot capture with Safari-safe media filtering after a full capture failure', async () => {
    const root = document.createElement('main');
    root.className = 'app';
    root.innerHTML = `
      <section>
        <p data-kind="content">Feed content</p>
        <video data-kind="video" src="/clip.mp4"></video>
        <audio data-kind="audio" src="/clip.webm"></audio>
        <iframe data-kind="frame" src="/frame.html"></iframe>
        <canvas data-kind="canvas"></canvas>
        <img data-kind="remote-image" src="https://firebasestorage.googleapis.com/proof.png" />
        <img data-kind="same-origin-image" src="${window.location.origin}/proof.png" />
        <button data-kind="report-ui" data-bug-report-ui>Report a bug</button>
      </section>
    `;
    document.body.append(root);
    const compatBlob = new Blob(['png'], { type: 'image/png' });
    toBlobSpy.mockRejectedValueOnce(new Error('Safari cannot render this surface'));
    toBlobSpy.mockResolvedValueOnce(compatBlob);

    await expect(captureAppSurface()).resolves.toBe(compatBlob);

    expect(toBlobSpy).toHaveBeenCalledTimes(2);
    expect(toBlobSpy).toHaveBeenNthCalledWith(1, root, expect.objectContaining({
      cacheBust: true,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      skipFonts: false,
      // #290: the clone must not inherit `.app`'s computed auto-margins —
      // at desktop widths they shift the capture right and clip it.
      style: { margin: '0' },
    }));
    expect(toBlobSpy).toHaveBeenNthCalledWith(2, root, expect.objectContaining({
      cacheBust: true,
      pixelRatio: 1,
      skipFonts: true,
      style: { margin: '0' },
    }));
    const compatFilter = toBlobSpy.mock.calls[1][1].filter as (node: HTMLElement) => boolean;
    expect(compatFilter(root.querySelector('[data-kind="content"]') as HTMLElement)).toBe(true);
    expect(compatFilter(root.querySelector('[data-kind="same-origin-image"]') as HTMLElement)).toBe(true);
    expect(compatFilter(root.querySelector('[data-kind="remote-image"]') as HTMLElement)).toBe(false);
    expect(compatFilter(root.querySelector('[data-kind="video"]') as HTMLElement)).toBe(false);
    expect(compatFilter(root.querySelector('[data-kind="audio"]') as HTMLElement)).toBe(false);
    expect(compatFilter(root.querySelector('[data-kind="frame"]') as HTMLElement)).toBe(false);
    expect(compatFilter(root.querySelector('[data-kind="canvas"]') as HTMLElement)).toBe(false);
    expect(compatFilter(root.querySelector('[data-kind="report-ui"]') as HTMLElement)).toBe(false);
  });

  it('lowers the capture pixel ratio so a long page fits the server PNG dimension caps (#361)', async () => {
    const root = document.createElement('main');
    root.className = 'app';
    // 640 CSS px wide, 6000 tall: at DPR 2 the full-mode render would be
    // 12000 px tall — past the contract's 8192 px cap — while ratio 1 fits.
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 640 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 6000 });
    document.body.append(root);
    vi.stubGlobal('devicePixelRatio', 2);
    const blob = new Blob(['png'], { type: 'image/png' });
    toBlobSpy.mockRejectedValueOnce(new Error('force the compat retry'));
    toBlobSpy.mockResolvedValueOnce(blob);

    await expect(captureAppSurface()).resolves.toBe(blob);

    const fullRatio = (toBlobSpy.mock.calls[0][1] as { pixelRatio: number }).pixelRatio;
    expect(fullRatio).toBe(planCaptureScale(640, 6000, 2).pixelRatio);
    expect(fullRatio).toBeLessThan(2);
    expect(Math.trunc(6000 * fullRatio)).toBeLessThanOrEqual(BUG_REPORT_SCREENSHOT_MAX_DIMENSION);
    // The compat pass prefers ratio 1, which already fits — stays unscaled.
    expect((toBlobSpy.mock.calls[1][1] as { pixelRatio: number }).pixelRatio).toBe(1);
  });

  it('falls back to a viewport canvas capture when both html-to-image paths fail on desktop', async () => {
    const root = document.createElement('main');
    root.className = 'app';
    Object.defineProperty(root, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 960, height: 2400, top: 0, left: 0, right: 960, bottom: 2400 }),
    });
    root.innerHTML = `
      <section>
        <p data-kind="content">Feed content</p>
        <video data-kind="video" src="/clip.mp4"></video>
        <img data-kind="remote-image" src="https://firebasestorage.googleapis.com/proof.png" />
        <button data-kind="report-ui" data-bug-report-ui>Report a bug</button>
      </section>
    `;
    document.body.append(root);
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 600);
    const fallbackBlob = new Blob(['png'], { type: 'image/png' });
    const fallbackCanvas = {
      toBlob: (callback: BlobCallback) => callback(fallbackBlob),
    } as HTMLCanvasElement;
    toBlobSpy.mockRejectedValue(new Error('foreignObject failed'));
    html2canvasSpy.mockResolvedValue(fallbackCanvas);

    await expect(captureAppSurface()).resolves.toBe(fallbackBlob);

    expect(toBlobSpy).toHaveBeenCalledTimes(2);
    expect(html2canvasSpy).toHaveBeenCalledWith(root, expect.objectContaining({
      allowTaint: false,
      foreignObjectRendering: false,
      height: 600,
      scale: 1,
      useCORS: true,
      width: 800,
      windowHeight: 600,
      windowWidth: 800,
      x: 0,
      y: 0,
    }));
    const ignoreElements = html2canvasSpy.mock.calls[0][1].ignoreElements as (element: Element) => boolean;
    expect(ignoreElements(root.querySelector('[data-kind="content"]') as HTMLElement)).toBe(false);
    expect(ignoreElements(root.querySelector('[data-kind="remote-image"]') as HTMLElement)).toBe(true);
    expect(ignoreElements(root.querySelector('[data-kind="video"]') as HTMLElement)).toBe(true);
    expect(ignoreElements(root.querySelector('[data-kind="report-ui"]') as HTMLElement)).toBe(true);
  });

  it('excludes the fixed bottom tab bar from every capture path so it never floats mid-screenshot (report GwT3bmAqwu2eKeQF1uOf)', async () => {
    // html-to-image paints the whole scrollable `.app` into a foreignObject
    // sized to the full box, where `position: fixed` no longer tracks the
    // visible viewport — so an included `.tabs` bar renders floating mid-capture
    // and reads as "not pinned to the bottom". The bar is app chrome, not the
    // report's subject, so it is dropped from the capture (full, compat, and the
    // html2canvas fallback) rather than the live bar being moved during a render.
    const root = document.createElement('main');
    root.className = 'app';
    root.innerHTML = `
      <section><p data-kind="content">Feed content</p></section>
      <nav class="tabs">
        <a data-kind="tab" href="/">Card</a>
        <a data-kind="tab-more" href="/more">More</a>
      </nav>
    `;
    Object.defineProperty(root, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 800, height: 2400, top: 0, left: 0, right: 800, bottom: 2400 }),
    });
    document.body.append(root);
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 600);
    const fallbackBlob = new Blob(['png'], { type: 'image/png' });
    // Force all three paths to run so we can assert every filter drops the bar.
    toBlobSpy.mockRejectedValue(new Error('foreignObject failed'));
    html2canvasSpy.mockResolvedValue({
      toBlob: (cb: BlobCallback) => cb(fallbackBlob),
    } as HTMLCanvasElement);

    await expect(captureAppSurface()).resolves.toBe(fallbackBlob);

    const nav = root.querySelector('nav.tabs') as HTMLElement;
    const tabLink = root.querySelector('[data-kind="tab"]') as HTMLElement;
    const content = root.querySelector('[data-kind="content"]') as HTMLElement;

    // Full pass (call 0) and compat pass (call 1): the html-to-image `filter`
    // returns false for the bar and its descendants, true for page content.
    for (const call of toBlobSpy.mock.calls) {
      const filter = call[1].filter as (node: HTMLElement) => boolean;
      expect(filter(nav)).toBe(false);
      expect(filter(tabLink)).toBe(false);
      expect(filter(content)).toBe(true);
    }
    // Canvas fallback: `ignoreElements` returns true for the bar, false for content.
    const ignoreElements = html2canvasSpy.mock.calls[0][1].ignoreElements as (element: Element) => boolean;
    expect(ignoreElements(nav)).toBe(true);
    expect(ignoreElements(tabLink)).toBe(true);
    expect(ignoreElements(content)).toBe(false);
  });

  it('crops the desktop canvas fallback to the visible scrolled viewport', async () => {
    const root = document.createElement('main');
    root.className = 'app';
    Object.defineProperty(root, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 960, height: 2400, top: -700, left: -40, right: 920, bottom: 1700 }),
    });
    root.textContent = 'Scrolled feed content';
    document.body.append(root);
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 600);
    vi.stubGlobal('scrollX', 40);
    vi.stubGlobal('scrollY', 700);
    const fallbackBlob = new Blob(['png'], { type: 'image/png' });
    const fallbackCanvas = {
      toBlob: (callback: BlobCallback) => callback(fallbackBlob),
    } as HTMLCanvasElement;
    toBlobSpy.mockRejectedValue(new Error('foreignObject failed'));
    html2canvasSpy.mockResolvedValue(fallbackCanvas);

    await expect(captureAppSurface()).resolves.toBe(fallbackBlob);

    expect(html2canvasSpy).toHaveBeenCalledWith(root, expect.objectContaining({
      height: 600,
      scrollX: 40,
      scrollY: 700,
      width: 800,
      x: 40,
      y: 700,
    }));
  });
});
