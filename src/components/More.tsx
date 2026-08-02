import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, matchPath, useLocation, useNavigate } from 'react-router';
import { FALLBACK_PATH } from './tabs';
import { Palette, CalendarDays, Lightbulb, GraduationCap, Download, Wrench, LogOut, ALargeSmall } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useEventDoc, useMyUser, usePendingItemCount } from '../hooks/useData';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { useTextSize, type TextSize } from '../hooks/useTextSize';
import { THEMES } from '../theme/themes';
import { eventTitle, shortSailRange } from '../format';
import { todaysDayTheme } from '../theme/autoTheme';
import { track } from '../analytics';
import { MoreRow } from './MoreRow';
import ProfileEditor from './ProfileEditor';
import ThemeSwitcher from './ThemeSwitcher';
import ItemPool from './ItemPool';
import Admin from './Admin';
import { adminSectionFromPath } from './admin/route';
import BugReport from './BugReport';
import AcceptableUse from './AcceptableUse';
import CoachOverlay from './CoachOverlay';
import { WalkthroughContent } from './TutorialBanner';

/**
 * The More tab (#208, daily-cards-spec § "More menu"): profile, theme, text
 * size, Play (schedule / suggest / how-to-play / install), Support (bug /
 * 18+), an admin-only Admin row, sign out, and a version footer — in that
 * fixed order. Replaces `d15-tab-contract`'s interim placeholder (#203,
 * specs/d15-tab-contract.md) wholesale. `ItemPool` and `Admin` mount here as
 * sub-panels instead of top-level routes (their own internals are
 * untouched); `BugReport` and `AcceptableUse` relocate here too
 * (`variant="row"`), replacing their former fixed-position floating mounts
 * in `App.tsx` / `Board.tsx` / `main.tsx` — see specs/d15-more-menu.md §
 * Contract for the full mount-point rationale.
 *
 * Text size (#215, specs/d15-text-size.md) lands in the slot #208 reserved
 * for it inside the Theme/Play section.
 */
