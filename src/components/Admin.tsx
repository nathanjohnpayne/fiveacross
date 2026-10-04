import { useEffect, useState } from 'react';
import { privateCacheRecoveryHref } from '../auth/privateCacheRecoveryNavigation';
import { useLocation, useNavigate } from 'react-router';
import { usePrivateFirestore } from '../hooks/usePrivateFirestore';
import { useOnline } from '../hooks/useOnline';
import { useAuth } from '../auth/AuthContext';
import {
  useAdminEventDoc,
  usePendingClaims,
  usePendingItems,
  useReportedProofs,
  useAllItems,
} from '../hooks/useData';
import { adminSectionFromPath, type AdminSection } from './admin/route';
import AdminSheet from './admin/AdminSheet';
import AdminHub from './admin/AdminHub';
import ReviewQueue, { type QueueRow } from './admin/ReviewQueue';
import GameSettings from './admin/GameSettings';
import SchedulePanel from './admin/SchedulePanel';
import PromptPool from './admin/PromptPool';
import PlayersPanel from './admin/PlayersPanel';
import MessagesPanel from './admin/MessagesPanel';

/**
 * The admin console (specs/admin-console-ia.md): a hub-and-detail IA over REAL
 * routes. `/more/admin` renders the hub — five section cards with live badges —
 * and each card opens a detail surface at `/more/admin/<section>`, so the
 * browser/PWA back button walks detail → hub → More. This component is the
 * orchestrator: it owns the subscriptions (the same four the old tabbed console
 * held — event doc, pending claims, reported proofs, all items — plus the
 * pending-approvals query the old Approvals tab opened), derives the badge
 * math once, resolves the section from the URL, and renders the matching
 * section inside the shared `AdminSheet` chrome. The sections live in
 * `./admin/*` and use the captured private-session Admin write paths.
 */

// Match the established bootstrap wait: availability times out after 10s,
// while a later confirmed answer can still establish Admin eligibility.
const ADMIN_EVENT_WAIT_MS = 10_000;

