import { useEffect, useRef, useState } from 'react';
import { Camera, Mic, PenLine, Images, X } from 'lucide-react';
import { attachProof, type AttachProofResult } from '../data/proofs';
import { fetchDisplayName } from '../data/api';
import { track } from '../analytics';
import { safeMediaUrl } from './safeMediaUrl';
import type { Cell, ClaimMode, ProofType } from '../types';

// Focus-trap query — mirrors ProfileEditor.tsx / ProofFeed.tsx's
// FOCUSABLE_SELECTOR, the shared dialog convention across the sheets.
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
  // The control that opened this sheet, captured by the caller BEFORE the state
  // update that mounts us. Optional; `document.activeElement` at mount is the
  // fallback and stays correct for every caller that does not neutralize the
  // surface behind the sheet. Board does: it marks the card `inert` in the same
  // commit that mounts this sheet, and the HTML spec has a user agent move
  // focus out of a subtree that becomes inert — so by the time the passive
  // effect below runs, `document.activeElement` may already be `<body>` and the
  // restore on close would drop the Player back to the top of the page instead
  // of the Square they came from (Codex P2, round 6). Chrome measurably keeps
  // focus, but relying on that is relying on one engine's behaviour.
  restoreFocusTo?: HTMLElement | null;
  onClose: () => void;
}

export default function ProofSheet(props: Props) {
  const { uid, displayName, photoURL, cells, cell, claimMode, currentFirstBingoAt, onAttached, onPledge, photoProofSource, dayIndex, daily, tutorialDayIndexes, ceremonialDayIndexes, statsFrozen, stripExif, tallyCount, restoreFocusTo, onClose } = props;
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  // Latest-`onClose` ref (the React "latest ref" pattern). The focus effect below
  // MUST run exactly once per mount, so it cannot list `onClose` in its deps the
  // way ProfileEditor/FeedWhoListSheet do: Board passes an inline
  // `() => setProofTarget(null)` and re-renders constantly off its live streams,
  // so a fresh identity every render would re-run the effect, re-capture
  // `previouslyFocused` (by then the title itself) and yank focus back to the
  // title mid-typing — the same trap CodeRabbit flagged on #398, which the Feed
  // solved caller-side with a `useCallback`. Reading through a ref fixes it
  // HERE, so the sheet stays correct for every caller (the standalone renders in
  // src/components/d15-claim-sheet-photo.test.tsx pass a fresh `vi.fn()` per
  // rerender) without depending on call-site discipline.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // "Suggested by [player]" attribution (#559): a ONE-SHOT resolution of the
  // Community Prompt submitter's display name, fetched only while THIS sheet
  // is open on a community Square — never a live subscription (see
  // `fetchDisplayName`'s own doc comment). Lives in Prompt detail, not on the
  // card tile, per the acceptance list's "not crowding the card tile".
  //
  // Stores the uid the name was resolved FOR, not just the name (#863,
  // Codex + CodeRabbit PR #890 round 1): clearing state at the START of a
  // passive effect is not enough on its own — the render that COMMITS a
  // changed `cell.suggestedBy` happens before that effect runs, and (in a
  // real browser) can PAINT before it runs too, so a bare "clear it in the
  // effect" can still show the previous suggester's name for a Square it no
  // longer belongs to. Gating the RENDER itself on `resolvedFor ===
  // cell.suggestedBy` is correct independent of effect timing entirely: the
  // stale pair simply stops matching the instant `cell.suggestedBy`
  // changes, with no window where the wrong name can be displayed.
  const [resolved, setResolved] = useState<{ uid: string; name: string } | null>(null);
  useEffect(() => {
    // Gated on `communityPrompt`, not just `suggestedBy` (#863), matching
    // this read's documented contract (specs/community-prompt-targeting.md
    // § Attribution: "fired only while the sheet is open on a community
    // Square") in code, not only in the doc comment below.
    if (!cell.communityPrompt || !cell.suggestedBy) {
      return;
    }
    const suggestedBy = cell.suggestedBy;
    let cancelled = false;
    fetchDisplayName(suggestedBy).then((name) => {
      if (!cancelled) setResolved({ uid: suggestedBy, name });
    });
    return () => {
      cancelled = true;
    };
  }, [cell.communityPrompt, cell.suggestedBy]);
  const suggestedByName = resolved && resolved.uid === cell.suggestedBy ? resolved.name : null;

  // Modal focus management, the same contract every other sheet carries
  // (ProfileEditor, AcceptableUse, More, FeedWhoListSheet, AdminSheet): move
  // focus into the dialog on open, trap Tab/Shift+Tab inside it, close on
  // Escape, and restore focus to whatever was focused before. `previouslyFocused`
  // is captured at mount rather than held as a `triggerRef`: the sheet opens from
  // any of 25 Squares or their ＋ proof-add buttons, so there is no single
  // trigger node to point at — the same reasoning FeedWhoListSheet documents.
  // Read through a ref for the same reason `onClose` is: the effect below runs
  // exactly once per mount, so it must not list this in its deps.
  const restoreFocusToRef = useRef(restoreFocusTo);
  useEffect(() => {
    const previouslyFocused =
      restoreFocusToRef.current ?? (document.activeElement as HTMLElement | null);
    titleRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Matches Cancel and the backdrop, neither of which is gated on `busy`:
        // dismissing mid-upload abandons the sheet, not the in-flight attach —
        // `submit` still reports its verdict through `onAttached`.
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      // Exclude DISABLED controls from the trap's focusable set (the Codex P2 on
      // #392, and load-bearing here rather than defensive): "Mark it" is the LAST
      // focusable in the sheet and it is disabled on first paint (no capture yet),
      // as is the pledge outside honor mode. Native Tab skips them, so treating a
      // disabled button as `last` would mean the wrap check never fires and focus
      // escapes the dialog on the very first Tab cycle.
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []),
      ].filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // The title holds focus (tabIndex=-1, the landing spot) but is deliberately
      // outside FOCUSABLE_SELECTOR — treat it as preceding `first` so Shift+Tab
      // from it still wraps to the end.
      if (event.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

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
      // `attachProof` stamps a stable request only when its own live
      // transaction observed the false→true edge; the server recorder then
      // delivers that proof-source mark durably after the commit.
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
      <div
        ref={dialogRef}
        className="sheet claim-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <div className="sheet-title" id="claim-sheet-title" ref={titleRef} tabIndex={-1}>
            Proof for “{cell.text}”
          </div>
          {/* The claim sheet's dismiss `x` (daily-cards-spec § "Iconography —
              Lucide" › Claim sheet) — an icon-only close alongside the
              existing "Cancel" action button below; either dismisses. */}
          <button type="button" className="sheet-dismiss" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        {/* "Suggested by [player]" (#559): Community Prompt attribution lives
            HERE, in Prompt detail — never on the card tile, which stays
            reserved for the "new from the group" affordance alone (acceptance
            list: "not crowding the card tile"). Renders only once the
            one-shot name resolution above settles, so a fresh sheet open
            never flashes a placeholder name. */}
        {cell.communityPrompt && suggestedByName && (
          <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
            Suggested by {suggestedByName}
          </p>
        )}
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
