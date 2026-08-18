import { httpsCallable } from 'firebase/functions';
import { toBlob } from 'html-to-image';
import { EVENT_ID, functions } from '../firebase';
import { planCaptureScale } from './screenshotFit';

export const BUG_REPORT_SCHEMA_VERSION = 1 as const;
export const BUG_REPORT_DESCRIPTION_MAX = 4000;
export const BUG_REPORT_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What the reporter says this is. A deliberate RESTATEMENT of the server's
 * `REPORT_KINDS` (`functions/src/bugReportContract.cjs`) rather than an import:
 * `functions/` is a separately-rooted project whose modules pull `firebase-admin`
 * and `resend`, so importing the contract here would drag the Functions tree into
 * the browser bundle. `src/data/w4-bug-report-contract-parity.test.ts` is what
 * keeps the two honest — it asserts this list and the server's are the same list,
 * and that a payload this module builds validates on the server unchanged.
 */
export const BUG_REPORT_KINDS = ['bug', 'abuse'] as const;
export type BugReportKind = (typeof BUG_REPORT_KINDS)[number];

export interface BugReportViewport {
  width: number;
  height: number;
}

export interface SubmitBugReportInput {
  schemaVersion: typeof BUG_REPORT_SCHEMA_VERSION;
  kind: BugReportKind;
  description: string;
  screenshotDataUrl: string | null;
  captureError: string | null;
  route: string;
  eventId: string;
  appVersion: string;
  browser: string;
  viewport: BugReportViewport;
  online: boolean;
}

export interface SubmitBugReportResult {
  reportId: string;
  /** Whether this submission MET THE CONDITIONS to be escalated to the Event's
   *  admins. Only ever true for an `abuse` report, and only when the server
   *  confirmed both that the reporter belongs to the Event and that the Event is
   *  live — facts the client cannot know, which is why the sheet reports what
   *  the server decided rather than promising anything up front (#670).
   *
   *  ELIGIBILITY, not delivery, and not even "an alert was queued": the callable
   *  returns before the asynchronous trigger has run, that trigger re-checks
   *  Event status itself, and the digest beyond it may resolve no admin
   *  recipient at all. Optional so an older deployed callable degrades to "no
   *  claim made" rather than to a false one. */
  escalationEligible?: boolean;
}

const TRANSPARENT_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

type CaptureMode = 'full' | 'compat' | 'canvas';

function isSafeImageForCompatCapture(node: HTMLImageElement): boolean {
  const source = node.currentSrc || node.src;
  if (!source) return true;
  try {
    const url = new URL(source, window.location.href);
    return url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function excludedFromCapture(node: HTMLElement, mode: CaptureMode): boolean {
  if (node.closest('[data-bug-report-ui]')) return true;
  // The bottom tab bar is `position: fixed`. html-to-image paints the whole
  // scrollable `.app` into an SVG `<foreignObject>` sized to the full box, where
  // fixed positioning no longer tracks the visible viewport — so an included bar
  // renders floating mid-capture over the below-the-fold content and reads as
  // "the toolbar is not pinned to the bottom" (report GwT3bmAqwu2eKeQF1uOf),
  // even though it is correctly pinned in the live app. It is app chrome, not
  // the report's subject, so omit it from every capture path rather than move
  // the live bar during a render (which would displace it on-screen mid-capture,
  // notably in pick mode where the tab bar stays usable). The live bar is
  // untouched; the screenshot is just the page the reporter is describing.
  if (node.closest('nav.tabs')) return true;
  if (mode === 'full') return false;
  if (node.closest('video, audio, iframe, canvas, object, embed')) return true;
  if (node instanceof HTMLImageElement && !isSafeImageForCompatCapture(node)) return true;
  return false;
}

/**
 * Measure the surface exactly the way html-to-image's `getImageSize` does
 * (clientWidth/Height plus border widths), so the pixel-ratio plan is solved
 * against the same CSS size the renderer multiplies by `pixelRatio` when it
 * sizes its canvas.
 */
function captureSurfaceSize(node: HTMLElement): { width: number; height: number } {
  const style = window.getComputedStyle(node);
  const edge = (value: string) => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    width: node.clientWidth + edge(style.borderLeftWidth) + edge(style.borderRightWidth),
    height: node.clientHeight + edge(style.borderTopWidth) + edge(style.borderBottomWidth),
  };
}

async function captureWithMode(root: HTMLElement, mode: CaptureMode): Promise<Blob> {
  const preferredRatio = mode === 'full' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const surface = captureSurfaceSize(root);
  // Long pages render taller than the server's PNG dimension caps allow;
  // lowering the pixel ratio up front keeps the capture submittable (#361)
  // and renders text directly at the final scale instead of resampling.
  const { pixelRatio } = planCaptureScale(surface.width, surface.height, preferredRatio);
  const blob = await toBlob(root, {
    cacheBust: true,
    imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
    pixelRatio,
    skipFonts: mode === 'compat',
    filter: (node) => !(node instanceof HTMLElement) || !excludedFromCapture(node, mode),
    // html-to-image inlines COMPUTED styles into its clone, so `.app`'s
    // `margin: 0 auto` arrives as a concrete pixel margin (~(viewport-640)/2 —
    // ~487px at a 1615px desktop window) inside a canvas sized to the node's
    // 640px box: the whole capture shifts right by the live left gutter and
    // clips (#290). Zero it on the clone; the canvas is the node's own box,
    // so centering is meaningless there anyway.
    style: { margin: '0' },
  });
  if (!blob) throw new Error('Screenshot capture returned no image');
  if (blob.size > BUG_REPORT_SCREENSHOT_MAX_BYTES) throw new Error('Screenshot is too large');
  return blob;
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Screenshot capture returned no image'));
    }, 'image/png');
  });
}

