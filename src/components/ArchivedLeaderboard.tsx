import { THEMES } from '../theme/themes';
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
 * The archived Leaderboard (#134, specs/post-sailing-archive.md): the frozen
 * final standings and the First-to-BINGO hall of fame, rendered from
 * `EventDoc.archive` alone.
 *
 * READ-ONLY IN THE STRONGEST SENSE AVAILABLE TO A COMPONENT — it renders one
 * stored object and subscribes to nothing. There is no `useLeaderboard`
 * subscription here, no `sortPlayers`, no `cruiseFirstBingoUid`, and no
 * per-Day-meta read: every number, name and honour was decided once, at the
 * archive, by `buildEventArchive`. That is the whole point of the freeze (ADR
 * 0001 — a social record, not a ledger to re-derive), and it is also what makes
 * "opened later, the standings persist unchanged" true rather than merely
 * likely: there is no live input that could move them.
 *
 * The enforcement half is NOT here. Hiding controls is a rendering decision a
 * direct client write bypasses; `firestore.rules` and `storage.rules` deny
 * gameplay writes on an archived Event, and the rules tests are what hold that
 * (`specs/path-addressing-and-root.md` § D8 makes the same demand).
 *
 * The Share Card stays (issue #36's on-device rasteriser, ADR 0005 — no
 * crawler pages): a frozen leaderboard is the most shareable thing the Event
 * ever produces, and it prints from the same frozen rows the page shows.
 */
export default function ArchivedLeaderboard({
  event,
  archive,
}: {
  event: Pick<EventDoc, 'name' | 'days' | 'archivedAt'> | null | undefined;
  archive: EventArchive;
}) {
  const firstBingoUid = archive.firstBingo?.uid;
  const dayChipLabel = (dayIndex: number): string => {
    const d = event?.days?.find((day) => day.index === dayIndex);
    const emoji = d ? (THEMES.find((t) => t.id === d.theme)?.emoji ?? '') : '';
    return `${emoji ? `${emoji} ` : ''}D${dayIndex + 1}`;
  };

  const shareLeaderboard = async () => {
    const actedEventId = EVENT_ID;
    const ranked = archive.standings.map((row, i) => toShareRow(row, i + 1, firstBingoUid));
    const rows = ranked.slice(0, MAX_SHARE_ROWS);
    if (firstBingoUid && !rows.some((r) => r.uid === firstBingoUid)) {
      const pinned = ranked.find((r) => r.uid === firstBingoUid);
      if (pinned) rows.push(pinned);
    }
    const blob = await renderLeaderboardShareCard({
      eventName: event?.name ?? shareCardAppName(),
      rows,
      contextLine: event?.name ? `${event.name} · Final standings` : undefined,
      statLine: 'Final standings',
    }).catch(() => null);
    if (EVENT_ID !== actedEventId) return;
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
              {archive.firstBingo
                ? `${archive.firstBingo.displayName} · ${when(archive.firstBingo.at)}`
                : 'No one got there.'}
            </div>
          </div>
        </div>
        {archive.dailyHonors.length > 0 && (
          <ul className="lb-honors-strip">
            {archive.dailyHonors.map((h) => (
              <li key={h.dayIndex} className="lb-honor">
                <span className="lb-honor-day">
                  <EmojiText text={dayChipLabel(h.dayIndex)} />
                </span>
                <span className="lb-honor-name">{h.displayName}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {archive.standings.length === 0 ? (
        <div className="lb-empty muted">No players were on the board.</div>
      ) : (
        <div className="list">
          {archive.standings.map((row, i) => {
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
        {archive.playerCount > archive.standings.length
          ? `Showing the top ${archive.standings.length} of ${archive.playerCount} players. `
          : ''}
        Frozen when the {editionLexicon().occasion} was archived—nothing here changes again.
      </p>
      <div className="lb-actions">
        <button type="button" className="btn" onClick={shareLeaderboard}>
          Share final standings
        </button>
      </div>
    </>
  );
}
