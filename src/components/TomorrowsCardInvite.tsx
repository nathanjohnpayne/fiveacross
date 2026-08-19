import type { DayDef } from '../types';
import { targetableDays } from '../data/communityPrompts';

interface Props {
  /** The Event's Day schedule. A legacy/schedule-less Event has no upcoming
   *  Day to promise, so it renders nothing (`targetableDays` on an empty
   *  array is always empty). */
  days: DayDef[];
  now: number;
  onOpen: () => void;
}

/**
 * The "put it on tomorrow's card" entry point (#559, on #557's Day-targeting
 * model): a lightweight invitation to suggest a Community Prompt. ONE
 * component, mounted on BOTH the Card (Board.tsx) and the Feed
 * (ProofFeed.tsx) — extending both surfaces rather than forking the
 * invitation between them. Hidden once no later eligible Day remains
 * (`targetableDays`): an Event past its last open Day has nothing left to
 * promise a suggestion for, so there is nothing honest to invite here.
 *
 * Copy is fixed by the ticket and CONTEXT.md § Community Prompt: "put it on
 * tomorrow's card" — never "bingo moment" (collides with the Moment domain
 * object).
 *
 * Deliberately does NOT open the submission form itself — tapping it hands
 * off through `onOpen` (both callers wire this to
 * `requestOpenSuggestPanel` + navigate) to the SAME suggestion box that
 * already lives in More → Suggest (`ItemPool.tsx`, #203/#208), rather than
 * forking a second submission UI here.
 */
export default function TomorrowsCardInvite({ days, now, onOpen }: Props) {
  if (targetableDays(days, now).length === 0) return null;
  return (
    <div className="prompt-invite">
      <span className="prompt-invite-copy muted">Got a moment worth sharing?</span>
      <button type="button" className="btn prompt-invite-btn" onClick={onOpen}>
        🙋 Put it on tomorrow&rsquo;s card
      </button>
    </div>
  );
}
