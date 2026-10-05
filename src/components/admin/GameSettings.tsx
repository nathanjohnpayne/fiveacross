import { useEffect, useRef, useState } from 'react';
import { EasyMixSlider } from '../EasyMixSlider';
import {
  setClaimMode,
  setEventTheme,
  setPhotoProofSource,
  setStripPhotoExif,
  setVisionGate,
  setReportHideThreshold,
  setEasyMixRatio,
  setForceAdult,
} from '../../data/admin';
import ArchiveEvent from './ArchiveEvent';
import { themesForEditionIncluding } from '../../theme/themes';
import { useAdultContent } from '../../hooks/useAdultContent';
import { useAdultContentFlipConfirm } from './AdultContentConfirm';
import type { ClaimDoc, ClaimMode, EventDoc } from '../../types';

// A −/+ stepper for `settings.reportHideThreshold` (#222), floored at 1 on
// EVERY step (not just decrement) — `isReportHidden` treats a non-positive
// threshold as "no filtering" (Codex P2, PR #107 finding 2), so a legacy
// Event doc with an already-negative threshold must not be able to click +
// its way to another non-positive value (Codex P2, PR #245 finding).
function ReportThresholdStepper({ value, onChange, busy }: { value: number; onChange: (n: number) => void; busy: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        className="iconbtn"
        aria-label="Decrease auto-hide threshold"
        disabled={busy || value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
      >
        −
      </button>
      <span style={{ minWidth: 20, textAlign: 'center' }}>{value}</span>
      <button className="iconbtn" aria-label="Increase auto-hide threshold" disabled={busy} onClick={() => onChange(Math.max(1, value + 1))}>
        +
      </button>
    </div>
  );
}

const SETTING_LABELS = {
  claimMode: 'Claim mode', photoSource: 'Photo proof source', stripExif: 'Location data',
  visionGate: 'AI image screen', forceAdult: 'Adults-only setting', threshold: 'Auto-hide threshold', theme: 'Default theme',
} as const;
type SettingKey = keyof typeof SETTING_LABELS;

/** Local feedback owns only the attempted write; displayed values stay on the
 * committed Event listener. Unmount retires late feedback with its Admin scope. */
function useSettingFeedback() {
  const active = useRef(true);
  const pending = useRef(new Set<SettingKey>());
  const [busy, setBusy] = useState<ReadonlySet<SettingKey>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({});
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (key: SettingKey, action: () => Promise<unknown>) => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setBusy(new Set(pending.current));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
    try { await action(); }
    catch {
      if (active.current) setErrors((previous) => ({ ...previous, [key]: `${SETTING_LABELS[key]} save failed. Try again.` }));
    } finally {
      pending.current.delete(key);
      if (active.current) setBusy(new Set(pending.current));
    }
  };
  const error = (key: SettingKey) => errors[key] ? <div className="error" role="alert">{errors[key]}</div> : null;
  return { run, busy, error };
}

/**
 * Game settings (specs/admin-console-ia.md § "Game settings"): every event dial
 * in one place — the Easy mix slider, the Claims & proof knobs (claim mode,
 * photo source, EXIF strip, AI screen, auto-hide threshold — #222, recaptioned
 * ADR 0001 verbatim), and Appearance › default theme. Every control keeps its
 * exact `data/admin` write path and catches save failures inline (#1678); the
 * 18+ dialog owns failures while its action is deferred. AI image screen stays a live
 * setting (#268): a deployed scanner consults it per upload — the deploy-time
 * env flag remains the master kill-switch for whether the scanner exists at all.
 */
