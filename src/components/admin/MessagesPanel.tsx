import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useMyPlayer, useNotices } from '../../hooks/useData';
import { resolveDisplayName } from '../../data/api';
import { defaultViewedIndex } from '../DaySwitcher';
import {
  postNotice,
  setNoticePinned,
  deleteNotice,
  editNotice,
  NOTICE_TITLE_MAX,
  NOTICE_BODY_MAX,
} from '../../data/notices';
import AsyncButton from './AsyncButton';
import type { DayDef, NoticeDoc } from '../../types';

/**
 * Admin → Messages (specs/admin-messages.md, #frame-admin-messages): the sixth hub
 * door. Compose a Notice — title + body + a "Pin to Feed + show Card banner" toggle
 * (default on) + one "Post to everyone" button — then a newest-first sent history
 * with quiet Edit / Unpin / Delete controls (the repair-line quiet-controls
 * convention: compact, sentence-case, no primary pill). A broadcast, never a chat:
 * no player picker, no threading, no read receipts.
 */

/**
 * The compose form: mirrors PromptPool's AdminAddItemForm — a local draft, a busy
 * guard, and an inline failure (role=alert) that KEEPS the draft so a retry is one
 * tap (#411, specs/admin-async-feedback.md). Clears only on a settled success.
 */
