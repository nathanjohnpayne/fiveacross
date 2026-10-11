// Device recovery document styles (#1886). The recovery document loads
// instead of the application graph, so it carries its own stylesheet. Tokens
// mirror the `fiveacross-slate` platform-chrome Theme in src/theme/themes.css
// plus the app's `--danger` fallback; the canonical frames live in
// plans/daily-cards-wireframes.html § Device recovery.
export const RECOVERY_STYLE_ID = 'device-cache-recovery-style';

export const RECOVERY_CSS = `
.rec-page {
  --bg: #0f1116;
  --panel: #161a22;
  --ink: #f2f4f8;
  --dim: #9aa3b2;
  --primary: #718ef4;
  --secondary: #647be2;
  --accent: #f5b840;
  --border: rgba(96, 130, 255, 0.32);
  --shadow: rgba(113, 142, 244, 0.4);
  --danger: #ff6b7a;
  --on-fill: #000;
  --radius: 12px;
  --radius-card: 16px;
  --radius-pill: 40px;
  --ease-glide: cubic-bezier(0.22, 1, 0.36, 1);
  color-scheme: dark; /* native checkboxes render on dark, not UA-light */
  container-type: inline-size; /* the two @container breakpoints below key off this */
  margin: 0;
  min-height: 100vh;
  min-height: 100dvh;
  background:
    radial-gradient(60% 40% at 10% -10%, color-mix(in srgb, var(--primary) 22%, transparent), transparent 60%),
    var(--bg);
  color: var(--ink);
  font: 15px/1.5 'Oswald', 'Helvetica Neue', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}
.rec-page *,
.rec-page *::before,
.rec-page *::after { box-sizing: border-box; }

.rec {
  max-width: 560px;
  margin: 0 auto;
  padding: 28px 16px 56px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
@container (min-width: 600px) {
  .rec { padding: 56px 24px 72px; gap: 20px; }
}

/* ---- header ---- */
.rec-head { display: flex; flex-direction: column; gap: 10px; }
.rec-title {
  margin: 0;
  font-size: 26px;
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.rec-lede { margin: 0; }
.rec-steps-title {
  margin: 6px 0 0;
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dim);
  font-weight: 600;
}
.rec-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: rec-step;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
  line-height: 1.45;
}
.rec-steps li { position: relative; padding-left: 34px; counter-increment: rec-step; }
.rec-steps li::before {
  content: counter(rec-step);
  position: absolute;
  left: 0;
  top: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1.5px solid var(--border);
  color: var(--dim);
  font-size: 12px;
  font-weight: 700;
  display: grid;
  place-items: center;
}
.rec-note { margin: 0; font-size: 13px; color: var(--dim); }

/* ---- confirmation card ---- */
.rec-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 16px;
}
.rec-card-title {
  margin: 0 0 10px;
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dim);
  font-weight: 600;
}

/* ---- checklist rows (real <label> wraps the input; the row is the target) ---- */
.rec-checklist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.rec-check {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-height: 48px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  cursor: pointer;
  font-size: 14px;
  line-height: 1.4;
  -webkit-tap-highlight-color: transparent;
  transition: border-color 0.18s ease, background-color 0.18s ease;
}
.rec-check:hover { border-color: var(--primary); }
.rec-check:has(.rec-check-input:checked) {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, var(--bg));
}
.rec-check:has(.rec-check-input:focus-visible) {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.rec-check:has(.rec-check-input:disabled) {
  cursor: not-allowed;
  opacity: 0.6;
}
.rec-check-input {
  flex: none;
  width: 22px;
  height: 22px;
  margin: -1px 0 0;
  accent-color: var(--primary);
  cursor: inherit;
}
.rec-check-input:focus-visible { outline: none; } /* the row draws the ring */
.rec-check-text { flex: 1; min-width: 0; }
/* danger register for the unverified-path acknowledgements */
.rec-check--danger:hover,
.rec-check--danger:has(.rec-check-input:checked) { border-color: var(--danger); }
.rec-check--danger:has(.rec-check-input:checked) { background: color-mix(in srgb, var(--danger) 10%, var(--bg)); }
.rec-check--danger:has(.rec-check-input:focus-visible) { outline-color: var(--danger); }
.rec-check--danger .rec-check-input { accent-color: var(--danger); }

/* ---- actions ---- */
.rec-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}
@container (min-width: 600px) {
  .rec-actions { flex-direction: row; }
  .rec-actions .rec-btn { flex: 1; }
}
.rec-btn {
  appearance: none;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  min-height: 44px;
  padding: 11px 18px;
  border-radius: var(--radius-pill);
  border: 1.5px solid var(--secondary);
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  color: var(--ink);
  cursor: pointer;
  touch-action: manipulation;
  transition: transform 0.12s var(--ease-glide), filter 0.15s ease, box-shadow 0.2s ease;
}
.rec-btn:not(:disabled):hover { filter: brightness(1.08); }
.rec-btn:not(:disabled):active { transform: scale(0.96); }
.rec-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.rec-btn--primary {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--on-fill);
  box-shadow: 0 0 14px var(--shadow);
}
.rec-btn--danger {
  background: var(--danger);
  border-color: var(--danger);
  color: var(--on-fill);
}
.rec-btn--danger:focus-visible { outline-color: var(--danger); }
.rec-btn--block { width: 100%; }
.rec-btn:disabled {
  background: color-mix(in srgb, var(--panel) 60%, var(--bg));
  border-color: var(--border);
  color: var(--dim);
  box-shadow: none;
  cursor: not-allowed;
}
.rec-btn[hidden] { display: none; }

/* ---- status (role="status") ---- */
.rec-status {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--panel);
  font-size: 14px;
  line-height: 1.45;
}
.rec-status:empty { display: none; }
.rec-status--wait {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--panel));
}
.rec-dots { display: inline-flex; gap: 6px; align-items: center; height: 20px; flex: none; }
.rec-dots i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 8px var(--shadow);
  animation: rec-pulse 1s ease-in-out infinite;
}
.rec-dots i:nth-child(2) { animation-delay: 0.15s; }
.rec-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes rec-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.75); }
  50% { opacity: 1; transform: scale(1.15); }
}

/* ---- failure callout (role="alert") ---- */
.rec-alert {
  margin: 0;
  padding: 14px 16px;
  border-radius: var(--radius);
  border: 1.5px solid var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, var(--panel));
  font-size: 14px;
  line-height: 1.45;
}
.rec-alert:empty { display: none; }
.rec-alert-title {
  display: block;
  font-weight: 700;
  color: var(--danger);
  margin: 0 0 4px;
}
.rec-alert p { margin: 0; }
.rec-alert p + p { margin-top: 6px; }

/* ---- escape hatch (<details>) ---- */
.rec-hatch {
  border: 1px dashed var(--danger);
  border-radius: var(--radius-card);
  background: var(--panel);
}
.rec-hatch > summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 13px 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  border-radius: var(--radius-card);
  -webkit-tap-highlight-color: transparent;
}
.rec-hatch > summary::-webkit-details-marker { display: none; }
.rec-hatch > summary::after {
  content: '';
  flex: none;
  width: 9px;
  height: 9px;
  margin: -4px 6px 0 0;
  border-right: 2px solid var(--dim);
  border-bottom: 2px solid var(--dim);
  transform: rotate(45deg);
  transition: transform 0.18s ease;
}
.rec-hatch[open] > summary::after { transform: rotate(-135deg); margin-top: 4px; }
.rec-hatch > summary:focus-visible { outline: 2px solid var(--danger); outline-offset: -2px; }
.rec-hatch-body {
  padding: 2px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rec-hatch-title { margin: 0; font-size: 18px; line-height: 1.2; font-weight: 700; }
.rec-warn {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px dashed var(--danger);
  background: var(--bg);
  font-size: 14px;
  line-height: 1.45;
}
.rec-warn b { color: var(--danger); }
.rec-hatch .rec-actions { margin-top: 2px; }

@media (prefers-reduced-motion: reduce) {
  .rec-dots i { animation: none; opacity: 0.8; }
  .rec-btn, .rec-check, .rec-hatch > summary::after { transition: none; }
}
`;
