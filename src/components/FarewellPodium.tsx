import { useRef } from 'react';
import type { DayDef, DayMetaDoc, EventDoc, PlayerDoc } from '../types';
import { buildPodium, type Podium } from '../data/finale';
import { track } from '../analytics';
import { canonicalOrigin } from '../canonicalHost';
import {
  renderFarewellShareCard,
  shareCardBlob,
  SHARE_CARD_APP_NAME,
  type FarewellShareCardData,
} from './ShareCard';
import { leaderboardShareCopy } from './Leaderboard';

/**
 * The farewell view's podium banner (#217, daily-cards-spec § "Farewell view"):
 * the cruise champion, the cruise-wide First to BINGO, and the ten daily honors,
 * shown once the standings freeze. Mounts ABOVE the goodbye banner
 * (`TutorialBanner`'s farewell copy) — Board owns that stacking order — so the
 * ceremony reads podium-then-goodbye. `d15-tutorial-banners` owns the goodbye
 * copy; this component owns only the podium.
 *
 * The standings are frozen: `buildPodium` excludes the farewell Day's own marks,
 * so a post-freeze goodbye mark never changes who is on the podium (the
 * "as of `frozenAt`, not live" rule).
 *
 * Issue #449 adds the podium's own share affordance — a "Share final standings"
 * button at the BOTTOM of the section that renders the frozen podium as a Share
 * Card (`renderFarewellShareCard`, specs/w2-share-cards.md) and hands it to the
 * native share sheet, mirroring the Leaderboard's warm-on-intent pattern.
 */

/** A Day-index → label mapper for the honors strip; mirrors the Leaderboard's
 *  "Day N · Port" shape, degrading to a bare "Day N" when the Day can't be
 *  resolved from the schedule. */
function makeDayLabel(days: readonly DayDef[] | undefined): (dayIndex: number) => string {
  return (dayIndex: number): string => {
    const d = days?.find((day) => day.index === dayIndex);
    if (!d) return `Day ${dayIndex + 1}`;
    return `Day ${dayIndex + 1} · ${d.port}${d.portEmoji ? ` ${d.portEmoji}` : ''}`;
  };
}

/**
 * Presentational podium — renders a prebuilt `Podium` payload. Split from the
 * data wrapper below so it can be tested against a fixture payload without a
 * roster. Renders nothing when the podium is entirely empty (no champion, no
 * First to BINGO, no honors) so a pre-play farewell view shows only the goodbye
 * banner rather than an empty ceremony shell.
 */
