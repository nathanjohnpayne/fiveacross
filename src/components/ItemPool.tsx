import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useItems, useMyPendingItems } from '../hooks/useData';
import { addItem, checkItemRateLimit, itemRateLimitRemainingMs, reportItem } from '../data/api';
import { track } from '../analytics';
import LoadingState from './LoadingState';
import { editionBrand } from '../editions';
import { useAdultContent } from '../hooks/useAdultContent';

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
      <div className="addbar">
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
            <input type="checkbox" checked={spicy} onChange={(e) => setSpicy(e.target.checked)} /> 🔞
            Spicy
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
    </div>
  );
}