async function captureWithCanvas(root: HTMLElement): Promise<Blob> {
  const rect = root.getBoundingClientRect();
  const rootWidth = Math.max(1, Math.ceil(rect.width || window.innerWidth));
  const rootHeight = Math.max(1, Math.ceil(rect.height || window.innerHeight));
  const width = Math.max(1, Math.min(rootWidth, window.innerWidth));
  const height = Math.max(1, Math.min(rootHeight, window.innerHeight));
  const x = Math.max(0, Math.min(Math.round(-rect.left), Math.max(0, rootWidth - width)));
  const y = Math.max(0, Math.min(Math.round(-rect.top), Math.max(0, rootHeight - height)));
  // Viewport-cropped, so the caps rarely bind here — but solve the same plan
  // as the html-to-image paths so no mode can exceed the server contract.
  const { pixelRatio: scale } = planCaptureScale(width, height, 1);
  const { default: html2canvas } = await import('html2canvas');
  const canvas = await html2canvas(root, {
    allowTaint: false,
    backgroundColor: null,
    foreignObjectRendering: false,
    height,
    imageTimeout: 1500,
    ignoreElements: (element) => element instanceof HTMLElement && excludedFromCapture(element, 'canvas'),
    logging: false,
    scale,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    useCORS: true,
    width,
    windowHeight: window.innerHeight,
    windowWidth: window.innerWidth,
    x,
    y,
  });
  const blob = await canvasToPngBlob(canvas);
  if (blob.size > BUG_REPORT_SCREENSHOT_MAX_BYTES) throw new Error('Screenshot is too large');
  return blob;
}

/** Capture only the app surface—never browser chrome, other tabs, or apps. */
export async function captureAppSurface(): Promise<Blob> {
  const root = document.querySelector<HTMLElement>('.app');
  if (!root) throw new Error('App surface unavailable');
  try {
    return await captureWithMode(root, 'full');
  } catch (error) {
    try {
      return await captureWithMode(root, 'compat');
    } catch {
      try {
        return await captureWithCanvas(root);
      } catch {
        if (error instanceof Error) throw error;
        throw new Error('Screenshot capture failed');
      }
    }
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Screenshot encoding failed'));
    reader.onerror = () => reject(new Error('Screenshot encoding failed'));
    reader.readAsDataURL(blob);
  });
}

export function buildBugReportInput(args: {
  description: string;
  screenshotDataUrl: string | null;
  captureError: string | null;
  /** What the reporter marked this as. Defaults to `'bug'` — the same default
   * the server normalises an absent field to, so a caller that has no opinion
   * produces the payload an already-shipped client would have sent (#670). */
  kind?: BugReportKind;
  /** Pathname the attached screenshot was captured on. Pick mode (#324) can
   * capture a different screen than the one the sheet is submitted from, so
   * the caller passes the capture-time path; absent, the current one. */
  route?: string;
}): SubmitBugReportInput {
  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    kind: args.kind ?? 'bug',
    description: args.description.trim(),
    screenshotDataUrl: args.screenshotDataUrl,
    captureError: args.captureError,
    // Query strings can carry invite codes or other secrets. The path is
    // sufficient to identify the affected screen without exporting them.
    route: (args.route ?? window.location.pathname).slice(0, 200),
    eventId: EVENT_ID,
    appVersion: __APP_VERSION__,
    browser: navigator.userAgent.slice(0, 500),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    online: navigator.onLine,
  };
}

export async function submitBugReport(input: SubmitBugReportInput): Promise<SubmitBugReportResult> {
  const submitCallable = httpsCallable<SubmitBugReportInput, SubmitBugReportResult>(functions, 'submitBugReport');
  const result = await submitCallable(input);
  return result.data;
}
