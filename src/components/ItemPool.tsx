import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useItems, useMyPendingItems } from '../hooks/useData';
import { addItem, checkItemRateLimit, itemRateLimitRemainingMs, reportItem } from '../data/api';
import { track } from '../analytics';
import LoadingState from './LoadingState';
import { editionBrand } from '../editions';
import { useAdultContent } from '../hooks/useAdultContent';
import { EVENT_ID } from '../firebase';

// Pre-sail framing (ADR 0003): a Board freezes the moment a Player joins, so
// a Prompt added afterward can never land on THAT Player's own card — it only
// ever joins the pool for a FUTURE deal. Mid-cruise adds are allowed (and
// still take effect for late joiners / future Events); they are just mostly
// inert on cards already dealt, which is expected, not a bug.
// Whole-string per Edition (#608): the DEADLINE is the cruise-coded part
// ("before we sail"), and it has no neutral token — a general Event's deadline
// is the first deal, not a departure.
const presailNote = (): string => editionBrand().promptDeadlineNote;

// Phase 1.5 approval flow (#210, daily-cards-spec § "Item pools and the approval
// flow"): a companion caption to `presailNote`, not a replacement — that one
// explains freeze-on-deal, this one explains the NEW admin-review gate a
// submission passes through before it can ever be dealt.
const APPROVAL_NOTE = "New prompts go to admin review before they join the pool—yours will show here as “pending review” until then.";

// Phase 0 client-side throttle copy — see `checkItemRateLimit` in
// `../data/api` for why this is presentational only, not a security boundary.
const ADD_THROTTLE_MESSAGE = 'Slow down—you can add another prompt in a few seconds.';
const REPORT_THROTTLE_MESSAGE = 'Slow down—you can report again in a few seconds.';

// First-time 🔞 explainer (#610) — the PLAYER half of the ticket, and
// deliberately an EXPLAINER, not a confirm. A player's tick is a request:
// their submission lands `status: 'pending'` (#210) and the #608 derivation
// only counts `status: 'active'`, so nothing about the Event's posture changes
// until an admin approves it — the consequential-action confirm lives on THAT
// flip (`admin/AdultContentConfirm`), not here. This sheet just tells a
// first-time tagger what the tag means, once per Event, and never gates the
// checkbox itself.
//
// Event-keyed localStorage, the established one-time-explainer pattern
// (`gcb.coachOverlay.${eventId}.dismissedAt`, `gcb.seen.reshuffleIntro`).
// try/catch falls OPEN — private-mode/storage-unavailable shows the explainer
// on every tick rather than never: annoying beats invisible, the same
// direction CoachOverlay and LaunchIntro take.
const explicitTagSeenKey = (eventId: string): string => `gcb.seen.explicitTag.${eventId}`;
function hasSeenExplicitTag(eventId: string): boolean {
  try {
    return localStorage.getItem(explicitTagSeenKey(eventId)) !== null;
  } catch {
    return false;
  }
}
function markExplicitTagSeen(eventId: string): void {
  try {
    localStorage.setItem(explicitTagSeenKey(eventId), String(Date.now()));
  } catch {
    /* nothing to persist */
  }
}

