import { useEffect, useState } from 'react';
import { setDayTheme, setDayTonight, unlockDayNow, resnapshotDayNow } from '../../data/admin';
import { dayDueForManualUnlock } from '../../game/logic';
import { THEMES } from '../../theme/themes';
import type { DayDef, ThemeId } from '../../types';

/**
 * The Admin console's manual "unlock now" fallback (#249, daily-cards-spec §
 * "Unlock mechanics": "a manual admin 'unlock now' button covers function
 * failure"). Renders ONLY inside a `ScheduleRow` whose Day is
 * `dayDueForManualUnlock` — a Day that's still locked, or already
 * snapshot-stamped, has nothing for this button to fix. Calls
 * `unlockDayNow`, the SAME admin-gated callable the scheduled unlock sweep
 * invokes internally, so a forced unlock can never diverge from the
 * scheduled path's semantics; the Admin-gate itself is enforced server-side
 * (the callable throws `permission-denied` for a non-admin uid) — this
 * button only ever renders inside the Schedule surface, which the enclosing
 * `Admin` component already gates on `isAdmin` before mounting ANY section,
 * so there's no separate client-side admin check to duplicate here.
 *
 * `visible` (the parent's live `dayDueForManualUnlock`) controls only the
 * BUTTON itself, not the whole component: once a click lands, the
 * already-subscribed `useEventDoc` listener refreshes `day.snapshotItemIds`
 * and `visible` flips false almost immediately (an emulator/production round
 * trip is fast) — if that unmounted this component entirely, an admin would
 * see the "Unlocked." confirmation for at most a flicker, or not at all, on
 * the SAME success it needed the confirmation for. So this stays mounted
 * (`ScheduleRow` always renders it) and keeps showing its last result
 * message even after `visible` goes false; only a truly untouched (`idle`)
 * row that has scrolled out of "due" renders nothing.
 */
function UnlockNowButton({
  dayIndex,
  visible,
  onActivate,
}: {
  dayIndex: number;
  visible: boolean;
  // Tap signal for the parent's anomaly latch (#418) — see ResnapshotButton.
  onActivate: () => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  if (!visible && state === 'idle') return null;

  const onClick = async () => {
    onActivate();
    setState('busy');
    setMessage(null);
    try {
      const result = await unlockDayNow(dayIndex);
      setState('done');
      setMessage(result === 'stamped' ? 'Unlocked.' : `Already handled (${result}).`);
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Unlock failed—try again.');
    }
  };

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {visible && (
        <button className="btn" onClick={onClick} disabled={state === 'busy'}>
          {state === 'busy' ? 'Unlocking…' : 'Unlock now'}
        </button>
      )}
      {/* Result as plain text, not a pill (#416): the line's words are the
          interface — two pills side by side read as two competing actions. */}
      {message && <span className="schedule-row-result">{message}</span>}
    </span>
  );
}

/**
 * The easy-mix deploy-race fallback control (specs/easy-mix.md § "Deploy race"). If the
 * 08:00 scheduler stamped Day 4 on the pre-easy-mix build, its snapshot carries the main
 * pool alone and no card can mix. This re-stamps the Day's snapshot with BOTH pools —
 * but the callable (`resnapshotDayNow` → `resnapshotDayIfNoBoards`) only overwrites while
 * ZERO cards have been dealt; once any board exists it returns `has-boards` and changes
 * nothing. Rendered only for an unlocked MAIN Day (the mix never applies to tutorial
 * Days, and Days 1-3 intentionally stay untouched); the zero-boards and Day-4 boundary
 * safety is the SERVER's, so the button is always safe to show.
 * Admin-gate is the enclosing Admin console (it gates every section on `isAdmin`).
 *
 * `visible` mirrors `UnlockNowButton`'s sticky mount (#415): a SUCCESSFUL
 * re-snapshot writes `snapshotEasyMixRatio`, which flips the parent's
 * provenance-gated `canResnapshot` false on the event-doc echo — if that
 * unmounted this component, the "Re-snapshotted with both pools." confirmation
 * would vanish on the very success it confirms. So the component stays mounted
 * and keeps its last result; only the button itself follows `visible`.
 * `onActivate` tells the parent a tap happened, so the row latches the anomaly
 * text beside the result (#418, the mockup's resolved state).
 */