function ComposeNotice({ adminUid, adminName, days }: { adminUid: string; adminName: string; days: DayDef[] }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const canPost = title.trim().length > 0 && body.trim().length > 0 && !busy;
  // A half-written broadcast lives in these two `useState`s and nowhere else, so
  // an automatic post-deploy reload does not interrupt it — it destroys it
  // (Codex P2 round 5, PR #720). `data-unsaved-work` is the declaration
  // `midInteraction` asks about (src/swClientBridge.ts); it goes on only while
  // there IS a draft, because an admin merely sitting on this panel must not
  // pin the tab to a condemned build forever.
  // Trimmed, matching `canPost` below (post-review #752/#753): whitespace-only
  // title/body can never satisfy `canPost`, so an untrimmed marker would pin
  // the tab to a condemned build with no way for the admin to release it.
  const hasDraft = title.trim() !== '' || body.trim() !== '';

  const submit = async () => {
    if (!canPost) return;
    setBusy(true);
    setFailed(false);
    try {
      // Stamp the current Day at SUBMIT time, not render time (Codex P2, PR #440):
      // a panel left mounted across a scheduled Day unlock would otherwise post
      // under the previous Day. Undefined for a schedule-less Event.
      const dayIndex = days.length ? defaultViewedIndex(days, Date.now()) : undefined;
      await postNotice({ uid: adminUid, displayName: adminName, title, body, pinned, dayIndex });
      setTitle('');
      setBody('');
      setPinned(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-section" data-unsaved-work={hasDraft || undefined}>
      <h3>New message</h3>
      {/* Fields disable while a post is in flight (Codex P2, PR #440) so a newer
          draft composed mid-write can't be erased by the success-clear below. */}
      <input
        className="notice-input"
        value={title}
        maxLength={NOTICE_TITLE_MAX}
        placeholder="Title"
        aria-label="Notice title"
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="notice-input notice-textarea"
        value={body}
        maxLength={NOTICE_BODY_MAX}
        placeholder="What does everyone need to know?"
        aria-label="Notice body"
        rows={4}
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
      />
      <label className="notice-pin-row">
        <span className="grow">
          Pin to Feed + show Card banner
          <span className="notice-pin-sub">Until you unpin or players dismiss the banner</span>
        </span>
        <input
          type="checkbox"
          checked={pinned}
          aria-label="Pin to Feed and show Card banner"
          disabled={busy}
          onChange={(e) => setPinned(e.target.checked)}
        />
      </label>
      <div className="notice-post-row">
        <button className="btn primary" disabled={!canPost} onClick={() => void submit()}>
          Post to everyone
        </button>
        {failed && (
          <span className="pill pill-error" role="alert">
            Didn’t post—try again.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The inline copy editor for one sent Notice (#455): the same fields and caps as
 * Compose, prefilled with the current copy. Save writes and closes; Cancel closes
 * without writing. A rejected save KEEPS the editor open with the draft intact and
 * surfaces an inline `role="alert"` (the #411 / specs/admin-async-feedback.md
 * convention) so a retry is one tap. Only the copy is editable — the byline, Day,
 * and Feed position are immutable, in the rules as well as here.
 */
function EditNoticeRow({ notice, onDone }: { notice: NoticeDoc; onDone: () => void }) {
  const [title, setTitle] = useState(notice.title);
  const [body, setBody] = useState(notice.body);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const canSave = title.trim().length > 0 && body.trim().length > 0 && !busy;
  // Same declaration as Compose, keyed off the same trimmed comparison `save`
  // uses to decide an edit even happened — an editor opened and untouched is
  // not a draft, so it does not hold the tab back.
  const hasDraft = title.trim() !== notice.title || body.trim() !== notice.body;

  const save = async () => {
    if (!canSave) return;
    // Opening the editor and saving without touching anything is a no-op, not a
    // correction: writing here would stamp `editedAt` and mark the Notice "edited"
    // forever on a copy nobody changed (CodeRabbit, PR #456). Compare against the
    // stored copy the same way the writer trims it, so trailing whitespace alone
    // doesn't count as an edit either.
    if (title.trim() === notice.title && body.trim() === notice.body) {
      onDone();
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      await editNotice(notice.id, { title, body });
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row notice-edit-row" data-unsaved-work={hasDraft || undefined}>
      <div className="grow">
        <input
          className="notice-input"
          value={title}
          maxLength={NOTICE_TITLE_MAX}
          aria-label="Edit notice title"
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="notice-input notice-textarea"
          value={body}
          maxLength={NOTICE_BODY_MAX}
          aria-label="Edit notice body"
          rows={4}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="notice-post-row">
          <button className="btn" disabled={!canSave} onClick={() => void save()}>
            Save
          </button>
          <button className="btn" disabled={busy} onClick={onDone}>
            Cancel
          </button>
          {failed && (
            <span className="pill pill-error" role="alert">
              Didn’t save—try again.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One sent-history row: title + a "Day N · Name · 📌 pinned · edited" attribution
 * line, with the quiet Edit / Unpin (when pinned) / Delete controls trailing
 * (AsyncButton — disables in flight, surfaces a failure pill instead of a silent
 * rejection). Tapping Edit swaps the row for the inline copy editor above.
 */
function SentNoticeRow({ notice, days }: { notice: NoticeDoc; days: DayDef[] }) {
  const [editing, setEditing] = useState(false);
  const hasDay = typeof notice.dayIndex === 'number' && days[notice.dayIndex] != null;
  const meta = [
    hasDay ? `Day ${(notice.dayIndex as number) + 1}` : null,
    notice.displayName,
    notice.pinned ? '📌 pinned' : null,
    // Provenance, not a timestamp: an edit is visible but never shouted (#455).
    notice.editedAt !== undefined ? 'edited' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (editing) return <EditNoticeRow notice={notice} onDone={() => setEditing(false)} />;

  return (
    <div className="row notice-sent-row">
      <div className="grow">
        {notice.title}
        <span className="sub">{meta}</span>
      </div>
      <button className="btn" onClick={() => setEditing(true)}>
        Edit
      </button>
      {notice.pinned ? (
        <AsyncButton className="btn" onAction={() => setNoticePinned(notice.id, false)}>
          Unpin
        </AsyncButton>
      ) : (
        <AsyncButton className="btn" onAction={() => setNoticePinned(notice.id, true)}>
          Pin
        </AsyncButton>
      )}
      <AsyncButton className="btn" onAction={() => deleteNotice(notice.id)}>
        Delete
      </AsyncButton>
    </div>
  );
}

export default function MessagesPanel({ adminUid, days }: { adminUid: string; days: DayDef[] }) {
  const { user } = useAuth();
  const { data: player } = useMyPlayer(adminUid);
  const { notices } = useNotices();
  // The posting admin's public identity, resolved the SAME validated way the Feed
  // Moment/Tally writers do (Board.tsx): saved player-row name, else the auth
  // displayName, else 'Anonymous'. Passing the auth fallback (not undefined) means
  // a post fired while the player row is still loading attributes to the admin's
  // real Google name rather than persisting 'Anonymous' onto the Notice
  // (CodeRabbit, PR #440).
  const adminName = resolveDisplayName(player, user?.displayName);

  return (
    <div>
      {/* `days` is threaded (not a precomputed dayIndex) so the compose form
          stamps the CURRENT Day at submit time, not this render (Codex P2, #440). */}
      <ComposeNotice adminUid={adminUid} adminName={adminName} days={days} />
      <div className="admin-section">
        <h3>
          Sent
          {notices.length > 0 && <span className="pill">{notices.length}</span>}
        </h3>
        {notices.length === 0 ? (
          <div className="center muted">No messages yet.</div>
        ) : (
          <div className="list">
            {notices.map((n) => (
              <SentNoticeRow key={n.id} notice={n} days={days} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
