import { useEffect, useRef } from 'react';
import { track } from '../analytics';
import { shareOrigin } from '../canonicalHost';
import { EVENT_ID } from '../firebase';
import {
  renderLeaderboardShareCard,
  shareCardBlob,
  shareCardAppName,
  type LeaderboardShareRow,
} from './ShareCard';
import { editionBrand, editionLexicon } from '../editions';
import { isBanned } from '../data/moderation';
import Avatar from './Avatar';
import { EmojiText } from './EmojiText';
import type { ArchivedStandingRow, EventArchive, EventDoc } from '../types';

/** Share Card row cap — the same ten the live Leaderboard prints (#444), plus
 *  the pin when its holder ranks outside them. */
const MAX_SHARE_ROWS = 10;

function when(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function archivedOn(at: number | undefined): string {
  if (!at) return '';
  return new Date(at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

function toShareRow(
  row: ArchivedStandingRow,
  rank: number,
  firstBingoUid: string | undefined,
): LeaderboardShareRow {
  return {
    uid: row.uid,
    rank,
    displayName: row.displayName,
    bingoCount: row.bingoCount,
    squaresMarked: row.squaresMarked,
    blackout: row.blackout,
    firstToBingo: row.uid === firstBingoUid,
  };
}

/**
 * The warmed archive card, with its SETTLED state carried alongside the promise
 * — the `FarewellPodium` shape, for the `FarewellPodium` reason (Codex P1, PR
 * #712 round 3). `navigator.share` needs transient user activation, and so does
 * `clipboard.writeText` on Safari and Firefox, so a tap that WAITS on a
 * rasterization can outlive the activation and leave every share leg unable to
 * fire. Only a tap that never waits is structurally safe: the handler reads
 * `blob` (valid only when `settled`) and calls `shareCardBlob` in the same turn
 * as the gesture. A `null` blob on a settled render is fine — it already means
 * "share without the image" downstream.
 */
type WarmedCard = {
  key: string;
  promise: Promise<Blob | null>;
  settled: boolean;
  blob: Blob | null;
};

/**
 * The archived Leaderboard (#134, specs/post-sailing-archive.md): the frozen
 * final standings and the First-to-BINGO hall of fame, rendered from
 * `EventDoc.archive` alone.
 *
 * READ-ONLY IN THE STRONGEST SENSE AVAILABLE TO A COMPONENT — it renders one
 * stored object and SUBSCRIBES TO NOTHING. There is no `useLeaderboard`
 * subscription here, no `sortPlayers`, no `cruiseFirstBingoUid`, and no
 * per-Day-meta read: every number, name and honour was decided once, at the
 * archive, by `buildEventArchive` — down to the LABEL on each honour chip,
 * which the record carries so a Day re-themed after the freeze cannot re-label
 * a frozen honour. That is the whole point of the freeze (ADR
 * 0001 — a social record, not a ledger to re-derive), and it is also what makes
 * "opened later, the standings persist unchanged" true rather than merely
 * likely: nothing here recomputes a stat, a rank or an honour.
 *
 * The enforcement half is NOT here. Hiding controls is a rendering decision a
 * direct client write bypasses; `firestore.rules` and `storage.rules` deny
 * gameplay writes on an archived Event, and the rules tests are what hold that
 * (`specs/path-addressing-and-root.md` § D8 makes the same demand).
 *
 * The Share Card stays (issue #36's on-device rasteriser, ADR 0005 — no
 * crawler pages): a frozen leaderboard is the most shareable thing the Event
 * ever produces, and it prints from the same frozen rows the page shows.
 *
 * MODERATION IS THE ONE LIVE INPUT, and it is not a re-derivation. The freeze
 * deliberately leaves `bannedUids` editable (`firestore.rules`'s write-once
 * clause protects `status`/`archivedAt`/`archive` and nothing else) precisely so
 * a permanent record still has a takedown path (#808). The repository's ban
 * contract is that EVERY public Leaderboard view hides a banned Player
 * (`specs/w2-ban-console.md` § Leaderboard) — the live Leaderboard, the Share
 * Card, and now this — so the CURRENT roster is applied to the STORED rows here.
 *
 * Hidden, never reassigned: a banned Player's row disappears and their honours
 * go blank, and NOTHING is promoted into the vacancy. The record is not
 * recomputed — rank numbers, `playerCount` and every remaining row keep exactly
 * the values the archive stamped — because a ban is a moderation decision about
 * who is shown, never a re-ruling of who won.
 */
export default function ArchivedLeaderboard({
  event,
  archive,
}: {
  // `bannedUids` is the CURRENT roster off the live Event subscription, not a
  // frozen copy: a Player banned after the archive must disappear from here on
  // the next snapshot, and an unban must bring them back. It is the ONLY live
  // Event field this surface reads — `days` came off the Pick when the honour
  // chips started rendering their own frozen label (#1139).
  event: Pick<EventDoc, 'name' | 'archivedAt' | 'bannedUids'> | null | undefined;
  archive: EventArchive;
}) {
  const bannedUids = event?.bannedUids ?? [];
  // The headline honour VACATES when its holder is banned — the hall of fame
  // shows "No one got there." rather than the next-earliest Player, matching
  // `buildEventArchive`'s own ban rule at freeze time.
  const headline =
    archive.firstBingo && !isBanned(archive.firstBingo.uid, bannedUids)
      ? archive.firstBingo
      : null;
  const firstBingoUid = headline?.uid;
  const standings = archive.standings.filter((row) => !isBanned(row.uid, bannedUids));
  const dailyHonors = archive.dailyHonors.filter((h) => !isBanned(h.uid, bannedUids));
  // THE CHIP LABEL COMES OUT OF THE RECORD (Codex P2, PR #1139). It used to be
  // looked up in the LIVE `EventDoc.days` — the one Event field the freeze
  // deliberately leaves editable, since the write-once clause protects `status`,
  // `archivedAt` and `archive` and nothing else — so an Admin re-theming a Day
  // after the archive silently re-labelled a frozen honour, which is exactly
  // what "nothing here changes again" promises it cannot. The label is resolved
  // once, at the freeze, by the live strip's own `dayHonorChipLabel`.
  //
  // The ordinal fallback is for a record written by hand rather than by the
  // serializer: it stays frozen-safe (derived from the honour's own index)
  // rather than reaching back into the live schedule.
  const dayChipLabel = (honor: { dayIndex: number; dayLabel?: string }): string =>
    typeof honor.dayLabel === 'string' && honor.dayLabel !== ''
      ? honor.dayLabel
      : `D${honor.dayIndex + 1}`;

  // The Share Card prints the VISIBLE rows, so a banned Player never appears on
  // a shared card (#108's rule, same as the live Leaderboard's).
  //
  // THE PINNED ELEVENTH ROW FALLS BACK TO `firstBingoRow` (Codex P2, PR #1139).
  // `standings` is a bounded prefix cut by RANK while the headline honour is
  // decided by who bingoed EARLIEST, so past `MAX_ARCHIVED_STANDING_ROWS` the
  // holder this card names in its own headline can be absent from the rows
  // searched here — and the appended row would silently vanish on exactly the
  // Event large enough to have truncated. The serializer keeps their row and
  // their true rank beside the honour for this; the rank is the one the
  // COMPLETE standings held at the freeze, which the retained prefix cannot
  // recompute (and which a later ban above them therefore cannot shift).
  const shareRows = ((): LeaderboardShareRow[] => {
    const ranked = standings.map((row, i) => toShareRow(row, i + 1, firstBingoUid));
    const rows = ranked.slice(0, MAX_SHARE_ROWS);
    if (firstBingoUid && !rows.some((r) => r.uid === firstBingoUid)) {
      const kept = archive.firstBingoRow;
      const pinned =
        ranked.find((r) => r.uid === firstBingoUid) ??
        (kept && kept.uid === firstBingoUid ? toShareRow(kept, kept.rank, firstBingoUid) : null);
      if (pinned) rows.push(pinned);
    }
    return rows;
  })();
  const shareEventName = event?.name ?? shareCardAppName();
  const shareContextLine = event?.name ? `${event.name} · Final standings` : undefined;

  const warmedCard = useRef<WarmedCard | null>(null);
  const eagerRenderStarted = useRef(false);

  /**
   * Start (or reuse) the card rasterization. Keyed on the rendered inputs — the
   * Event name and the VISIBLE rows — so a ban or an unban that changes what the
   * card shows re-renders rather than sharing a card with the wrong Player on
   * it. `.catch(() => null)` lives inside the cached promise (the Leaderboard's
   * own rationale): a render failure resolves null, `shareCardBlob` degrades to
   * the text/URL leg, and an unconsummated hover can never surface as an
   * unhandled rejection.
   */
  const warmShareCard = (): Promise<Blob | null> => {
    const key = JSON.stringify({ shareEventName, shareContextLine, shareRows });
    if (warmedCard.current?.key === key) return warmedCard.current.promise;
    const promise = renderLeaderboardShareCard({
      eventName: shareEventName,
      rows: shareRows,
      contextLine: shareContextLine,
      statLine: 'Final standings',
    }).catch(() => null);
    const entry: WarmedCard = { key, promise, settled: false, blob: null };
    warmedCard.current = entry;
    // Mutating the entry rather than checking identity here is deliberate (the
    // FarewellPodium note): a superseded entry recording its own result is
    // harmless, because every READ goes through `warmedCard.current`, whose key
    // must match the card the tap is about to share.
    void promise.then((rendered) => {
      entry.settled = true;
      entry.blob = rendered;
    });
    return promise;
  };

  // ONE eager render on mount — the `FarewellPodium` treatment, and here it is
  // the obvious one: the archive is IMMUTABLE. `EventDoc.archive` is write-once
  // at the rules boundary, so unlike the live Leaderboard (which re-renders on
  // every roster snapshot, and refused mount-eager rasterization for exactly
  // that reason) there is no per-snapshot churn to pay for. Pre-rendering it
  // cannot bake in anything a later snapshot would change, and it is what lets
  // the no-wait tap below still carry the image on the common cold mobile tap,
  // where `onPointerDown` gives a render only the length of the press.
  //
  // Deliberately ONE, guarded by a ref rather than a dep list: a later ban
  // changes the key and simply falls back to warm-on-intent.
  useEffect(() => {
    if (eagerRenderStarted.current) return;
    eagerRenderStarted.current = true;
    void warmShareCard();
    // Intentionally re-checked on every commit: `warmShareCard` closes over the
    // current rows, and the ref above — not the dep list — is what makes it run
    // once.
  });

  const shareLeaderboard = async () => {
    const actedEventId = EVENT_ID;
    // NOTHING is awaited before `shareCardBlob`. Start (or reuse) the render,
    // then take its blob ONLY if it has already settled: an unsettled render
    // costs the image, never the share. `shareCardBlob` is therefore invoked in
    // the same turn as the tap, so `navigator.share` runs while the transient
    // activation is unambiguously alive. The cached promise keeps rasterizing
    // either way, so a second tap gets the image.
    void warmShareCard();
    const warmed = warmedCard.current;
    const blob = warmed?.settled === true ? warmed.blob : null;
    try {
      await shareCardBlob({
        blob,
        filename: `${editionLexicon().fileSlug}-final-standings.png`,
        title: `${shareCardAppName()}—Final standings`,
        text: `The final ${editionBrand().appName} standings 🏆`,
        url: shareOrigin(),
      });
    } catch {
      // shareCardBlob is designed never to throw; a share failure must not
      // crash the archive either.
    } finally {
      if (EVENT_ID === actedEventId) {
        track('share_click', { surface: 'leaderboard_archive' });
      }
    }
  };

  return (
    <>
      <div className="lb-archived-banner" role="status">
        <div className="name">Final standings</div>
        <div className="sub">
          {`This ${editionLexicon().occasion} is archived${archivedOn(event?.archivedAt) ? ` — ${archivedOn(event?.archivedAt)}` : ''}. The record below is frozen.`}
        </div>
      </div>

      <div className="lb-honors" aria-label="Hall of fame">
        <div className="lb-honors-title">Hall of fame</div>
        <div className="row">
          <div className="grow">
            <div className="name">
              {`⭐ ${editionLexicon().occasionWide} First to BINGO`}
            </div>
            <div className="sub">
              {headline
                ? `${headline.displayName} · ${when(headline.at)}`
                : 'No one got there.'}
            </div>
          </div>
        </div>
        {dailyHonors.length > 0 && (
          <ul className="lb-honors-strip">
            {dailyHonors.map((h) => (
              <li key={h.dayIndex} className="lb-honor">
                <span className="lb-honor-day">
                  <EmojiText text={dayChipLabel(h)} />
                </span>
                <span className="lb-honor-name">{h.displayName}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {standings.length === 0 ? (
        <div className="lb-empty muted">No players were on the board.</div>
      ) : (
        <div className="list">
          {standings.map((row, i) => {
            const isFirst = row.uid === firstBingoUid;
            return (
              <div key={row.uid} className={'row' + (isFirst ? ' leader' : '')}>
                <div className="rank">{i + 1}</div>
                {/* No stored photo URL, by the `MostLovedPhotoWinner` rule: a
                    frozen record must never render a Player's identity from a
                    stale copy they have since changed. Initials it is. */}
                <Avatar name={row.displayName} src={null} />
                <div className="grow">
                  <div className="name">{row.displayName}</div>
                  <div className="sub">
                    {row.bingoCount} bingo{row.bingoCount === 1 ? '' : 's'} · {row.squaresMarked}{' '}
                    squares
                    {row.blackout ? ' · BLACKOUT' : ''} · {when(row.firstBingoAt)}
                  </div>
                </div>
                {isFirst && <div className="badge">⭐ First BINGO</div>}
              </div>
            );
          })}
        </div>
      )}

      <p className="muted lb-footnote">
        {/* The TRUNCATION note keys on the STORED pair — whether the record
            retained a prefix — never on how many rows a ban currently hides, so
            moderating one Player does not make an un-truncated archive claim it
            was cut short. */}
        {archive.playerCount > archive.standings.length
          ? `Showing the top ${standings.length} of ${archive.playerCount} players. `
          : ''}
        Frozen when the {editionLexicon().occasion} was archived—nothing here changes again.
      </p>
      <div className="lb-actions">
        {/* Warm-on-intent as well as mount-eager (the live Leaderboard's three
            handlers): the eager render covers the cold tap, and these cover a
            key change — a ban or unban — that invalidated it. */}
        <button
          type="button"
          className="btn"
          onClick={shareLeaderboard}
          onPointerEnter={() => void warmShareCard()}
          onFocus={() => void warmShareCard()}
          onPointerDown={() => void warmShareCard()}
        >
          Share final standings
        </button>
      </div>
    </>
  );
}
