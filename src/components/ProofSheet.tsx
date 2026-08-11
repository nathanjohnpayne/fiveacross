import { useRef, useState } from 'react';
import { Camera, Mic, PenLine, Images, X } from 'lucide-react';
import { attachProof, type AttachProofResult } from '../data/proofs';
import { track } from '../analytics';
import { safeMediaUrl } from './safeMediaUrl';
import type { Cell, ClaimMode, ProofType } from '../types';

// iOS Safari's MediaRecorder cannot produce WebM at all — it records MP4/AAC.
// The pre-#295 code always let the browser pick a default (`new
// MediaRecorder(stream)`, no mimeType) and then hardcoded the resulting Blob
// as `'audio/webm'` regardless of what was actually recorded. On Safari that
// mislabeled an MP4/AAC clip as WebM, so the local preview `<audio>` couldn't
// decode it (an unplayable "Error" state) — and the SAME mislabeled blob still
// uploaded to the Feed. Prefer WebM/Opus where the platform genuinely supports
// it (most browsers), falling through to MP4/AAC for Safari.
const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
];

// `MediaRecorder.isTypeSupported` is guarded (not every implementation has
// it) — when absent, no mimeType is passed and the browser's own default
// applies untouched, exactly like the pre-#295 behavior.
function pickAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return AUDIO_MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

interface Props {
  uid: string;
  displayName: string;
  photoURL: string | null;
  cells: Cell[];
  cell: Cell;
  claimMode: ClaimMode;
  currentFirstBingoAt: number | null;
  // Reports a successful attach's win verdict back to Board (PR #110 round 2
  // finding 1), so a proofed Mark completing a BINGO/Blackout broadcasts its Feed
  // Moment exactly like an honor Mark — the sheet itself never touches the
  // moments queue. Optional: standalone renders (tests) omit it.
  onAttached?: (res: AttachProofResult) => void;
  // The 🎖️ Cross My Heart pledge (issue #181): present only on CLAIM opens (an
  // unmarked Square's tap), where Board wires it to the bare honor Mark. Absent
  // on proof-add opens (the ＋ on an already-marked Square) — the Square is
  // already claimed, so the row does not render at all. Enabled only in honor
  // mode; stricter modes show it disabled so Players learn the option exists.
  onPledge?: () => void;
  // The event-level photo-source override (#190): `camera_only` hides the 🖼️
  // Library affordance, leaving only 📷 Take photo. Default `camera_or_library` —
  // both affordances in EVERY Claim Mode. A presentational restriction (ADR
  // 0001), never a security boundary, and NEVER gated on claimMode.
  photoProofSource?: 'camera_or_library' | 'camera_only';
  // The viewed Day, threaded onto the Proof so the Feed reads "Day 2 · Get Sporty".
  dayIndex?: number;
  // Daily-cards mode (#246): route the proofed Mark to the DAY-SCOPED board + fold
  // its stats into `dayStats[dayIndex]` (through attachProof), the SAME path the
  // honor Mark takes. Legacy events omit it (single-board flat write).
  daily?: boolean;
  tutorialDayIndexes?: number[];
  // #265: the ceremonial (farewell) Day indexes + the standings-freeze gate,
  // threaded straight through to attachProof (same contract as setMark's).
  ceremonialDayIndexes?: number[];
  statsFrozen?: boolean | (() => boolean);
  // Strip EXIF/GPS from a photo before upload (event `stripPhotoExif`, default
  // true); passed straight through to attachProof → uploadProofMedia.
  stripExif?: boolean;
  // The Prompt's already-subscribed Tally count (ADR 0002 — no new read) for the
  // "🔥 Marked by N others so far" heat line.
  tallyCount?: number;
  onClose: () => void;
}

