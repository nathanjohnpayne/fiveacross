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
import { standingsFreezeAtFor } from '../game/logic';
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

// localStorage is the durable once-per-device guard. When storage is
// unavailable, retain every Event seen during this JavaScript session outside
// the Event-keyed Board subtree so A -> B -> A still fires only once for A.
const mostLovedTrackedWithoutStorage = new Set<string>();
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
 *  co-winners (a recorded co-winner is a winner, hidden-later or not).
 *
 *  `winners` is the persisted, deliberately bounded prefix (first 100
 *  co-winners — src/domainTypes.d.ts); `winnerCount` is the true tied
 *  cardinality, which can exceed that prefix (#659). Names are only safe to
 *  read from `winners` when the complete tie fits inside the prefix — i.e.
 *  every co-winner is actually present in the array — otherwise the suffix
 *  falls back to the persisted total so a 101-way tie says "100 others"
 *  instead of undercounting from the truncated array. `winnerCount` is
 *  optional (absent on records written before the bounded format), so it
 *  falls back to `winners.length`, matching the pre-#659 behavior exactly. */
function mostLovedShareCreditLine(
  hero: MostLovedPhotoWinner,
  winners: readonly MostLovedPhotoWinner[],
  winnerCount: number | undefined,
  dayLabel: (dayIndex: number) => string,
): string {
  let line = `${hero.displayName} · “${hero.promptText}”`;
  if (hero.dayIndex != null) line += ` · ${dayLabel(hero.dayIndex)}`;
  const totalWinners = winnerCount ?? winners.length;
  if (winners.length >= totalWinners) {
    const others = winners.filter((w) => w.proofId !== hero.proofId);
    if (others.length === 1) line += ` · shared with ${others[0].displayName}`;
    else if (others.length > 1) line += ` · shared with ${others.length} others`;
  } else {
    // The prefix was truncated — the true tie is bigger than what's
    // persisted, so name lookups can't be trusted. Report the real count.
    const othersCount = totalWinners - 1;
    if (othersCount > 0) line += ` · shared with ${othersCount} others`;
  }
  return line;
}

/** How long the hero-photo fetch may take before the share falls back to the
 *  photo-less composition — bounded so a dead ship-wifi fetch can never wedge
 *  the share button's tap behind an unresolvable promise. */
const HERO_PHOTO_FETCH_TIMEOUT_MS = 8000;

/**
 * The warmed farewell card, with its SETTLED state carried alongside the
 * promise (Codex P1, PR #712 round 3).
 *
 * Round 2 let the tap wait up to four seconds for this render. That was still
 * a wait, and a wait is the whole problem: `navigator.share` needs transient
 * user activation, so does `clipboard.writeText` on Safari and Firefox, and a
 * wait that outlives the activation leaves every one of those legs unable to
 * fire — a bounded no-op instead of an unbounded one. Only a tap that never
 * waits at all is structurally safe, so the tap reads `blob` (valid only when
 * `settled`) and calls `shareCardBlob` in the same turn as the gesture.
 * `blob` is deliberately allowed to be `null` on a settled render too: a
 * failed render already means "share without the image" downstream.
 */
type WarmedCard = {
  key: string;
  promise: Promise<Blob | null>;
  settled: boolean;
  blob: Blob | null;
};

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
    | 'name'
    | 'days'
    | 'mostLovedPhoto'
    | 'bannedUids'
    | 'settings'
    | 'timezone'
    // The freeze cutoff this podium is computed AS OF (Phase 4b P1). `frozenAt`
    // is stamped to the SCHEDULED instant, never the run clock, so the two
    // agree once the scheduler has run and `standingsFreezeAtFor` covers the
    // window before it.
    | 'frozenAt'
    | 'standingsFreezeAt'
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
  if (award && props.event) return <FarewellPodiumAwarded {...props} event={props.event} award={award} />;
  return <FarewellPodiumInner {...props} award={null} proofs={NO_PROOFS} proofsLoaded={false} />;
}