export function FarewellPodiumView({
  podium,
  dayLabel = (i: number) => `Day ${i + 1}`,
  share,
}: {
  podium: Podium;
  dayLabel?: (dayIndex: number) => string;
  /** The share affordance (issue #449) — absent (fixture/test renders without a wrapper) renders no button; the wrapper always supplies it. */
  share?: { onShare: () => void; onWarm: () => void };
}) {
  const { champion, firstBingo, dailyHonors } = podium;
  if (!champion && !firstBingo && dailyHonors.length === 0) return null;

  return (
    <section className="farewell-podium" aria-label="Cruise podium">
      <p className="farewell-podium-title">The podium</p>
      {champion && (
        <div className="farewell-podium-champion">
          <span className="farewell-podium-medal" aria-hidden="true">
            🏆
          </span>
          <span className="farewell-podium-role">Cruise champion</span>
          <span className="farewell-podium-name">{champion.displayName}</span>
          <span className="farewell-podium-stat">
            {champion.bingoCount} bingo{champion.bingoCount === 1 ? '' : 's'} · {champion.squaresMarked} squares
          </span>
        </div>
      )}
      {firstBingo && (
        <div className="farewell-podium-first">
          <span className="farewell-podium-medal" aria-hidden="true">
            👑
          </span>
          <span className="farewell-podium-role">First to BINGO</span>
          <span className="farewell-podium-name">{firstBingo.displayName}</span>
        </div>
      )}
      {dailyHonors.length > 0 && (
        <div className="farewell-podium-honors" aria-label="Daily First to BINGO">
          <p className="farewell-podium-honors-title">Daily honors</p>
          <ul className="farewell-podium-honors-strip">
            {dailyHonors.map((h) => (
              <li key={h.dayIndex} className="farewell-podium-honor">
                <span className="farewell-podium-honor-day">{dayLabel(h.dayIndex)}</span>
                <span className="farewell-podium-honor-name">{h.displayName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {share && (
        <div className="farewell-podium-actions">
          <button
            type="button"
            className="btn"
            onClick={share.onShare}
            onPointerEnter={share.onWarm}
            onFocus={share.onWarm}
            onPointerDown={share.onWarm}
          >
            Share final standings
          </button>
        </div>
      )}
    </section>
  );
}

/** Shapes the frozen `Podium` into the renderer's data — labels resolved here, so the renderer stays dumb (specs/w2-share-cards.md's caller-shapes rule). */
function toFarewellCardData(
  podium: Podium,
  dayLabel: (dayIndex: number) => string,
  copy: { eventName: string; contextLine: string | undefined },
  dayCount: number,
): FarewellShareCardData {
  return {
    eventName: copy.eventName,
    champion: podium.champion
      ? {
          displayName: podium.champion.displayName,
          bingoCount: podium.champion.bingoCount,
          squaresMarked: podium.champion.squaresMarked,
        }
      : null,
    firstBingo: podium.firstBingo ? { displayName: podium.firstBingo.displayName } : null,
    honors: podium.dailyHonors.map((h) => ({
      dayLabel: dayLabel(h.dayIndex),
      displayName: h.displayName,
    })),
    contextLine: copy.contextLine,
    statLine: dayCount > 0 ? `Final standings · ${dayCount} days` : 'Final standings',
  };
}

/**
 * The data wrapper Board mounts: computes the frozen podium from the live roster
 * + schedule and renders it. Kept thin so the presentational view stays payload-
 * driven and testable.
 */
export default function FarewellPodium({
  players,
  days,
  dayMetas,
  dayMetasLoaded = true,
  event = null,
}: {
  players: readonly PlayerDoc[];
  days: readonly DayDef[] | undefined;
  dayMetas?: ReadonlyMap<number, DayMetaDoc>;
  dayMetasLoaded?: boolean;
  /**
   * Board's own already-loaded event, passed DOWN rather than re-subscribed
   * (Codex P2, PR #450): Board gates this component on `event?.frozenAt`,
   * so the event is guaranteed loaded by the time we can mount — a second
   * `useEventDoc()` listener here would start `data: null`, letting an
   * early warm/tap bake the bare-app-name card and a late snapshot
   * invalidate the warmed render mid-click. Same props-not-listeners fix
   * as Celebration's cells/playerName (PR #111 findings 1 + round 2.1).
   */
  event?: Pick<EventDoc, 'name' | 'days'> | null;
}) {
  const podium = buildPodium(players, days, dayMetas, dayMetasLoaded);
  const dayLabel = makeDayLabel(days);
  // Warm-on-intent pre-render, mirroring Leaderboard.tsx (Codex P2, PR #111
  // round 2 finding 2 lineage): hover/focus/press starts the rasterization so
  // the tap's await reuses a settled render inside the activation window.
  // Keyed on the CARD PAYLOAD (podium content + composed copy) rather than
  // the roster array's identity: Board re-filters `players` every snapshot,
  // so an identity key would invalidate on every render even though the
  // frozen podium almost never changes.
  const warmedCard = useRef<{ key: string; promise: Promise<Blob | null> } | null>(null);

  const warmShareCard = (): Promise<Blob | null> => {
    const copy = leaderboardShareCopy(event);
    const data = toFarewellCardData(podium, dayLabel, copy, days?.length ?? 0);
    const key = JSON.stringify(data);
    if (warmedCard.current?.key === key) return warmedCard.current.promise;
    // `.catch(() => null)` inside the cached promise (same rationale as the
    // Leaderboard's): a render failure degrades to the text/URL leg and can
    // never surface as an unhandled rejection from an unconsummated hover.
    const promise = renderFarewellShareCard(data).catch(() => null);
    warmedCard.current = { key, promise };
    return promise;
  };

  const shareFinalStandings = async () => {
    const blob = await warmShareCard();
    try {
      await shareCardBlob({
        blob,
        filename: 'gay-cruise-bingo-final-standings.png',
        title: `${SHARE_CARD_APP_NAME}—Final standings`,
        text: 'Final standings from Gay Cruise Bingo 🏆',
        // Canonical hostname (#556), not the raw origin — see Leaderboard's
        // shareLeaderboard for the rationale.
        url: canonicalOrigin(),
      });
    } catch {
      // shareCardBlob never throws by design; belt-and-braces regardless.
    } finally {
      track('share_click', { surface: 'farewell' });
    }
  };

  // No share affordance until the day-meta honors settle (Codex P2, PR
  // #450): on a cold farewell load the roster snapshot can produce a
  // champion before all ten day-meta listeners answer, and buildPodium
  // deliberately withholds derived honors while `dayMetasLoaded` is false —
  // an immediate tap would bake a permanently incomplete honors list into
  // the shared image. The podium itself still renders; only sharing waits.
  const share = dayMetasLoaded
    ? { onShare: () => void shareFinalStandings(), onWarm: () => void warmShareCard() }
    : undefined;

  return <FarewellPodiumView podium={podium} dayLabel={dayLabel} share={share} />;
}