function ResnapshotButton({
  dayIndex,
  visible,
  onActivate,
}: {
  dayIndex: number;
  visible: boolean;
  onActivate: () => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  if (!visible && state === 'idle') return null;

  const onClick = async () => {
    onActivate();
    setState('busy');
    setMessage(null);
    try {
      const result = await resnapshotDayNow(dayIndex);
      setState('done');
      setMessage(
        result === 'resnapshotted'
          ? 'Re-snapshotted with both pools.'
          : result === 'has-boards'
            ? 'Denied — cards already dealt.'
            : result === 'not-recoverable'
              ? 'Denied — early Days stay untouched.'
            : `No change (${result}).`,
      );
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Re-snapshot failed—try again.');
    }
  };
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {visible && (
        <button
          className="btn"
          onClick={onClick}
          disabled={state === 'busy'}
          title="Deploy-race fallback: re-stamp this Day's snapshot with the easy-mix pools (only if no cards dealt yet)"
        >
          {state === 'busy' ? 'Re-snapshotting…' : 'Re-snapshot'}
        </button>
      )}
      {/* Result as plain text, not a pill (#416) — see UnlockNowButton. */}
      {message && <span className="schedule-row-result">{message}</span>}
    </span>
  );
}

/**
 * One row in the Schedule editor (#221, daily-cards-spec § "Admin console" / §
 * "Itinerary and schedule"): a single Day's date + port (read-only display)
 * and a theme `<select>`. Date/port are shown for context only — this ticket
 * scopes the write surface to `theme`, matching the spec ("the schedule stays
 * admin-editable... changing a locked-future Day's theme is safe, changing an
 * already-unlocked Day is disallowed"); `days[]` length is fixed at seed, so
 * there is no row add/remove here. The lock is CLIENT-SIDE convenience only —
 * `firestore.rules` (`daysThemeLockOk`) is what actually denies a locked
 * Day's write; a direct-SDK caller bypassing this disabled control still gets
 * rejected server-side. The once-a-cruise recovery fallbacks (`UnlockNowButton`
 * #249, `ResnapshotButton` easy-mix deploy race) no longer sit inline between
 * the Day content and the dropdown — which lopsided the one eligible row and
 * shifted its dropdown out of line. Instead a Day that needs one grows a
 * full-width "repair line" INSIDE its own row (#413,
 * specs/admin-console-ia.md § "Schedule"; mockup #frame-admin-schedule): the
 * anomaly stated in plain words, the quiet fix button at the line's trailing
 * edge. Every row keeps one uniform shape — info + theme dropdown trailing,
 * never shifting — and the repair line stays anchored to the specific Day it
 * acts on.
 */