export default function More() {
  const { user, signOutUser } = useAuth();
  const { data: event } = useEventDoc();
  // The More tab already owns Firebase-backed data hooks; keep AcceptableUse's
  // default/floating import path hermetic by passing the row-only attestation
  // stamp in as presentation data (Codex P1 on #281).
  const { data: myUser } = useMyUser(user?.uid);
  const isAdmin = !!(user && event?.admins?.includes(user.uid));
  const { count: pendingCount } = usePendingItemCount(isAdmin);
  const { standalone, deferred, showIOSHint, install } = useInstallPrompt();

  const [panel, setPanel] = useState<null | 'schedule' | 'suggest' | 'howToPlay' | 'coach'>(null);
  // The admin console is ROUTE-driven, not panel-state-driven
  // (specs/admin-console-ia.md): /more/admin[/section] renders it as an overlay
  // on top of this menu, so the browser/PWA back button walks detail → hub →
  // More for free. The other panels stay local state — they have no deep-link
  // or history contract.
  const location = useLocation();
  const navigate = useNavigate();
  const adminOpen = adminSectionFromPath(location.pathname) !== null;
  // The /more/* splat exists ONLY for the admin sub-routes — any other /more
  // subpath (a typo, a stale link) defers to the app's own unrecognized-route
  // fallback instead of silently rendering this menu (Codex P2, PR #410,
  // preserving the w0-app-shell route-table contract).
  const unknownSubpath = !matchPath('/more', location.pathname) && !adminOpen;
  // Today's resolved Day theme for the Theme subtitle (#270) — the same
  // unlock-based resolution Auto itself uses (theme/autoTheme.ts).
  const todayThemeId = todaysDayTheme(event);
  const todayThemeEmoji = todayThemeId ? (THEMES.find((t) => t.id === todayThemeId)?.emoji ?? '') : '';
  const closePanel = () => setPanel(null);

  const showInstallRow = !standalone && (!!deferred || showIOSHint);

  if (unknownSubpath) return <Navigate to={FALLBACK_PATH} replace />;

  return (
    <div className="more">
      {/* 1. Profile card — avatar, name, @handle; tap opens ProfileEditor's sheet. */}
      <ProfileEditor />

      {/* 2. Theme — Auto (match the day) + every party/tutorial theme. */}
      <div className="more-section">
        <h3>
          <Palette className="more-section-icon" aria-hidden="true" /> Theme
        </h3>
        {/* The wireframes' subtitle (#270): names the Auto default and, when a
            Day is live, TODAY's resolved theme emoji. */}
        <p className="more-section-sub muted">
          Auto: match the day{todayThemeEmoji ? ` (${todayThemeEmoji} today)` : ''} · or pick your own
        </p>
        <ThemeSwitcher />
      </div>

      {/* 2.5. Text size (#215) — Small / Medium / Large; the Square auto-fit
          guard in Board.tsx always has the last word over this pick. */}
      <div className="more-section">
        <h3>
          <ALargeSmall className="more-section-icon" aria-hidden="true" /> Text size
        </h3>
        <p className="more-section-sub muted">Squares grow up to what still fits—long prompts never overflow</p>
        <TextSizeSwitcher />
      </div>

      {/* 3. Play — schedule, suggest a square, how to play, install. */}
      <div className="more-section">
        <h3>Play</h3>
        <div className="more-rows">
          <MoreRow
            icon={CalendarDays}
            title="Cruise schedule"
            sub="Ports, parties, unlock times"
            onClick={() => setPanel('schedule')}
          />
          <MoreRow
            icon={Lightbulb}
            title="Suggest a square"
            sub="Goes to admin review before it can be dealt"
            onClick={() => setPanel('suggest')}
          />
          <MoreRow
            icon={GraduationCap}
            title="How to play"
            sub="Replay the Welcome Aboard walkthrough"
            onClick={() => setPanel('howToPlay')}
          />
          {showInstallRow && (
            <button type="button" className="more-row" onClick={deferred ? install : undefined}>
              <Download className="more-row-icon" aria-hidden="true" />
              <span className="more-row-text">
                <span className="more-row-title">Install the app</span>
                <span className="more-row-sub">
                  {deferred
                    ? 'Full screen, works offline at sea.'
                    : 'Add to Home Screen: tap Share, then "Add to Home Screen."'}
                </span>
              </span>
            </button>
          )}
        </div>
      </div>

      {/* 5. Support — report a bug, 18+ advisory & acceptable use. */}
      <div className="more-section">
        <h3>Support</h3>
        <div className="more-rows">
          <BugReport variant="row" />
          <AcceptableUse variant="row" attestedAdultAt={myUser?.attestedAdultAt ?? null} />
        </div>
      </div>

      {/* 6. Admin (admins only) — badged with the pending-approvals count. */}
      {isAdmin && (
        <div className="more-section">
          <div className="more-rows">
            <MoreRow
              icon={Wrench}
              title="Admin"
              badge={pendingCount > 0 ? pendingCount : undefined}
              // adminPops seeds the console's history discipline: one pop from
              // the hub reaches this More entry, so Done can pop the whole
              // admin run instead of pushing (see Admin.tsx).
              onClick={() => navigate('/more/admin', { state: { adminPops: 1 } })}
            />
          </div>
        </div>
      )}

      {/* 7. Sign out — last, visually quiet. */}
      <div className="more-section">
        <button type="button" className="more-row more-row-quiet" onClick={() => signOutUser()}>
          <LogOut className="more-row-icon" aria-hidden="true" />
          <span className="more-row-text">
            <span className="more-row-title">Sign out</span>
          </span>
        </button>
      </div>

      {/* 8. Version footer: build, sailing, dates. */}
      {/* #270 — the wireframes' footer: "v2.0 · Trieste → Barcelona · Jul 15–24".
          The route derives from the Day schedule (first → last port); a legacy
          event (no days) keeps the eventTitle form. */}
      <p className="more-version muted">
        v{__APP_VERSION__}
        {event?.days?.length
          ? ` · ${event.days[0].port} → ${event.days[event.days.length - 1].port}${shortSailRange(event.sailStart, event.sailEnd) ? ` · ${shortSailRange(event.sailStart, event.sailEnd)}` : ''}`
          : event
            ? ` · ${eventTitle(event.name, event.sailStart, event.sailEnd)}`
            : ''}
      </p>

      {panel === 'schedule' && (
        <MorePanel title="Cruise schedule" onClose={closePanel}>
          <ScheduleList event={event} />
        </MorePanel>
      )}
      {panel === 'suggest' && (
        <MorePanel title="Suggest a square" onClose={closePanel}>
          <ItemPool />
        </MorePanel>
      )}
      {panel === 'howToPlay' && (
        // #270 (spec § "More menu" item 4): How to play replays the Welcome
        // Aboard WALKTHROUGH (the game's narrative), with the badge-legend
        // coach overlay one tap further — the two complement rather than
        // repeat (spec § "First-open coach overlay").
        <MorePanel title="How to play" onClose={closePanel}>
          <WalkthroughContent />
          <button type="button" className="btn" onClick={() => setPanel('coach')}>
            Show the badge legend
          </button>
        </MorePanel>
      )}
      {panel === 'coach' && (
        // The real first-open coach overlay (#214), reopened on demand.
        // `forceOpen` bypasses the per-Event dismissal read (a replay isn't
        // "already seen it" bookkeeping); CoachOverlay renders its own
        // complete backdrop/dialog, so this replaces `MorePanel` rather
        // than nesting inside it — see specs/d15-coach-overlay.md.
        <CoachOverlay forceOpen onDismiss={closePanel} />
      )}
      {/* Admin renders its own AdminSheet chrome (sticky header, Done, the
          full dismissal contract) — MorePanel's bottom-Close chrome is exactly
          what specs/admin-console-ia.md replaces. It self-guards on isAdmin
          (a non-admin deep link gets a dismissible "Admins only." sheet). */}
      {adminOpen && <Admin />}
    </div>
  );
}