/**
 * Mounted only when `event.mostLovedPhoto` exists: opens the Feed's own proof
 * hook — literally the same visibility filters as the Feed, because it IS the
 * Feed's hook (status=='active' query + report-threshold + banned-owner) — and
 * fires the `most_loved_photo_frozen` analytics beat on first observation of
 * the persisted award (#560 § Analytics). It deliberately retains every
 * Feed-visible proof: an older winner can legitimately fall below the Feed's
 * default (or any arbitrary) recency cap, and the frozen award must still be
 * able to join its live proof for the required moderation-aware display gate.
 * The listener exists only during the finale (Board mounts this post-freeze on
 * the closing-Day view).
 */
function FarewellPodiumAwarded(
  props: FarewellPodiumProps & {
    award: MostLovedPhotoAward;
    event: NonNullable<FarewellPodiumProps['event']>;
  },
) {
  const { proofs, loading } = useProofFeed(null, {
    threshold: props.event.settings?.reportHideThreshold,
    bannedUids: props.event.bannedUids ?? [],
  });
  const { award } = props;
  const eventId = EVENT_ID;
  // Once per device per Event; module session state backs the localStorage
  // guard up when storage is unavailable (private mode). The no-award record
  // fires too — `award: false` is signal, not noise.
  useEffect(() => {
    if (mostLovedTrackedWithoutStorage.has(eventId)) return;
    const key = `most_loved_frozen_tracked:${eventId}`;
    try {
      if (window.localStorage.getItem(key) != null) {
        return;
      }
    } catch {
      /* storage unavailable — fall through to the session-scoped guard */
      mostLovedTrackedWithoutStorage.add(eventId);
    }
    track('most_loved_photo_frozen', mostLovedFrozenEventPayload(award));
    try {
      window.localStorage.setItem(key, String(Date.now()));
    } catch {
      mostLovedTrackedWithoutStorage.add(eventId);
    }
  }, [award, eventId]);
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
  // The podium is "as of the freeze", not live: a ceremonial Day keeps
  // recording Marks afterwards, and without this cutoff a post-freeze bingo
  // could mint a First to BINGO the scheduler's immutable podium Moment does
  // not have — the card and the Feed naming different winners.
  const freezeAt = event?.frozenAt ?? standingsFreezeAtFor(event ?? null);
  const podium = buildPodium(players, days, dayMetas, dayMetasLoaded, freezeAt);
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
    const shape = (p: ProofDoc, winner?: MostLovedPhotoWinner): FarewellMostLovedPhoto => ({
      // Attribution is frozen with the award. The live proof is only the
      // moderation/incarnation/media gate, so an edit after the standings
      // freeze cannot rewrite what the award records.
      proofId: winner?.proofId ?? p.id,
      // resolveProofMediaUrl FIRST, safeMediaUrl LAST before the DOM (the
      // proofMediaUrl.ts ordering note; PR #95's CodeQL barrier).
      src: safeMediaUrl(resolveProofMediaUrl(p.mediaURL ?? p.thumbURL)),
      displayName: winner?.displayName ?? p.displayName,
      promptText: winner?.promptText ?? p.itemText,
      // `null` is frozen attribution too: only a highlights fallback reads
      // live metadata. Nullish coalescing here would invent a Day after freeze.
      dayIndex: winner ? winner.dayIndex : p.dayIndex ?? null,
    });
    const winnerPhotos = displayable
      .map(({ winner, proof }) => shape(proof, winner))
      .filter((p) => p.src !== undefined);
    if (winnerPhotos.length > 0) {
      mostLoved = { kind: 'award', heartCount: award.heartCount, photos: winnerPhotos };
    } else {
      const highlights = proofs
        .filter((p) => p.type === 'photo')
        .map((p) => shape(p))
        .filter((p) => p.src !== undefined)
        .slice(0, 3);
      mostLoved = highlights.length > 0 ? { kind: 'highlights', photos: highlights } : null;
    }
  }

  // Warm-on-intent pre-render, mirroring Leaderboard.tsx (Codex P2, PR #111
  // round 2 finding 2 lineage): hover/focus/press starts the rasterization so
  // the tap reuses an already-settled render inside the activation window.
  // Keyed on the CARD PAYLOAD (podium content + composed copy) rather than
  // the roster array's identity: Board re-filters `players` every snapshot,
  // so an identity key would invalidate on every render even though the
  // frozen podium almost never changes. #561: the key swaps the hero's object
  // URL for its proofId (object URLs differ per fetch; the photo does not).
  const warmedCard = useRef<WarmedCard | null>(null);
  // One eager render per mount, once sharing is allowed (see the effect
  // below) — the ref, not a `useEffect` dep list, is what makes it once.
  const eagerRenderStarted = useRef(false);
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
            creditLine: mostLovedShareCreditLine(
              hero.winner,
              award.winners,
              award.winnerCount,
              dayLabel,
            ),
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
          // Minting the object URL is itself a media step that can fail (memory
          // pressure, an environment without a usable implementation). Unguarded
          // it escaped the `try` below and hit the outer `.catch(() => null)`, so
          // the whole card resolved to null and the farewell share silently lost
          // its PNG — strictly worse than the photo-less fallback this path is
          // supposed to degrade to (#660). Treat it as one more media failure:
          // `data` stays `base` and the standings composition still renders.
          try {
            objectUrl = URL.createObjectURL(media);
          } catch {
            objectUrl = null;
          }
        }
        if (objectUrl) {
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
    const entry: WarmedCard = { key, promise, settled: false, blob: null };
    warmedCard.current = entry;
    // Mutating the entry (rather than checking identity here) is deliberate:
    // a superseded entry recording its own result is harmless, because every
    // READ goes through `warmedCard.current`, whose key must match the card
    // the tap is about to share.
    void promise.then((rendered) => {
      entry.settled = true;
      entry.blob = rendered;
    });
    return promise;
  };

  const shareFinalStandings = async () => {
    const actedEventId = EVENT_ID;
    // NOTHING is awaited before `shareCardBlob` (#712 round 3). Start (or
    // reuse) the render, then take its blob ONLY if it has already settled:
    // an unsettled render costs the image, never the share. `shareCardBlob`
    // is therefore invoked in the same turn as the tap, so `navigator.share`
    // runs while the transient activation is unambiguously alive — the
    // structural version of the guarantee round 2's four-second budget only
    // approximated. The cached promise keeps rasterizing either way, so a
    // second tap gets the image.
    void warmShareCard();
    const warmed = warmedCard.current;
    const blob = warmed?.settled === true ? warmed.blob : null;
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
      if (EVENT_ID === actedEventId) {
        track('share_click', { surface: 'farewell' });
      }
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

  // ONE eager render as soon as sharing is allowed (#712 round 3) — the
  // Celebration treatment, and for the Celebration reason: the payload is
  // FROZEN here (`buildPodium` excludes the farewell Day's own marks, the
  // award is a persisted record), so pre-rendering it cannot bake in
  // something a later snapshot would change. It is what keeps the round-3
  // no-wait tap from costing the image on the common cold mobile tap, where
  // `onPointerDown` gives the render only the length of the press.
  //
  // Deliberately ONE, guarded by a ref rather than by dep-list identity:
  // that caps the farewell view's eager cost at a single fetch+rasterize even
  // if the payload key later churns, so this cannot become the per-snapshot
  // re-rasterization the Leaderboard refused to take on (§ Eager pre-render).
  // A post-eager key change simply falls back to warm-on-intent, as before.
  useEffect(() => {
    if (!shareReady || eagerRenderStarted.current) return;
    eagerRenderStarted.current = true;
    void warmShareCard();
    // Intentionally re-checked on every commit: `warmShareCard` closes over
    // live podium/award values, and the ref above — not the dep list — is
    // what makes it run once.
  });

  const share = shareReady
    ? { onShare: () => void shareFinalStandings(), onWarm: () => void warmShareCard() }
    : undefined;

  return (
    <FarewellPodiumView podium={podium} dayLabel={dayLabel} share={share} mostLoved={mostLoved} />
  );
}