// The "Tonight:" line's two events are stored as a `string[]`; the editor round-
// trips them through one text field joined by the same " · " the day bar renders,
// so an admin edits the line exactly as players see it. Split tolerates either
// bullet spacing and drops empty segments; the DayBar render guard copes with any
// count, so a mid-edit line never throws.
const TONIGHT_SEP = ' · ';
function joinTonight(tonight: string[] | undefined): string {
  return (Array.isArray(tonight) ? tonight : []).join(TONIGHT_SEP);
}
function splitTonight(text: string): string[] {
  return text
    .split(/\s*·\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Best-effort admin chrome (schedule correction 2026-07-17): a "2 parties" pill
// on Days whose two Tonight events are BOTH parties, vs a headline show/concert
// + party. There is no structured party/show flag on the model (tonight is free
// text), so "party" is inferred from the data's own convention — a headline
// show/concert leads with 🎭 or 🎤 (AirOtic, Solea Pfeiffer, Persephone, HAYLA);
// everything else is a party. Purely cosmetic: a mis-inferred pill never affects
// dealing, scoring, or the stored line.
const SHOW_LEAD_EMOJI = ['🎭', '🎤'];
function isPartyEvent(event: string): boolean {
  const trimmed = event.trim();
  return trimmed.length > 0 && !SHOW_LEAD_EMOJI.some((e) => trimmed.startsWith(e));
}
function isTwoPartyDay(day: DayDef): boolean {
  const tonight = Array.isArray(day.tonight) ? day.tonight : [];
  return !day.tutorial && tonight.length === 2 && tonight.every(isPartyEvent);
}

// The two anomaly labels for a Day's repair line (#413,
// specs/admin-console-ia.md § "Schedule"; mockup #frame-admin-schedule). Each
// states, in the admin's own words, what went wrong on THIS Day; the paired
// fallback button at the line's trailing edge is the fix. Kept here beside the
// eligibility checks (`canResnapshot` / `dayDueForManualUnlock`) that decide
// which — if either — a row shows.
const RESNAPSHOT_ANOMALY = 'Snapshot predates the easy-mix deploy';
const UNLOCK_ANOMALY = 'Missed the 8:00 unlock';

function ScheduleRow({
  day,
  now,
  onChangeTheme,
  onChangeTonight,
}: {
  day: DayDef;
  now: number;
  onChangeTheme: (dayIndex: number, theme: ThemeId) => void;
  onChangeTonight: (dayIndex: number, tonight: string[]) => Promise<void>;
}) {
  const locked = day.unlockAt <= now;
  const dueForManualUnlock = dayDueForManualUnlock(day, now);
  // The easy-mix re-snapshot fallback only makes sense for a MAIN Day that has already
  // unlocked AND been stamped (a stamped-but-maybe-main-only snapshot); an unstamped Day
  // uses "Unlock now" above, and tutorial Days never mix. Server enforces zero-boards.
  // Provenance gate (#415): every post-easy-mix stamp path freezes
  // `snapshotEasyMixRatio` (always a number) with a main Day's snapshot, so a
  // stamped main Day WITHOUT it is structurally a pre-easy-mix snapshot — the
  // deploy race this fallback exists for. Gating on its absence keeps the
  // "Snapshot predates the easy-mix deploy" line off healthy modern snapshots
  // (Codex, PR #414), and a successful re-snapshot self-heals: the ratio
  // appears on the echo and the line retires.
  const canResnapshot =
    day.index >= 3 &&
    day.pool === 'main' &&
    day.unlockAt <= now &&
    day.snapshotItemIds != null &&
    day.snapshotEasyMixRatio == null;
  // Tap latches (#418, the mockup's resolved state): once a fallback is TAPPED,
  // its anomaly text stays for the row's lifetime, so the result reads beside
  // its context ("Missed the 8:00 unlock — Unlocked.") after eligibility flips
  // false on the event-doc echo. An EXTERNAL resolution (scheduler catches up,
  // another admin acts — no tap here) latches nothing: the anomaly retires with
  // its eligibility and the empty-line guard keeps the row single-line.
  const [resnapshotTapped, setResnapshotTapped] = useState(false);
  const [unlockTapped, setUnlockTapped] = useState(false);
  // Sticky mount for the repair line: show it once a fallback has been relevant,
  // then KEEP it for the row's lifetime. `UnlockNowButton` deliberately holds
  // its "Unlocked." confirmation after `dueForManualUnlock` flips false, and on
  // a tutorial/early Day `canResnapshot` never turns true to re-show a line
  // gated on the live conditions — so a line gated purely on
  // `canResnapshot || dueForManualUnlock` would unmount that confirmation on the
  // very success it's confirming. Latch on first relevance, never unmount.
  const [recoveryEverShown, setRecoveryEverShown] = useState(canResnapshot || dueForManualUnlock);
  useEffect(() => {
    if (canResnapshot || dueForManualUnlock) setRecoveryEverShown(true);
  }, [canResnapshot, dueForManualUnlock]);
  // Local draft so typing doesn't fight the subscribed doc; committed on blur.
  const [tonightDraft, setTonightDraft] = useState(() => joinTonight(day.tonight));
  const [tonightError, setTonightError] = useState('');
  // Keyed on the NORMALIZED line, not the array reference: Firestore re-emits
  // equal entries as a fresh array on unrelated event-doc writes, and an
  // identity dep would wipe in-progress typing on every such echo
  // (CodeRabbit, PR #410).
  const tonightPersisted = joinTonight(day.tonight);
  useEffect(() => {
    setTonightDraft(tonightPersisted);
    setTonightError('');
  }, [tonightPersisted]);
  const commitTonight = async () => {
    if (locked) return;
    const next = splitTonight(tonightDraft);
    if (next.length !== 2 || next.some((entry) => entry.trim().length === 0)) {
      setTonightError('Tonight needs exactly two entries.');
      return;
    }
    setTonightError('');
    if (joinTonight(next) === joinTonight(day.tonight)) return;
    try {
      await onChangeTonight(day.index, next);
    } catch {
      setTonightDraft(joinTonight(day.tonight));
      setTonightError('Tonight save failed. Reload the schedule and try again.');
    }
  };
  return (
    <div className="row schedule-row">
      {/* Top line: uniform on every row — info grows, the theme dropdown trails.
          No fallback control ever lands here, so the dropdown never shifts. */}
      <div className="schedule-row-top">
        <div className="grow">
          <div className="name">
            Day {day.index + 1} · {day.date} · {day.portEmoji} {day.port}
            {day.tutorial ? (
              <span className="pill">tutorial</span>
            ) : (
              isTwoPartyDay(day) && <span className="pill">2 parties</span>
            )}
          </div>
          <div className="sub">{locked ? 'locked — already unlocked or past' : 'editable until unlock'}</div>
          <input
            className="tonight-input"
            aria-label={`Day ${day.index + 1} tonight`}
            value={tonightDraft}
            disabled={locked}
            placeholder="e.g. 🪖 Dog Tag T-Dance · ✈️ Duty Free"
            onChange={(e) => setTonightDraft(e.target.value)}
            onBlur={() => void commitTonight()}
          />
          {tonightError ? <div className="error" role="alert">{tonightError}</div> : null}
        </div>
        <select
          aria-label={`Day ${day.index + 1} theme`}
          value={day.theme}
          disabled={locked}
          onChange={(e) => onChangeTheme(day.index, e.target.value as ThemeId)}
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.emoji} {t.label}
            </option>
          ))}
        </select>
      </div>
      {/* Repair line: a full-width second line inside the row for a Day that
          needs a fallback. Anomaly in plain words first, the quiet fix button at
          the trailing edge; the button carries its own result/denial message
          beside the anomaly after a tap. Mounted stickily (see recoveryEverShown)
          so the confirmation survives eligibility flipping false. */}
      {recoveryEverShown && (
        <div className="schedule-row-repair" role="group" aria-label={`Day ${day.index + 1} repair`}>
          {(canResnapshot || resnapshotTapped) && (
            <span className="schedule-row-anomaly">{RESNAPSHOT_ANOMALY}</span>
          )}
          {(dueForManualUnlock || unlockTapped) && (
            <span className="schedule-row-anomaly">{UNLOCK_ANOMALY}</span>
          )}
          <span className="schedule-row-actions">
            <ResnapshotButton
              dayIndex={day.index}
              visible={canResnapshot}
              onActivate={() => setResnapshotTapped(true)}
            />
            <UnlockNowButton
              dayIndex={day.index}
              visible={dueForManualUnlock}
              onActivate={() => setUnlockTapped(true)}
            />
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The Schedule surface (#221, re-housed by specs/admin-console-ia.md): the ten
 * seeded Days as rows, in order, each with a theme dropdown disabled once its
 * Day has unlocked. `days` comes straight from the already-subscribed
 * `useEventDoc()` Event doc — no separate listener — and `setDayTheme` is
 * handed the FULL current array so it can write back a targeted single-element
 * replacement (see `data/admin`'s doc comment for why `days` can't be updated
 * by dot-path). Content is unchanged from the old Schedule tab; only the
 * chrome around it moved.
 */
export default function SchedulePanel({ days }: { days: DayDef[] }) {
  // Advance `now` exactly when the EARLIEST still-locked Day unlocks, mirroring
  // the Board's unlock timer (Codex P2, PR #230): without it an admin who leaves
  // the Schedule surface open across an `unlockAt` rollover would keep a just-
  // unlocked row's dropdown enabled until an unrelated re-render, letting them
  // start a write the server rule now (correctly) rejects. The timer re-renders
  // the row disabled at the moment its Day locks. Depends on `days` so it
  // re-arms as the schedule changes, not on every render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const nextUnlock = days
      .map((d) => d.unlockAt)
      .filter((t) => t > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextUnlock == null) return;
    // A delay past the 32-bit timer ceiling (~24.8 days) would overflow and
    // fire immediately, re-arming this effect in a tight loop for a far-future
    // schedule (CodeRabbit, PR #410). A clamped early fire just re-runs the
    // effect, which re-arms with the remaining delay.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(nextUnlock - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [days, now]);
  return (
    <div className="admin-section">
      {!days.length && (
        <p className="muted" style={{ fontSize: 12 }}>
          No Days seeded yet.
        </p>
      )}
      <div className="list">
        {days.map((d) => (
          <ScheduleRow
            key={d.index}
            day={d}
            now={now}
            onChangeTheme={(dayIndex, theme) => setDayTheme(days, dayIndex, theme)}
            onChangeTonight={(dayIndex, tonight) => setDayTonight(days, dayIndex, tonight)}
          />
        ))}
      </div>
    </div>
  );
}
