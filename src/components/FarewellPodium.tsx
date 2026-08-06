import { useEffect, useRef } from 'react';
import type {
  DayDef,
  DayMetaDoc,
  EventDoc,
  MostLovedPhotoAward,
  MostLovedPhotoWinner,
  PlayerDoc,
  ProofDoc,
} from '../types';
import { buildPodium, type Podium } from '../data/finale';
import { mostLovedDisplayWinners, mostLovedFrozenEventPayload } from '../data/mostLoved';
import { track } from '../analytics';
import { shareOrigin } from '../canonicalHost';
import { EVENT_ID } from '../firebase';
import { useProofFeed } from '../hooks/useData';
import { resolveProofMediaUrl } from '../data/proofMediaUrl';
import { safeMediaUrl } from './safeMediaUrl';
import {
  renderFarewellShareCard,
  shareCardBlob,
  shareCardAppName,
  type FarewellShareCardData,
} from './ShareCard';
import { leaderboardShareCopy } from './Leaderboard';
import { EmojiText } from './EmojiText';
import { editionBrand, editionLexicon } from '../editions';

/**
 * The farewell view's podium banner (#217, daily-cards-spec § "Farewell view"):
 * the champion, the Event-wide First to BINGO, and the ten daily honors,
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
 *
 * #534/#561 adds the frozen Most-Loved Photo award (specs/most-loved-photo.md):
 * a section ABOVE the podium title rendering the persisted winners (all
 * co-winners on a tie) re-joined against the LIVE Feed-filtered proofs — a
 * winner hidden after the freeze drops from display while the award record
 * stays untouched, and the section falls back to plain photo highlights. The
 * share card gains its photo-hero composition for the same award.
 */

/** A Day-index → label mapper for the honors strip; mirrors the Leaderboard's
 *  "Day N · Port" shape, degrading to a bare "Day N" when the Day can't be
 *  resolved from the schedule. */
function makeDayLabel(days: readonly DayDef[] | undefined): (dayIndex: number) => string {
  return (dayIndex: number): string => {
    const d = days?.find((day) => day.index === dayIndex);
    if (!d) return `Day ${dayIndex + 1}`;
    return `Day ${dayIndex + 1} · ${d.place}${d.placeEmoji ? ` ${d.placeEmoji}` : ''}`;
  };
}

/** One photo of the Most-Loved section, shaped by the wrapper (`src` already
 *  resolved + sanitized) so the view stays payload-driven and testable. */
export interface FarewellMostLovedPhoto {
  proofId: string;
  src: string | undefined;
  displayName: string;
  promptText: string;
  dayIndex: number | null;
}

/** The Most-Loved section's two states (#561): the frozen award (every
 *  displayable co-winner, sharing one frozen heart count) or the plain
 *  photo-highlights fallback (no award framing, no counts). */
export type FarewellMostLoved =
  | { kind: 'award'; heartCount: number; photos: FarewellMostLovedPhoto[] }
  | { kind: 'highlights'; photos: FarewellMostLovedPhoto[] };

/** The award/highlights block above the podium title (#561, wireframes
 *  `fx-podium-vacay`). Appreciation for a moment, never player rank: no ranks,
 *  no per-player stats, no streaks — the ONLY number anywhere is the frozen
 *  heart chip. */
function MostLovedBlock({ mostLoved }: { mostLoved: FarewellMostLoved }) {
  const award = mostLoved.kind === 'award';
  return (
    <div className="farewell-most-loved">
      <p className="farewell-most-loved-title">
        {award ? `Most-loved photo of the ${editionLexicon().occasion}` : 'Photo highlights'}
      </p>
      {mostLoved.photos.map((p) => (
        <figure key={p.proofId} className="farewell-most-loved-item">
          <div className="farewell-most-loved-frame">
            <img
              className="farewell-most-loved-photo"
              src={p.src}
              alt={award ? `Most-loved photo by ${p.displayName}` : `Photo by ${p.displayName}`}
              loading="lazy"
            />
            {award && (
              <span className="farewell-most-loved-hearts">
                {/* The FROZEN eligible count (never live heartState), shared by
                    every co-winner on a tie. EmojiText: captured surface. */}
                <EmojiText text={`❤ ${mostLoved.heartCount}`} />
              </span>
            )}
          </div>
          <figcaption className="farewell-most-loved-credit">
            <EmojiText
              text={`${p.displayName} · “${p.promptText}”${
                award && p.dayIndex != null ? ` · Day ${p.dayIndex + 1}` : ''
              }`}
            />
          </figcaption>
        </figure>
      ))}
      {award && (
        <p className="farewell-most-loved-note">Frozen at {editionLexicon().occasion} end</p>
      )}
    </div>
  );
}

