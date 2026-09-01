import { useState } from 'react';
import { useNotices } from '../hooks/useData';
import { EVENT_ID } from '../firebase';
import type { NoticeDoc } from '../types';

/**
 * The Card-tab Notice banner (specs/admin-messages.md, #frame-feed-notice): while
 * an admin Notice is pinned, the Card tab shows it ONCE as a dismissible banner
 * (✕) above the Board. Dismissal is PER-DEVICE (localStorage, keyed by notice id)
 * and hides ONLY the banner — the Notice stays in the Feed for latecomers, so a
 * player who dismisses the heads-up can still scroll to it. Mirrors the CoachOverlay
 * / InstallPrompt persistence pattern: a `gcb.*`-namespaced key whose read/write
 * fall open on a storage error (private mode), never throwing.
 */

const dismissKey = (eventId: string, noticeId: string): string =>
  `gcb.notice.${eventId}.${noticeId}.dismissedAt`;
const legacyDismissKey = (noticeId: string): string => `gcb.notice.${noticeId}.dismissedAt`;
const dismissedWithoutStorage = new Set<string>();

/**
 * Whether this device has dismissed the banner for `noticeId`. try/catch —
 * storage-unavailable falls open (returns false), the same fallback CoachOverlay.tsx
 * and InstallPrompt.tsx use for their keys.
 */
export function isNoticeBannerDismissed(noticeId: string, eventId = EVENT_ID): boolean {
  const key = dismissKey(eventId, noticeId);
  if (dismissedWithoutStorage.has(key)) return true;
  try {
    const scopedDismissal = localStorage.getItem(key);
    if (scopedDismissal !== null) {
      dismissedWithoutStorage.add(key);
      return true;
    }

    // Before dismissals were Event-scoped, a notice id was global. Consume
    // that value into the Event active during the upgrade so it is preserved
    // without leaking the same dismissal into every other Event.
    const legacyKey = legacyDismissKey(noticeId);
    const legacyDismissal = localStorage.getItem(legacyKey);
    if (legacyDismissal === null) return false;

    dismissedWithoutStorage.add(key);
    try {
      localStorage.setItem(key, legacyDismissal);
      localStorage.removeItem(legacyKey);
    } catch {
      // The in-memory key still preserves the dismissal for this Event during
      // the current session when storage becomes unavailable mid-migration.
    }
    return true;
  } catch {
    return false;
  }
}
/** Persist this device's dismissal of the banner for `noticeId` (no-op on error). */
function markNoticeDismissed(noticeId: string, eventId: string): void {
  const key = dismissKey(eventId, noticeId);
  // The App subtree is keyed by Event, so this module fallback—not component
  // state—is what retains a private-mode dismissal across A → B → A remounts.
  dismissedWithoutStorage.add(key);
  try {
    localStorage.setItem(key, String(Date.now()));
  } catch {
    /* nothing to persist */
  }
}

/** Test-only. */
export function __resetNoticeBannerDismissalsForTests(): void {
  dismissedWithoutStorage.clear();
}

/**
 * The presentational + dismissal half, pure over its `notices` prop so it unit-tests
 * without a Firestore mock (the container below supplies the live subscription). Of
 * the PINNED Notices — `notices` arrives newest-first from `useNotices` — it shows
 * the newest one this device has not dismissed; dismissing it reveals the next
 * still-undismissed pinned Notice, if any. An unpinned or fully-dismissed set
 * renders nothing.
 */
export function NoticeBannerView({ notices }: { notices: NoticeDoc[] }) {
  const eventId = EVENT_ID;
  const [dismissedByEvent, setDismissedByEvent] = useState<ReadonlyMap<string, readonly string[]>>(
    () => new Map(),
  );
  const dismissedThisMount = dismissedByEvent.get(eventId) ?? [];
  const active = notices.find(
    (n) =>
      n.pinned &&
      !dismissedThisMount.includes(n.id) &&
      !isNoticeBannerDismissed(n.id, eventId),
  );
  if (!active) return null;

  const handleDismiss = () => {
    markNoticeDismissed(active.id, eventId);
    setDismissedByEvent((previous) => {
      const next = new Map(previous);
      next.set(eventId, [...(previous.get(eventId) ?? []), active.id]);
      return next;
    });
  };

  return (
    <div className="notice-banner" role="status">
      <button
        type="button"
        className="notice-banner-dismiss"
        aria-label="Dismiss notice"
        onClick={handleDismiss}
      >
        ✕
      </button>
      <div className="notice-banner-title">{active.title}</div>
      <div className="notice-banner-body">{active.body}</div>
    </div>
  );
}

/** Live container: subscribes to the Event's Notices and renders the banner. */
export default function NoticeBanner() {
  const { notices } = useNotices();
  return <NoticeBannerView notices={notices} />;
}
