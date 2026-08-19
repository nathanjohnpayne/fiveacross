/**
 * The application entry point (#549, Phase 4b P1).
 *
 * Deliberately tiny, and deliberately the ONLY thing `index.html` loads. Its
 * whole job is to get the handoff code out of the URL before anything capable
 * of reading a URL exists.
 *
 * The import list below is the security property. ES modules evaluate their
 * static imports before their own body, so any static import of the app here
 * would load `firebase.ts` — and with it GA4 — while `#fa_handoff=<code>` was
 * still in `window.location`. `handoffBoot` and its one dependency are free of
 * Firebase, analytics, and React precisely so that this file can run first with
 * nothing else awake.
 *
 * The application is therefore reached through a DYNAMIC import, which is
 * evaluated only when this line runs — after the capture. Do not convert it to
 * a static import, and do not add a static import of anything from `src/` other
 * than the boot seam: either would reintroduce the leak this file exists to
 * close.
 */
import { captureHandoffFromUrl } from './handoffBoot';

captureHandoffFromUrl();

/**
 * A rejection here is unrecoverable for THIS page load and has to say so
 * (Phase 4b P2). By the time this runs the code has already left the URL and
 * exists only in this module's memory, so if the main chunk fails to download
 * or evaluate, a reload cannot get it back — the player would otherwise sit on
 * the static loading screen forever with no hint that anything went wrong.
 *
 * The message is written with raw DOM rather than React, because React lives in
 * the chunk that just failed to load. It is deliberately the only thing this
 * file knows how to render.
 */
void import('./main').catch(() => {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';
  const wrap = document.createElement('main');
  wrap.setAttribute('role', 'alert');
  wrap.style.cssText =
    'min-height:100dvh;display:grid;place-items:center;padding:2rem 1.5rem;background:#0b0f14;color:#eef2f6;font-family:system-ui,-apple-system,sans-serif;text-align:center';
  const inner = document.createElement('div');
  inner.style.maxWidth = '32rem';
  const h = document.createElement('h1');
  h.style.cssText = 'font-size:1.5rem;line-height:1.25;margin:0 0 0.75rem';
  h.textContent = "This didn't load";
  const p = document.createElement('p');
  p.style.cssText = 'margin:0;line-height:1.55;color:#a9b7c4';
  p.textContent =
    'Something went wrong loading the app. Check your connection and reload the page, then tap Sign in again.';
  inner.append(h, p);
  wrap.append(inner);
  root.append(wrap);
});