export default function ItemPool() {
  const { user } = useAuth();
  const { items, loading } = useItems();
  // The 🔞 tag is a CATEGORY within an adults-only pool, not a warning label
  // (#608): on an Event with no adult content there is nothing to categorise,
  // so the control is hidden rather than shown-and-inert. `spicy` then stays
  // false on every submission, which is what the derivation reads.
  const adult = useAdultContent();
  // The submitter's own pending submissions (#210): `useItems` reads only
  // `status == 'active'`, so a fresh `pending` add would otherwise vanish from
  // this list the instant it lands. Merged in below, tagged "pending review".
  const { items: myPending } = useMyPendingItems(user?.uid);
  const [text, setText] = useState('');
  const [spicy, setSpicy] = useState(false);
  // The first-time explainer (#610). State, not a render-time storage read:
  // it opens on the TICK (the moment of first use), not on mount — a player
  // who never touches the tag never sees it.
  const [showExplicitIntro, setShowExplicitIntro] = useState(false);
  const [addThrottled, setAddThrottled] = useState(false);
  const [reportThrottled, setReportThrottled] = useState(false);
  const addTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Un-throttle timers are real (not just presentational math) so the button
  // re-enables on its own once the window passes — clear them on unmount so a
  // throttled ItemPool that unmounts mid-window never calls setState after
  // unmount (tab switch away from Prompts while throttled).
  useEffect(
    () => () => {
      if (addTimer.current) clearTimeout(addTimer.current);
      if (reportTimer.current) clearTimeout(reportTimer.current);
    },
    [],
  );

  const add = async () => {
    if (!user || !text.trim()) return;
    const now = Date.now();
    const key = `add:${user.uid}`;
    if (!checkItemRateLimit(key, now)) {
      setAddThrottled(true);
      if (addTimer.current) clearTimeout(addTimer.current);
      // Arm for the ACTUAL time left on the guard's window (anchored to the
      // last SUCCESSFUL add), not a full re-armed ITEM_RATE_LIMIT_MS from
      // THIS blocked attempt — the latter would drift the control's re-enable
      // later than checkItemRateLimit itself expires (Codex P2, PR #92).
      addTimer.current = setTimeout(() => setAddThrottled(false), itemRateLimitRemainingMs(key, now));
      return;
    }
    try {
      await addItem(user.uid, text, adult && spicy);
      track('add_item');
      setText('');
      setSpicy(false);
    } catch (e) {
      console.error(e);
    }
  };

  const report = (id: string) => {
    if (!user) return;
    const now = Date.now();
    const key = `report:${user.uid}`;
    if (!checkItemRateLimit(key, now)) {
      setReportThrottled(true);
      if (reportTimer.current) clearTimeout(reportTimer.current);
      // Same real-remaining-time arming as `add` above, for the same reason.
      reportTimer.current = setTimeout(() => setReportThrottled(false), itemRateLimitRemainingMs(key, now));
      return;
    }
    reportItem(id).catch(console.error);
    track('report_item');
  };

  return (
    <div>
      {/* `data-unsaved-work` while a suggestion is half-typed (Codex P2 round 5,
          PR #720): it lives only in `text`, so an automatic post-deploy reload
          would eat it. See `midInteraction` in src/swClientBridge.ts.
          Trimmed, matching the Add button's own `disabled` predicate below
          (post-review #750/#755/#758): whitespace-only text is not something
          Add can commit or clear, so marking it as unsaved work would pin the
          tab to a condemned build with no way to release the marker. */}
      <div className="addbar" data-unsaved-work={text.trim() !== '' || undefined}>
        <input
          className="input"
          maxLength={80}
          placeholder="Add a prompt…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Gate Enter with the SAME `addThrottled` state the Add button's
            // `disabled` uses, so the keyboard path can never submit while
            // the UI is showing "throttled" — it now expires in lockstep
            // with the button instead of re-checking the guard on its own.
            if (e.key === 'Enter' && !addThrottled) add();
          }}
        />
        <button className="btn primary" onClick={add} disabled={!text.trim() || addThrottled}>
          Add
        </button>
        {adult && (
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={spicy}
              onChange={(e) => {
                const next = e.target.checked;
                // The tick lands regardless — this is an explainer over the
                // player's (reversible, non-consequential) choice, never a
                // gate in front of it. Only a CHECK can open it: unticking
                // needs no explanation.
                setSpicy(next);
                if (next && !hasSeenExplicitTag(EVENT_ID)) setShowExplicitIntro(true);
              }}
            />{' '}
            🔞 Spicy
          </label>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        {presailNote()} {items.length} in the pool.
      </p>
      <p className="muted" style={{ fontSize: 12 }}>
        {APPROVAL_NOTE}
      </p>
      {addThrottled && (
        <p className="muted" role="alert" style={{ fontSize: 12 }}>
          {ADD_THROTTLE_MESSAGE}
        </p>
      )}
      {loading ? (
        <LoadingState label="Fetching prompts…" />
      ) : (
        <div className="list">
          {items.map((it) => (
            <div key={it.id} className="row">
              <div className="grow">
                <div className="name" style={{ fontWeight: 500 }}>
                  {it.text}
                </div>
              </div>
              <button
                className="iconbtn"
                title="Report"
                disabled={reportThrottled}
                onClick={() => report(it.id)}
              >
                ⚑
              </button>
            </div>
          ))}
          {/* Own pending submissions (#210): visible ONLY to their submitter,
              never to other Players (mirrors the read rule's carve-out) — no
              Report control, since reporting your own not-yet-live Prompt is
              meaningless. */}
          {myPending.map((it) => (
            <div key={it.id} className="row">
              <div className="grow">
                <div className="name" style={{ fontWeight: 500 }}>
                  {it.text}
                  <span className="pill">pending review</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {reportThrottled && (
        <p className="muted" role="alert" style={{ fontSize: 12 }}>
          {REPORT_THROTTLE_MESSAGE}
        </p>
      )}
      {/* The same `.sheet`/`.sheet-backdrop` shell as CoachOverlay and
          LaunchIntro — the repo's one-time-explainer shape — with its own
          identity class (the LaunchIntro discipline: `.coach-overlay` is that
          overlay's IDENTITY, not a shared skin). One CTA, no cancel: there is
          nothing to cancel, the tick already landed and stays reversible.
          Copy carries no Edition-coded token, so it reads correctly in every
          register (#608) — the substance must not change between Editions. */}
      {showExplicitIntro && (
        <div className="sheet-backdrop explicit-tag-intro-backdrop">
          <div
            className="sheet explicit-tag-intro"
            role="dialog"
            aria-modal="true"
            aria-label="What the 🔞 tag does"
          >
            <p className="sheet-title">What the 🔞 tag does</p>
            <p>
              It marks a prompt as explicit. Explicit prompts only reach players who have confirmed
              they&rsquo;re 18 or older.
            </p>
            <p>
              An admin reviews every suggestion before it can be dealt&mdash;tagging it
              doesn&rsquo;t put it on anyone&rsquo;s card by itself.
            </p>
            <div className="sheet-actions">
              <button
                type="button"
                className="btn primary block"
                onClick={() => {
                  // Mark seen on DISMISS, not on open (the CoachOverlay
                  // pattern): a sheet the player never acknowledged — tab
                  // closed mid-read — shows again next time.
                  markExplicitTagSeen(EVENT_ID);
                  setShowExplicitIntro(false);
                }}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