/** A current private-read scope has a bounded availability wait, never authority. */
function useBoundedPrivateWait(waitKey: string | null): boolean {
  const [expiredWait, setExpiredWait] = useState<string | null>(null);
  useEffect(() => {
    setExpiredWait(null);
    if (waitKey === null) return;
    let active = true;
    const timer = setTimeout(() => { if (active) setExpiredWait(waitKey); }, ADMIN_EVENT_WAIT_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [waitKey]);
  return waitKey !== null && expiredWait === waitKey;
}

const SECTION_TITLES: Record<AdminSection, string> = {
  queue: 'Review queue',
  settings: 'Game settings',
  schedule: 'Schedule',
  pool: 'Prompt pool',
  players: 'Players',
  messages: 'Messages',
};

/**
 * The admin gate shell. Only the current server Event doc through the memory-only private session
 * is subscribed HERE — the admin-only queue/item/proof/claim subscriptions
 * live in `AdminConsole`, which mounts only once the confirmed roster admits the
 * current private-session subject. A non-admin
 * deep link gets a loading/reconnect/unavailable state until the current private
 * answer establishes eligibility; a confirmed non-admin gets "Admins only."
 * without ever
 * opening a listener `firestore.rules` would deny (Codex P2, PR #410: the old
 * console relied on More's own gate for this; the route-driven mount cannot).
 */
export default function Admin() {
  const { user } = useAuth();
  // Only the memory client's current, fully server-committed Event answer
  // qualifies the Admin gate and #1151's archive gate. Cache-origin and pending
  // snapshots remain unknown; the old persistent gameplay-cache gate explains
  // the same metadata checks historically, not this private listener's storage.
  const { key: eventKey, data: event, loading, serverResolved, hasServerData, fromCache, hasPendingWrites } = useAdminEventDoc();
  const eventConfirmed = hasServerData && !fromCache && !hasPendingWrites;
  const navigate = useNavigate();
  const session = usePrivateFirestore();
  const online = useOnline();
  const answerUnavailable = serverResolved && !loading && !hasServerData;
  const waitKey = user && online && session.db && session.uid === user.uid
    && !session.failed && !session.recoveryRequired && !eventConfirmed && !answerUnavailable
    ? JSON.stringify([eventKey, user.uid, session.generation]) : null;
  const waitExpired = useBoundedPrivateWait(waitKey);
  if (user && session.recoveryRequired) {
    return <AdminSheet title="Admin" onDone={() => navigate('/more', { replace: true })}>
      <p>Private views require attended device recovery. Recover and verify every account’s queued Marks online first.</p>
      <a href={privateCacheRecoveryHref(window.location.href)}>Finish device recovery</a>
    </AdminSheet>;
  }

  // Availability never establishes authority. Admin-only subscriptions stay
  // unmounted until the subject-bound private session has a confirmed roster.
  const unavailable = 'Admin is unavailable. Reload and try again.';
  const gateMessage = !user ? 'Sign in to use Admin.'
    : session.failed ? unavailable
    : !online ? 'Reconnect to use Admin.'
    : session.uid !== user.uid || !session.db ? 'Loading Admin…'
    : !eventConfirmed ? (answerUnavailable || waitExpired ? unavailable : 'Loading Admin…')
    : !event ? unavailable
    : !event.admins?.includes(user.uid) ? 'Admins only.'
    : null;
  if (gateMessage !== null || !user) {
    return (
      <AdminSheet title="Admin" onDone={() => navigate('/more', { replace: true })}>
        <div className="center muted" role="status">{gateMessage}</div>
      </AdminSheet>
    );
  }
  return <AdminConsole userUid={user.uid} eventKey={eventKey} event={event} eventConfirmed={eventConfirmed} />;
}

function AdminConsole({
  userUid,
  eventKey,
  event,
  eventConfirmed,
}: {
  userUid: string;
  eventKey: string;
  event: ReturnType<typeof useAdminEventDoc>['data'];
  /** Whether THIS Event snapshot is fully server-committed — threaded straight
   *  through to `ArchiveEvent`, whose arming gate (#1151) needs it. */
  eventConfirmed: boolean;
}) {
  // `hasServerData` rides along for #1151's drain gate: a not-yet-arrived queue
  // reads as zero pending Claims, and a gate that passes vacuously is no gate.
  const claimState = usePendingClaims();
  const { claims, hasServerData: claimsLoaded } = claimState;
  const proofState = useReportedProofs();
  const { flagged } = proofState;
  const itemState = useAllItems();
  const { items } = itemState;
  const approvalState = usePendingItems();
  const { items: pendingItems } = approvalState;
  const session = usePrivateFirestore();
  // Empty private rows mean all clear only after every source is confirmed.
  // Failure/unknown data withholds the queue and its empty badges/actions.
  const queueSources = [claimState, proofState, itemState, approvalState];
  const queueFailed = queueSources.some((source) => source.failed);
  const queueConfirmed = queueSources.every((source) => source.hasServerData === true);
  const queueWaitKey = !queueFailed && !queueConfirmed
    ? JSON.stringify([eventKey, userUid, session.generation, 'queue']) : null;
  const queueWaitExpired = useBoundedPrivateWait(queueWaitKey);
  const queueStatus = queueFailed || queueWaitExpired ? 'unavailable' : queueConfirmed ? 'ready' : 'loading';
  const queueMessage = queueStatus === 'unavailable'
    ? 'Review queue is unavailable. Reload and try again.' : 'Loading review queue…';
  const location = useLocation();
  const navigate = useNavigate();

  const section = adminSectionFromPath(location.pathname) ?? 'hub';
  // History discipline (Codex + CodeRabbit P2/Major, PR #410): dismissal must
  // never leave admin entries UNDER the new location, or browser Back after
  // Done/`‹ Admin` walks straight back into what was just dismissed.
  //
  // `adminPops` rides each admin entry's history state: the number of pops
  // that reach the pre-admin entry (More pushes it as 1; each hub → detail
  // push increments). Done POPS the whole admin run in one go, and `‹ Admin`
  // consumes the detail entry (navigate(-1)). A deep link has no such state
  // (its admin entry was not pushed by this app run) — there the whole
  // session REPLACES in place (see openSection below), Done replaces with
  // More, and `‹ Admin` replaces back to the hub, never navigating out of
  // the app.
  const adminPops = (location.state as { adminPops?: number } | null)?.adminPops;
  const done = () => {
    if (adminPops != null) navigate(-adminPops);
    else navigate('/more', { replace: true });
  };
  const back = () => {
    if (adminPops != null) navigate(-1);
    else navigate('/more/admin', { replace: true });
  };
  // Without adminPops (a deep-link origin), intra-admin navigation REPLACES:
  // the whole admin session occupies its single deep-linked history entry, so
  // Done's replace-with-/more leaves no admin entry underneath for browser
  // Back to reopen (Phase 4b P2, PR #410). The tradeoff — browser Back from a
  // deep-linked detail leaves the app instead of walking to the hub — matches
  // the entry's real provenance; the in-app flow (adminPops present) keeps
  // full push/pop history.
  const openSection = (s: AdminSection) =>
    navigate(`/more/admin/${s}`, adminPops != null ? { state: { adminPops: adminPops + 1 } } : { replace: true });

  // The community auto-hide threshold (ADR 0004). Unsuppressed content whose
  // reportCount has REACHED it is filtered from Player Feed/pool surfaces
  // (useProofFeed / useItems), while restored/cleared incarnations retain their
  // report-hide override. Admin queues keep either posture reachable for review.
  const threshold = event?.settings?.reportHideThreshold;
  const bannedUids = event?.bannedUids ?? [];
  // Prompts awaiting approval (#200 schema, #210 write path) — the SAME count
  // the More menu's Admin row badges (`usePendingItemCount`), derived here from
  // the console's own already-subscribed `items` (no extra listener) so the
  // console and the badge can never disagree.
  const pendingCount = items.filter((it) => it.status === 'pending').length;
  // #282 (Codex P2): prompt ids frozen into an UNLOCKED Day's stamped
  // snapshot — their text is deal-hydrated, so edits would split that Day's
  // squares by open time. Locked Days only; a future (locked) Day's snapshot
  // doesn't exist yet, and text stays editable until its Day opens.
  const nowMs = Date.now();
  const lockedSnapshotItemIds = new Set(
    (event?.days ?? [])
      .filter((d) => d.unlockAt <= nowMs)
      .flatMap((d) => d.snapshotItemIds ?? []),
  );
  // Prompts needing moderation attention: reported at least once, or already
  // hard-hidden. Derived from useAllItems (already subscribed) so the queue
  // opens NO extra listener, and UNfiltered by the threshold so an auto-hidden
  // Prompt still surfaces here.
  const reportedItems = items.filter((it) => it.reportCount > 0 || it.status === 'hidden');
  // Merge reported Proofs and Prompts into ONE Reports group ordered
  // OLDEST-FIRST across both kinds (createdAt asc) — the merged inbox's triage
  // order (specs/admin-console-ia.md § "Review queue"), matching the Approvals
  // and Pending-claims groups and superseding the old most-reported-first sort.
  const reports: QueueRow[] = [
    ...flagged.map((p): QueueRow => ({ kind: 'proof', sortAt: p.createdAt, proof: p })),
    ...reportedItems.map((it): QueueRow => ({ kind: 'item', sortAt: it.createdAt, item: it })),
  ].sort((a, b) => a.sortAt - b.sortAt);

  const title = section === 'hub' ? 'Admin' : SECTION_TITLES[section];

  return (
    <AdminSheet title={title} onBack={section === 'hub' ? undefined : back} onDone={done}>
      {section === 'hub' && (
        <AdminHub
          queueStatus={queueStatus}
          event={event}
          reportCount={reports.length}
          approvalCount={pendingItems.length}
          claimCount={claims.length}
          itemCount={items.length}
          pendingCount={pendingCount}
          onOpen={openSection}
        />
      )}
      {section === 'queue' && (queueStatus !== 'ready'
        ? <p className="center muted" role="status">{queueMessage}</p>
        : <ReviewQueue
          event={event}
          reports={reports}
          pendingItems={pendingItems}
          claims={claims}
          adminUid={userUid}
        />
      )}
      {section === 'settings' && (
        <GameSettings
          event={event}
          eventConfirmed={eventConfirmed}
          pendingClaims={claims}
          pendingClaimsLoaded={claimsLoaded}
        />
      )}
      {section === 'schedule' && <SchedulePanel days={event?.days ?? []} />}
      {section === 'pool' && (
        <PromptPool
          items={items}
          threshold={threshold}
          pendingCount={pendingCount}
          lockedSnapshotItemIds={lockedSnapshotItemIds}
          adminUid={userUid}
        />
      )}
      {section === 'players' && <PlayersPanel bannedUids={bannedUids} />}
      {section === 'messages' && <MessagesPanel adminUid={userUid} days={event?.days ?? []} />}
    </AdminSheet>
  );
}
