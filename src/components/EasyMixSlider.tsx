import { useEffect, useRef, useState } from 'react';

/** The 24 non-free Squares of a Day Card — the denominator of the slider's
 *  ratio-to-squares translation (`dealBoard` deals 24 + the free centre). */
const CARD_SQUARES = 24;
/** The slider's keyboard/grid step, in percent (specs/admin-console-ia.md). */
const EASY_MIX_STEP = 5;
/** The detent stops the wireframe calls out under the track. */
const EASY_MIX_DETENTS = [0, 25, 50, 75, 100];

/** "50% · 12 of 24 squares" — the bubble AND `aria-valuetext` phrasing. */
function squaresPhrase(pct: number): string {
  return `${pct}% · ${Math.round((CARD_SQUARES * pct) / 100)} of ${CARD_SQUARES} squares`;
}

/** Snap a stored 0..1 ratio onto the slider's 5% grid, clamped to 0..100. */
function snapPct(ratio: number): number {
  return Math.min(100, Math.max(0, Math.round((ratio * 100) / EASY_MIX_STEP) * EASY_MIX_STEP));
}

/**
 * The "Easy mix" dial (specs/admin-console-ia.md § "Easy mix slider", writing the
 * `specs/easy-mix.md` setting): a full 0–100% range slider in 5% steps with
 * detents at 0/25/50/75/100 and a value bubble translating the ratio to squares
 * ("50% · 12 of 24 squares" — also the `aria-valuetext`). Local state gives the
 * thumb optimistic, lag-free motion during a drag (a controlled input bound
 * directly to the async Firestore value would stick), and the value is COMMITTED
 * once on release (pointer/key up, plus blur for assistive-tech value changes
 * that fire neither) — so one adjustment is one `settings.easyMixRatio` write.
 * Re-syncs to the event doc whenever the committed value changes elsewhere
 * (another admin, or first load). A stored off-grid ratio is normalized to the
 * 5% grid for display — the native range coerces off-grid DOM values itself, so
 * the label must agree with the thumb — and the dedup ref syncs to the SNAPPED
 * value, so an untouched release never rewrites the stored setting.
 */
export function EasyMixSlider({ value, onChange }: { value: number; onChange: (ratio: number) => void }) {
  // The input is deliberately UNCONTROLLED: the browser owns the thumb during
  // interaction. A controlled `value={pct}` loses keystrokes under load — any
  // interleaved re-render (this surface re-renders on every event-doc echo of
  // the OTHER settings writes) snaps the DOM value back to the last committed
  // React state mid-keystroke, eating arrow presses (caught by the e2e
  // keyboard walk). `pct` state drives only the bubble/aria text.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pct, setPct] = useState(snapPct(value));
  // Dedup against the LAST REQUESTED ratio, not the `value` prop: `onChange`
  // writes Firestore asynchronously, so `value` stays stale until the write
  // round-trips — a second release at the same position would otherwise write
  // the same ratio again.
  const lastCommitted = useRef(snapPct(value) / 100);
  useEffect(() => {
    // Never re-sync while the admin is MID-ADJUSTMENT (input focused): with
    // several commits in flight — a rapid keyboard walk writes once per keyup
    // — the echo of write N−1 differs from the LAST requested ratio, so an
    // equality check alone misreads it as external and yanks the thumb back
    // mid-sequence (caught by the e2e keyboard walk). Echoes settle to the
    // final write once the interaction ends.
    if (inputRef.current && document.activeElement === inputRef.current) return;
    const snapped = snapPct(value);
    // Our OWN write echoing back off the subscription must not touch the
    // thumb either — only an EXTERNAL change (another admin, or a first load
    // with a different value) re-syncs the input and bubble.
    if (snapped / 100 === lastCommitted.current) return;
    lastCommitted.current = snapped / 100;
    setPct(snapped);
    if (inputRef.current) inputRef.current.value = String(snapped);
  }, [value]);
  // True when a write was actually requested — blur uses it to decide whether
  // a focus-skipped EXTERNAL update should now win.
  const commit = (next: number): boolean => {
    const ratio = next / 100;
    if (ratio === lastCommitted.current) return false;
    lastCommitted.current = ratio;
    onChange(ratio);
    return true;
  };
  // Blur ends the interaction: commit the thumb (the AT path), and if that was
  // a no-op, apply any external change the focus guard skipped — otherwise the
  // thumb would stay stale until remount (Codex P2, PR #410). When the commit
  // DID write, the user's own adjustment wins and its echo settles the state.
  const onBlurCommit = (next: number) => {
    if (commit(next)) return;
    const snapped = snapPct(value);
    if (snapped / 100 === lastCommitted.current) return;
    lastCommitted.current = snapped / 100;
    setPct(snapped);
    if (inputRef.current) inputRef.current.value = String(snapped);
  };
  return (
    <div className="easymix">
      <div className="easymix-bubble" aria-hidden="true">
        {squaresPhrase(pct)}
      </div>
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={100}
        step={EASY_MIX_STEP}
        defaultValue={pct}
        list="easymix-detents"
        aria-label="Easy mix percentage"
        aria-valuetext={squaresPhrase(pct)}
        onChange={(e) => setPct(Number(e.target.value))}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onBlur={(e) => onBlurCommit(Number((e.target as HTMLInputElement).value))}
      />
      <datalist id="easymix-detents">
        {EASY_MIX_DETENTS.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <div className="easymix-detent-labels" aria-hidden="true">
        {EASY_MIX_DETENTS.map((v) => (
          <span key={v}>{v}%</span>
        ))}
      </div>
    </div>
  );
}