// The wireframes' compact S/M/L segments (#270); `name` keeps the full word
// as the accessible name so the abbreviation costs nothing for AT users.
const TEXT_SIZE_OPTIONS: readonly { id: TextSize; label: string; name: string }[] = [
  { id: 'small', label: 'S', name: 'Small' },
  { id: 'medium', label: 'M', name: 'Medium' },
  { id: 'large', label: 'L', name: 'Large' },
];

/**
 * The Text size row's control (#215, specs/d15-text-size.md): a Small /
 * Medium / Large segmented control, mirroring `ThemeSwitcher`'s chip
 * pattern. Persists per device only (`gcb.textSize`) — never a Firestore
 * write, unlike the theme pick's cross-device sync — via the shared
 * `useTextSize` store, so Board's per-Square auto-fit guard picks up a
 * change here immediately.
 */
function TextSizeSwitcher() {
  const [textSize, setTextSize] = useTextSize();
  return (
    <div className="text-size" role="group" aria-label="Text size">
      {TEXT_SIZE_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={'text-size-chip' + (textSize === opt.id ? ' active' : '')}
          aria-pressed={textSize === opt.id}
          aria-label={opt.name}
          onClick={() => {
            setTextSize(opt.id);
            track('text_size_change', { textSize: opt.id });
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Elements the Tab-trap below will cycle between while a panel is open —
 *  mirrors AcceptableUse.tsx's `FOCUSABLE_SELECTOR`. */
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A More sub-panel (Cruise schedule / Suggest a square / How to play / Admin):
 * reuses the app's existing sheet chrome (`.sheet-backdrop`/`.sheet`) so it
 * reads as the same kind of surface as every other modal in the app. Moves
 * focus to the title on open and restores it to nothing in particular on
 * close (More itself regains focus naturally — these panels are reached from
 * a menu row, not a small icon trigger that benefits from a focus-restore
 * pin), closes on Escape or a backdrop click. Traps Tab/Shift+Tab inside the
 * panel while open (same pattern as BugReport.tsx / AcceptableUse.tsx) so
 * keyboard and screen-reader users can't tab past Close into the obscured
 * More menu or bottom nav behind the backdrop.
 */
function MorePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // The title also holds focus (tabIndex=-1, the initial landing spot) but
      // is deliberately excluded from FOCUSABLE_SELECTOR — treat it as
      // preceding `first` so Shift+Tab from it still wraps to the end.
      if (e.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="sheet more-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title" ref={titleRef} tabIndex={-1}>
          {title}
        </div>
        {children}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The read-only Cruise schedule (issue #208 § Play): the ten Days — port,
 * party, unlock time. Editing the schedule is #221's Admin console job, not
 * this row's. Formats each Day's unlock time in the Event's own IANA
 * `timezone` (falls back to the browser's local zone while the Event doc is
 * still loading) so the times read correctly regardless of the viewer's own
 * clock.
 */
function ScheduleList({ event }: { event: { days: import('../types').DayDef[]; timezone: string } | null | undefined }) {
  if (!event || event.days.length === 0) {
    return <p className="muted">The schedule isn't set yet.</p>;
  }
  const themeLabel = (id: string) => THEMES.find((t) => t.id === id);
  return (
    <div className="list">
      {event.days.map((day) => {
        const theme = themeLabel(day.theme);
        const time = new Intl.DateTimeFormat(undefined, {
          timeZone: event.timezone || undefined,
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(day.unlockAt));
        return (
          <div key={day.index} className="row">
            <div className="grow">
              <div className="name">
                {day.portEmoji} {day.port}
              </div>
              <div className="sub">
                {theme ? `${theme.emoji} ${theme.label}` : day.theme} · unlocks {time}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