export default function ProofSheet(props: Props) {
  const { uid, displayName, photoURL, cells, cell, claimMode, currentFirstBingoAt, onAttached, onPledge, photoProofSource, dayIndex, daily, tutorialDayIndexes, ceremonialDayIndexes, statsFrozen, stripExif, tallyCount, onClose } = props;
  // Photo opens pre-selected (#309, folding in the #310 row-16 parity note):
  // the wireframe paints the claim sheet with the Photo body OPEN — Take photo
  // + Library visible on first paint — which drops one tap from the mainline
  // capture path. Sound/Callout bodies still mount only when chosen, and
  // `Mark it` stays gated on a valid capture, so the pledge/segments keep the
  // #181 tightened-sheet thumb reach with the photo affordances now part of
  // that first paint (specs/w4-honor-pledge.md § Tightened sheet).
  const [type, setType] = useState<ProofType | null>('photo');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  // Which affordance produced the current photo — stamped onto the Proof as
  // `source` (#190) so the Feed badges a 🖼️ library pick. Set by onPhoto from the
  // input that fired, NOT inferred from the file: a determined client could lie,
  // and that is accepted (ADR 0001 — flavour, never enforcement).
  const [photoSource, setPhotoSource] = useState<'camera' | 'library' | null>(null);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // Empty-clip guard (#295): set when a recording stops with no playable
  // data — e.g. a near-instant tap, or a platform quirk that never fired
  // `ondataavailable`. `audio` stays null in that case, so the `valid` gate
  // below keeps "Mark it" disabled — an empty/unplayable clip never reaches
  // the Feed.
  const [audioError, setAudioError] = useState(false);
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const onPhoto = (source: 'camera' | 'library') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setPhoto(f);
    // Mint the new object URL OUTSIDE the updater — exactly once — then revoke
    // the prior one inside it. Same shape as the audio path (#295: create in
    // onstop, revoke in the setter). Keeping createObjectURL out of the updater
    // matters under React.StrictMode (src/main.tsx), which double-invokes state
    // updaters in dev: a create inside would mint a second, unstored blob: URL
    // that never gets revoked — leaking the very thing this fixes (Codex P3,
    // PR #330). The revoke stays inside and is idempotent: a StrictMode double
    // call revokes the same prior URL twice, which is a harmless no-op.
    const nextUrl = URL.createObjectURL(f);
    setPhotoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextUrl;
    });
    setPhotoSource(source);
  };

  const startRec = async () => {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Ask for a Safari-playable format when the platform can tell us it
      // supports one; `mimeType` also seeds the blob-type fallback below for
      // a MediaRecorder that reports no `.mimeType` of its own.
      const mimeType = pickAudioMimeType();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const activeStream = stream;
      chunksRef.current = [];
      setAudioError(false);
      setAudio(null);
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      rec.ondataavailable = (ev) => {
        if (ev.data.size) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        activeStream.getTracks().forEach((t) => t.stop());
        if (chunksRef.current.length === 0) {
          setAudioError(true);
          setAudio(null);
          setAudioUrl(null);
          return;
        }
        // The recorder's ACTUAL reported mimeType — never a hardcoded
        // 'audio/webm' — so the Blob's `type` matches what was truly
        // recorded (Safari reports 'audio/mp4', not 'audio/webm'). Falls
        // back to the requested candidate, then a generic default, for a
        // MediaRecorder that reports no mimeType of its own.
        const blobType = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: blobType });
        if (blob.size === 0) {
          setAudioError(true);
          setAudio(null);
          setAudioUrl(null);
          return;
        }
        setAudio(blob);
        setAudioUrl(URL.createObjectURL(blob));
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      stream?.getTracks().forEach((t) => t.stop());
      alert('Mic unavailable—try a photo or a callout instead.');
    }
  };
  const stopRec = () => {
    recRef.current?.stop();
    setRecording(false);
  };

  const valid =
    type === null
      ? false
      : type === 'photo'
        ? !!photo
        : type === 'audio'
          ? !!audio && !recording
          : text.trim().length > 0;

  const submit = async () => {
    if (!valid || type === null) return;
    setBusy(true);
    try {
      const proof =
        type === 'photo'
          ? { type, blob: photo ?? undefined }
          : type === 'audio'
            ? { type, blob: audio ?? undefined }
            : { type, text: text.trim() };
      const res = await attachProof({
        uid,
        displayName,
        photoURL,
        cells,
        cellIndex: cell.index,
        itemId: cell.itemId, // the Prompt this Mark tallies (ADR 0002); null for the free centre
        itemText: cell.text,
        claimMode,
        currentFirstBingoAt,
        // Stamp the affordance only on a photo Proof (#190); audio/text carry none.
        source: type === 'photo' ? (photoSource ?? undefined) : undefined,
        dayIndex,
        daily,
        tutorialDayIndexes,
        ceremonialDayIndexes,
        statsFrozen,
        stripExif,
        proof,
      });
      track('attach_proof', { type, ...(type === 'photo' && photoSource ? { source: photoSource } : {}) });
      // Mark-transition instrumentation (#721): proof-required/admin-confirmed
      // flows (and an honor-mode Player who attaches proof instead of tapping
      // the pledge) mark an unmarked square through THIS path, not
      // `Board.doMark`'s `mark_square` call — so that call site alone misses
      // them (the root cause of #721: only 6 `mark_square` events for a POC
      // that marked 25 squares, almost all of them proof attaches). `cell` is
      // the sheet's opening snapshot (unmutated by this submit), so
      // `!cell.marked` is exactly "this attach just marked a
      // previously-unmarked square" — a proof ADDED to an already-marked
      // Square (the ＋ affordance) is not a mark transition and fires nothing
      // here. In `admin_confirmed` mode the cell lands `pending`
      // (uncredited — `game/logic.ts`'s `countMarked` excludes it), so this
      // event alone is not 1:1 with `dayStats[*].squaresMarked` in that mode;
      // the later `admin_confirm` mark_square (`data/admin.ts`) is the one
      // that corresponds to the credited transition — see
      // specs/w2-ga4-events.md § Reconciliation. This ALSO subsumes the old
      // direct `markSquareOccurred()` install-nudge trigger call that used to
      // live here: `track()`'s own `mark_square` wiring
      // (`useToastStack`'s module doc) now fires it, so a second direct call
      // would only be duplicate logic.
      if (!cell.marked) track('mark_square', { source: 'proof', mode: claimMode, marked: true });
      // Report the win verdict AFTER the transaction committed and BEFORE closing,
      // so Board enqueues the Moment for a proofed win (PR #110 round 2 finding 1).
      // Truthiness-guarded: suites stub attachProof to resolve undefined.
      if (res) onAttached?.(res);
      onClose();
    } catch {
      setBusy(false);
      alert('Upload failed—try again.');
    }
  };

  const tabs: ProofType[] = ['photo', 'audio', 'text'];
  const label: Record<ProofType, string> = { photo: 'Photo', audio: 'Sound', text: 'Callout' };
  // Lucide segment glyphs (daily-cards-spec § "Iconography — Lucide" › Claim
  // sheet): camera / mic / pen-line, one per proof type — the segmented
  // control's emoji labels retire in favor of these.
  const segIcon: Record<ProofType, typeof Camera> = { photo: Camera, audio: Mic, text: PenLine };
  // Scheme-guard the object-URL previews before they reach an <img>/<audio> src
  // (CodeQL js/xss-through-dom #1). createObjectURL only ever yields blob:, so this
  // is a belt-and-braces guard on the flagged sink; the Feed reuses the same guard.
  const safePhotoSrc = safeMediaUrl(photoUrl);
  const safeAudioSrc = safeMediaUrl(audioUrl);
  // "Marked by N others" must not count the viewer themselves (Codex P3, #211). On
  // a proof-add open (the ＋ on a Square the viewer ALREADY marked, `cell.marked`),
  // the subscribed Tally count includes the viewer's own marker
  // (tally/{itemId}/markers/{uid}), so subtract it — the remainder is genuinely
  // "others". On a fresh CLAIM open the viewer has no marker yet, so the raw count
  // is already all others. Clamp at 0 for the degenerate lone-self case.
  const heatOthers = Math.max(0, (tallyCount ?? 0) - (cell.marked ? 1 : 0));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      {/* `claim-sheet` scopes the #309 button register (sentence-case labels,
          filled accent primaries) to THIS sheet — `.sheet` chrome is shared
          with the profile/tally/who-list/menu sheets, which keep the global
          `.btn` look. Same surface-scoped pattern as #322's toast register. */}
      <div className="sheet claim-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <div className="sheet-title">Proof for “{cell.text}”</div>
          {/* The claim sheet's dismiss `x` (daily-cards-spec § "Iconography —
              Lucide" › Claim sheet) — an icon-only close alongside the
              existing "Cancel" action button below; either dismisses. */}
          <button type="button" className="sheet-dismiss" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        {typeof tallyCount === 'number' && heatOthers > 0 && (
          // The social heat line (ADR 0002): reuses the Prompt's already-subscribed
          // Tally count — no new read, no new doc — so a Player sees the pack has
          // this Square before they claim it. "so far" keeps it a running count.
          <div className="heat-line">🔥 Marked by {heatOthers} {heatOthers === 1 ? 'other' : 'others'} so far</div>
        )}
        {onPledge && (
          // The one-tap honor pledge (issue #181): its own full-width row —
          // never a fourth segment — so the label always fits on one line at
          // 320px. Pressing it IS the claim: Board marks the Square (the same
          // bare setMark an honor tap used to make) and closes the sheet. In
          // stricter modes it renders disabled: those modes require a real
          // proof, and the greyed row teaches that honor mode has a fast path.
          <button
            className="btn pledge-btn"
            // `busy` too (Codex P2, PR #184): in honor mode a player can pick a
            // REAL proof and submit — while that attachProof transaction is in
            // flight, a pledge tap would fire the bare setMark path in parallel
            // and race the transaction's full-cell write. One in-flight claim
            // per sheet: the pledge locks while a submit is saving.
            disabled={claimMode !== 'honor' || busy}
            title={claimMode !== 'honor' ? 'Available when the event runs honor mode' : undefined}
            onClick={onPledge}
          >
            🎖️ Cross My Heart
          </button>
        )}
        <div className="seg">
          {tabs.map((t) => {
            const SegIcon = segIcon[t];
            return (
              <button key={t} className={'seg-btn' + (type === t ? ' on' : '')} onClick={() => setType(t)}>
                <SegIcon className="seg-btn-icon" aria-hidden="true" /> {label[t]}
              </button>
            );
          })}
        </div>

        {type === 'photo' && (
          <div className="proof-body">
            {/* Two affordances (#190): 📷 Take photo force-launches the rear
                camera (`capture="environment"`); 🖼️ Library is the no-`capture`
                picker (the ProfileEditor pattern) — the gap #190 reported. Both
                render in EVERY Claim Mode; only `camera_only` hides Library.
                Take photo is the mainline capture path, so it wears the filled
                `primary` (#309 — the wireframe's `.btn.ok`); Library stays the
                outlined alternative. */}
            <div className="photo-affordances">
              {/* Keyboard/AT access (Codex P2, #211): the file input is VISUALLY
                  hidden but stays in the tab order + a11y tree (`.visually-hidden`,
                  not the `hidden` attribute which drops both), so a keyboard user
                  tabs onto it, the wrapping label supplies its accessible name, and
                  Enter/Space opens the picker. `.photo-affordance:focus-within`
                  moves the visible focus ring onto the pill. */}
              <label className="btn primary photo-affordance">
                <Camera className="photo-affordance-icon" aria-hidden="true" /> Take photo
                <input type="file" accept="image/*" capture="environment" className="visually-hidden" onChange={onPhoto('camera')} />
              </label>
              {photoProofSource !== 'camera_only' && (
                <label className="btn photo-affordance">
                  <Images className="photo-affordance-icon" aria-hidden="true" /> Library
                  <input type="file" accept="image/*" className="visually-hidden" onChange={onPhoto('library')} />
                </label>
              )}
            </div>
            {/* The #190 transparency note (spec § "Square tap", #262): shown
                exactly when the Library pick is offered. */}
            {photoProofSource !== 'camera_only' && (
              <p className="muted photo-library-note">Library picks wear a 🖼️ badge on the Feed</p>
            )}

            {safePhotoSrc && <img className="preview" src={safePhotoSrc} alt="preview" />}
          </div>
        )}
        {type === 'audio' && (
          <div className="proof-body">
            {!recording ? (
              <button className="btn" onClick={startRec}>
                {audio ? '● Re-record' : '● Record'}
              </button>
            ) : (
              <button className="btn primary" onClick={stopRec}>
                ■ Stop
              </button>
            )}
            {/* Empty-clip guard (#295): no captured audio survives an error
                state, so "Mark it" stays disabled via the `valid` gate below —
                this just tells the Player why and points at the fix. */}
            {audioError && (
              <p className="muted audio-error" role="alert">
                That recording came out empty—tap Record to try again.
              </p>
            )}
            {safeAudioSrc && <audio className="preview" controls src={safeAudioSrc} />}
          </div>
        )}
        {type === 'text' && (
          <div className="proof-body">
            <textarea
              className="input"
              rows={3}
              maxLength={140}
              placeholder="Name names. Who, what, how bad?"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}

        <div className="sheet-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Saving…' : claimMode === 'admin_confirmed' ? 'Submit claim' : 'Mark it'}
          </button>
        </div>
        {claimMode === 'admin_confirmed' && (
          <p className="muted" style={{ fontSize: 11, textAlign: 'center', margin: '8px 0 0' }}>
            Goes pending until an admin confirms.
          </p>
        )}
      </div>
    </div>
  );
}