/**
 * Presentational podium — renders a prebuilt `Podium` payload. Split from the
 * data wrapper below so it can be tested against a fixture payload without a
 * roster. Renders nothing when the podium is entirely empty (no champion, no
 * First to BINGO, no honors, no Most-Loved content) so a pre-play farewell view
 * shows only the goodbye banner rather than an empty ceremony shell.
 */
export function FarewellPodiumView({
  podium,
  dayLabel = (i: number) => `Day ${i + 1}`,
  share,
  mostLoved = null,
}: {
  podium: Podium;
  dayLabel?: (dayIndex: number) => string;
  /** The share affordance (issue #449) — absent (fixture/test renders without a wrapper) renders no button; the wrapper always supplies it. */
  share?: { onShare: () => void; onWarm: () => void };
  /** The Most-Loved Photo section (#561), shaped by the wrapper; `null` (award absent, proofs still loading, or nothing to show) renders no section. */
  mostLoved?: FarewellMostLoved | null;
}) {
  const { champion, firstBingo, dailyHonors } = podium;
  // The winner's ROLE and the podium's accessible name are Edition copy (#608):
  // "Cruise champion" on a conference standings card is the leak this ticket is
  // about — it survives a brand-name find-and-replace untouched.
  const brand = editionBrand();
  const hasMostLoved = mostLoved != null && mostLoved.photos.length > 0;
  if (!champion && !firstBingo && dailyHonors.length === 0 && !hasMostLoved) return null;

  return (
    <section className="farewell-podium" aria-label={brand.podiumLabel}>
      {/* Most-Loved Photo ABOVE the podium title (#561): the memory leads,
          the scoreboard follows — the fx-podium-* stacking order. */}
      {hasMostLoved && <MostLovedBlock mostLoved={mostLoved} />}
      <p className="farewell-podium-title">The podium</p>
      {champion && (
        <div className="farewell-podium-champion">
          <span className="farewell-podium-medal" aria-hidden="true">
            🏆
          </span>
          <span className="farewell-podium-role">{brand.championRole}</span>
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
                {/* EmojiText (#603): the label carries the Day's port emoji, and
                    this section is a primary bug-report screenshot subject — a
                    bare text run rasterizes as "Day 4 🌊alletta". */}
                <span className="farewell-podium-honor-day">
                  <EmojiText text={dayLabel(h.dayIndex)} />
                </span>
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
    // Rendered only by the photo-hero composition; the photo-less card ignores
    // it, so its node stays byte-identical to the pre-#534 card.
    runnersUp: podium.runnersUp.map((r) => ({
      displayName: r.displayName,
      bingoCount: r.bingoCount,
      squaresMarked: r.squaresMarked,
    })),
  };
}

/** The hero's fully composed credit line (wireframes `fx-share-final-photo-*`):
 *  name · “prompt” · day label, plus the tie suffix naming the RECORDED
 *  co-winners (a recorded co-winner is a winner, hidden-later or not). */
function mostLovedShareCreditLine(
  hero: MostLovedPhotoWinner,
  winners: readonly MostLovedPhotoWinner[],
  dayLabel: (dayIndex: number) => string,
): string {
  let line = `${hero.displayName} · “${hero.promptText}”`;
  if (hero.dayIndex != null) line += ` · ${dayLabel(hero.dayIndex)}`;
  const others = winners.filter((w) => w.proofId !== hero.proofId);
  if (others.length === 1) line += ` · shared with ${others[0].displayName}`;
  else if (others.length > 1) line += ` · shared with ${others.length} others`;
  return line;
}

/** How long the hero-photo fetch may take before the share falls back to the
 *  photo-less composition — bounded so a dead ship-wifi fetch can never wedge
 *  the share button's tap behind an unresolvable promise. */
const HERO_PHOTO_FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch the winning photo's bytes for the share card. A plain `<img>` load of
 * proof media elsewhere is opaque/no-cors (`data/proofMediaCache.ts`), which
 * html-to-image cannot read pixels from — so the hero goes fetch → blob →
 * object URL (Firebase Storage download URLs serve CORS headers), giving the
 * rasterizer same-origin-readable pixels. Resolves `null` on ANY failure
 * (timeout, HTTP error, network throw): the caller renders photo-less, the
 * documented fallback.
 */
async function fetchHeroPhotoBlob(
  proof: Pick<ProofDoc, 'mediaURL' | 'thumbURL'>,
): Promise<Blob | null> {
  // resolveProofMediaUrl FIRST (the proofMediaUrl.ts ordering note): the fetch
  // needs the host that actually serves the bytes. No safeMediaUrl here — this
  // URL feeds fetch(), not a DOM sink; the sink guard runs in ShareCard.tsx on
  // the object URL.
  const url = resolveProofMediaUrl(proof.mediaURL ?? proof.thumbURL);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HERO_PHOTO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The wrapper's own props — one shape for both branches below. */
interface FarewellPodiumProps {
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
   * #561 widens the Pick to the Most-Loved award and the moderation fields
   * its display path rides on.
   */
  event?: Pick<
    EventDoc,
    'name' | 'days' | 'mostLovedPhoto' | 'bannedUids' | 'settings' | 'timezone'
  > | null;
}

const NO_PROOFS: readonly ProofDoc[] = [];

/**
 * The data wrapper Board mounts: computes the frozen podium from the live roster
 * + schedule and renders it. Kept thin so the presentational view stays payload-
 * driven and testable. Branches on the persisted award so the Feed's proof
 * listener exists ONLY when there is an award to display (`FarewellPodiumAwarded`
 * below) — without an award every #534 surface is inert and the pre-#534
 * component tree is unchanged.
 */
export default function FarewellPodium(props: FarewellPodiumProps) {
  const award = props.event?.mostLovedPhoto;
  if (award) return <FarewellPodiumAwarded {...props} award={award} />;
  return <FarewellPodiumInner {...props} award={null} proofs={NO_PROOFS} proofsLoaded={false} />;
}

/**
 * Mounted only when `event.mostLovedPhoto` exists: opens the Feed's own proof
 * hook — literally the same visibility filters as the Feed, because it IS the
 * Feed's hook (status=='active' query + report-threshold + banned-owner) — and
 * fires the `most_loved_photo_frozen` analytics beat on first observation of
 * the persisted award (#560 § Analytics). The 500 cap guards a winner against
 * falling off the Feed's default 60; the listener exists only during the
 * finale (Board mounts this post-freeze on the closing-Day view).
 */
function FarewellPodiumAwarded(props: FarewellPodiumProps & { award: MostLovedPhotoAward }) {
  const { proofs, loading } = useProofFeed(500);
  const { award } = props;
  // Once per device per event; the ref backs the localStorage guard up within
  // a session when storage is unavailable (private mode). The no-award record
  // fires too — `award: false` is signal, not noise.
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    const key = `most_loved_frozen_tracked:${EVENT_ID}`;
    try {
      if (window.localStorage.getItem(key) != null) {
        firedRef.current = true;
        return;
      }
    } catch {
      /* storage unavailable — fall through to the session-scoped ref guard */
    }
    firedRef.current = true;
    track('most_loved_photo_frozen', mostLovedFrozenEventPayload(award));
    try {
      window.localStorage.setItem(key, String(Date.now()));
    } catch {
      /* storage unavailable — the ref already guards this session */
    }
  }, [award]);
  return <FarewellPodiumInner {...props} proofs={proofs} proofsLoaded={!loading} />;
}

function FarewellPodiumInner({
  players,
  days,
  dayMetas,
  dayMetasLoaded = true,
  event = null,
  award,
  proofs,
  proofsLoaded,
}: FarewellPodiumProps & {
  award: MostLovedPhotoAward | null;
  proofs: readonly ProofDoc[];
  proofsLoaded: boolean;
}) {
  const podium = buildPodium(players, days, dayMetas, dayMetasLoaded);
  const dayLabel = makeDayLabel(days);

  // The render-time display gate (specs/most-loved-photo.md): persisted winners
  // joined against the LIVE Feed-filtered proofs. Hidden-after-freeze winners
  // drop from DISPLAY only; the award record is never touched.
  const displayable = award ? mostLovedDisplayWinners(award, proofs) : [];

  // The in-app section's payload — shaped only once the proofs have LOADED so
  // the award never flashes as the highlights fallback while the join is still
  // empty. Award state: every surviving co-winner. Fallback: the newest three
  // visible photos, no award framing. Nothing to show → no section.
  let mostLoved: FarewellMostLoved | null = null;
  if (award && proofsLoaded) {
    const shape = (p: ProofDoc): FarewellMostLovedPhoto => ({
      proofId: p.id,
      // resolveProofMediaUrl FIRST, safeMediaUrl LAST before the DOM (the
      // proofMediaUrl.ts ordering note; PR #95's CodeQL barrier).
      src: safeMediaUrl(resolveProofMediaUrl(p.mediaURL ?? p.thumbURL)),
      displayName: p.displayName,
      promptText: p.itemText,
      dayIndex: p.dayIndex ?? null,
    });
    const winnerPhotos = displayable
      .map(({ proof }) => shape(proof))
      .filter((p) => p.src !== undefined);
    if (winnerPhotos.length > 0) {
      mostLoved = { kind: 'award', heartCount: award.heartCount, photos: winnerPhotos };
    } else {
      const highlights = proofs
        .filter((p) => p.type === 'photo')
        .map(shape)
        .filter((p) => p.src !== undefined)
        .slice(0, 3);
      mostLoved = highlights.length > 0 ? { kind: 'highlights', photos: highlights } : null;
    }
  }

  // Warm-on-intent pre-render, mirroring Leaderboard.tsx (Codex P2, PR #111
  // round 2 finding 2 lineage): hover/focus/press starts the rasterization so
  // the tap's await reuses a settled render inside the activation window.
  // Keyed on the CARD PAYLOAD (podium content + composed copy) rather than
  // the roster array's identity: Board re-filters `players` every snapshot,
  // so an identity key would invalidate on every render even though the
  // frozen podium almost never changes. #561: the key swaps the hero's object
  // URL for its proofId (object URLs differ per fetch; the photo does not).
  const warmedCard = useRef<{ key: string; promise: Promise<Blob | null> } | null>(null);
  // The hero-photo fetch, cached by proofId so warm and tap share ONE fetch.
  const heroPhoto = useRef<{ proofId: string; promise: Promise<Blob | null> } | null>(null);

  const heroPhotoBlob = (proofId: string, proof: ProofDoc): Promise<Blob | null> => {
    if (heroPhoto.current?.proofId === proofId) return heroPhoto.current.promise;
    const promise = fetchHeroPhotoBlob(proof);
    heroPhoto.current = { proofId, promise };
    return promise;
  };

  const warmShareCard = (): Promise<Blob | null> => {
    const copy = leaderboardShareCopy(event);
    const base = toFarewellCardData(podium, dayLabel, copy, days?.length ?? 0);
    // Share-time selection rule (#561): photo-hero iff the persisted award has
    // a winner that survives the live display gate. `displayable` preserves
    // award order, so [0] is the earliest-posted STILL-VISIBLE winner.
    const hero = award && displayable.length > 0 ? displayable[0] : null;
    const heroMeta =
      hero && award
        ? {
            proofId: hero.winner.proofId,
            heartCount: award.heartCount,
            creditLine: mostLovedShareCreditLine(hero.winner, award.winners, dayLabel),
          }
        : null;
    const key = JSON.stringify({ ...base, mostLoved: heroMeta });
    if (warmedCard.current?.key === key) return warmedCard.current.promise;
    // `.catch(() => null)` inside the cached promise (same rationale as the
    // Leaderboard's): a render failure degrades to the text/URL leg and can
    // never surface as an unhandled rejection from an unconsummated hover.
    const promise = (async () => {
      let data = base;
      let objectUrl: string | null = null;
      if (hero && heroMeta) {
        const media = await heroPhotoBlob(hero.winner.proofId, hero.proof);
        if (media) {
          objectUrl = URL.createObjectURL(media);
          data = {
            ...base,
            mostLoved: {
              photoUrl: objectUrl,
              heartCount: heroMeta.heartCount,
              creditLine: heroMeta.creditLine,
            },
          };
        }
        // A failed/timed-out fetch keeps `data` photo-less — the documented
        // fallback, never a broken hero.
      }
      try {
        return await renderFarewellShareCard(data);
      } finally {
        // The rendered PNG is settled; the object URL has no further reader.
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    })().catch(() => null);
    warmedCard.current = { key, promise };
    return promise;
  };

  const shareFinalStandings = async () => {
    const blob = await warmShareCard();
    try {
      await shareCardBlob({
        blob,
        filename: `${editionLexicon().fileSlug}-final-standings.png`,
        title: `${shareCardAppName()}—Final standings`,
        text: `Final standings from ${editionBrand().appName} 🏆`,
        // Entry-point origin (#607), never the analytics-canonical host —
        // see Leaderboard's shareLeaderboard for the rationale.
        url: shareOrigin(),
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
  // #561 extends the gate: with an award that names winners, sharing also
  // waits for the proofs to load — the same don't-bake-an-incomplete-card
  // rationale, since an early tap would bake the photo-less composition while
  // the hero was still on its way. The explicit no-award record (winners: [])
  // is photo-less by definition and waits for nothing.
  const shareReady = dayMetasLoaded && (!award || award.winners.length === 0 || proofsLoaded);
  const share = shareReady
    ? { onShare: () => void shareFinalStandings(), onWarm: () => void warmShareCard() }
    : undefined;

  return (
    <FarewellPodiumView podium={podium} dayLabel={dayLabel} share={share} mostLoved={mostLoved} />
  );
}