export default function GameSettings({
  event,
  eventConfirmed,
  pendingClaims,
  pendingClaimsLoaded,
}: {
  event: EventDoc | null | undefined;
  /** Threaded straight through to `ArchiveEvent`, whose arming gate (#1151)
   *  needs to know the Event it previews came from the SERVER and not the
   *  ADR 0006 persistent cache. */
  eventConfirmed: boolean;
  /** Threaded straight through to `ArchiveEvent`, whose drain gate (#1151) needs
   *  the console's already-subscribed claim queue rather than a second listener:
   *  a gate that disagreed with the Review queue it points at would name a fix
   *  the Admin cannot perform. */
  pendingClaims: readonly ClaimDoc[];
  pendingClaimsLoaded: boolean;
}) {
  const { run, busy, error } = useSettingFeedback();
  const modes: ClaimMode[] = ['honor', 'proof_required', 'admin_confirmed'];
  const modeLabel: Record<ClaimMode, string> = { honor: 'Honor', proof_required: 'Proof-to-mark', admin_confirmed: 'Admin-confirmed' };
  const photoSource = event?.settings?.photoProofSource ?? 'camera_or_library';
  const stripExif = event?.settings?.stripPhotoExif ?? true;
  const visionGate = event?.settings?.visionGate ?? true;
  const threshold = event?.settings?.reportHideThreshold ?? 4;
  // Easy mix (specs/easy-mix.md): default 0.5 mirrors the deal-time call-site default.
  const easyMix = event?.settings?.easyMixRatio ?? 0.5;
  // The 18+ override (#608) and its confirm (#610). `adultContentRequired()` is
  // the RESOLVED posture — what players actually see — while `forceAdult` is
  // only this Event's manual reason for it, so the row can honestly say when
  // the Event is already 18+ from its pool and the switch would change nothing.
  const forceAdult = event?.settings?.forceAdult === true;
  const alreadyAdult = useAdultContent();
  const { guard, dialog } = useAdultContentFlipConfirm();

  return (
    <>
      <div className="admin-section">
        <h3>Easy mix</h3>
        <div className="row easymix-row">
          <div className="grow">
            <div className="name">Share of each card from the easy pool</div>
            <div className="sub">Applies from the next 8:00 unlock · reshuffles inherit it.</div>
          </div>
          <EasyMixSlider value={easyMix} onChange={(r) => setEasyMixRatio(r)} />
        </div>
      </div>

      <div className="admin-section">
        <h3>Claims &amp; proof</h3>
        <div className="row">
          <div className="grow">
            <div className="name">Claim mode</div>
            <div className="sub">A friction knob, not a trust level.</div>
          </div>
          <div className="seg" role="group" aria-label="Claim mode">
            {modes.map((m) => (
              <button
                key={m}
                className={'seg-btn' + (event?.claimMode === m ? ' on' : '')}
                aria-pressed={event?.claimMode === m}
                disabled={busy.has('claimMode')}
                onClick={() => void run('claimMode', () => setClaimMode(m))}
              >
                {modeLabel[m]}
              </button>
            ))}
          </div>
          {error('claimMode')}
        </div>
        <div className="row">
          <div className="grow">
            <div className="name">Photo proof source</div>
            <div className="sub">Camera only is today's live-proof-ceremony override; Camera or library is the recommended default.</div>
          </div>
          <div className="seg" role="group" aria-label="Photo proof source">
            <button
              className={'seg-btn' + (photoSource === 'camera_or_library' ? ' on' : '')}
              aria-pressed={photoSource === 'camera_or_library'}
              disabled={busy.has('photoSource')}
              onClick={() => void run('photoSource', () => setPhotoProofSource('camera_or_library'))}
            >
              Camera or library
            </button>
            <button
              className={'seg-btn' + (photoSource === 'camera_only' ? ' on' : '')}
              aria-pressed={photoSource === 'camera_only'}
              disabled={busy.has('photoSource')}
              onClick={() => void run('photoSource', () => setPhotoProofSource('camera_only'))}
            >
              Camera only
            </button>
          </div>
          {error('photoSource')}
        </div>
        <div className="row">
          <div className="grow">
            <div className="name">Strip location data</div>
            <div className="sub">Worth having regardless of the photo-source choice—library photos are far more likely to carry geotags than live captures.</div>
          </div>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={stripExif}
              aria-label="Strip location data"
              disabled={busy.has('stripExif')}
              onChange={(e) => { const next = e.target.checked; void run('stripExif', () => setStripPhotoExif(next)); }}
            />{' '}
            On
          </label>
          {error('stripExif')}
        </div>
        <div className="row">
          <div className="grow">
            <div className="name">AI image screen</div>
            <div className="sub">Flags proofs for review via the existing moderation function. Live setting (#268): a deployed scanner consults it per upload—no redeploy needed. The deploy-time env flag remains the master kill-switch for whether the scanner exists at all.</div>
          </div>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={visionGate}
              aria-label="AI image screen"
              disabled={busy.has('visionGate')}
              onChange={(e) => { const next = e.target.checked; void run('visionGate', () => setVisionGate(next)); }}
            />{' '}
            On
          </label>
          {error('visionGate')}
        </div>
        <div className="row">
          <div className="grow">
            <div className="name">Adults only</div>
            <div className="sub">
              {alreadyAdult
                ? 'This Event is 18+. Turning this off removes the reason, not the posture.'
                : 'Turn on for mature content the 🔞 tag does not catch—violence, drugs, self-harm.'}
            </div>
          </div>
          <label>
            <input
              type="checkbox"
              checked={forceAdult}
              aria-label="Adults only"
              disabled={busy.has('forceAdult')}
              onChange={(e) => {
                // Read the value NOW, not inside the deferred write: the confirm
                // parks the action, and this controlled checkbox has re-rendered
                // from `forceAdult` by the time the admin taps through.
                const next = e.target.checked;
                void run('forceAdult', () => guard(next, 'force', () => setForceAdult(next)));
              }}
            />{' '}
            On
          </label>
          {error('forceAdult')}
        </div>
        <div className="row">
          <div className="grow">
            <div className="name">Auto-hide after reports</div>
            <div className="sub">Reports needed for automatic hiding. Admin overrides stay in effect.</div>
          </div>
          <ReportThresholdStepper value={threshold} busy={busy.has('threshold')} onChange={(next) => void run('threshold', () => setReportHideThreshold(next))} />
          {error('threshold')}
        </div>
      </div>

      <div className="admin-section">
        <h3>Appearance</h3>
        <div className="row">
          <div className="grow">
            <div className="name">Default theme</div>
            <div className="sub">What new players see first.</div>
          </div>
        </div>
        {/* Scoped to this Edition, not the whole registry (#555): an Admin must
            not be able to set a Bodega Theme as a cruise's `defaultTheme`, or
            vice versa — the player picker's scoping means the choice would be
            unreachable in the switcher anyway. An already-set off-Edition
            default is kept in the list so it still shows as the active chip
            rather than vanishing. */}
        <div className="themes">
          {themesForEditionIncluding(event?.defaultTheme).map((t) => (
            <button
              key={t.id}
              className={'chip' + (event?.defaultTheme === t.id ? ' active' : '')}
              disabled={busy.has('theme')}
              onClick={() => void run('theme', () => setEventTheme(t.id))}
            >
              {t.emoji} {t.label}
            </button>
          ))}
        </div>
        {error('theme')}
      </div>

      {/* Last, because it is the one control here that ends the Event rather
          than tuning it (#134, specs/post-sailing-archive.md). */}
      <ArchiveEvent
        event={event}
        eventConfirmed={eventConfirmed}
        pendingClaims={pendingClaims}
        pendingClaimsLoaded={pendingClaimsLoaded}
      />
      {dialog}
    </>
  );
}
