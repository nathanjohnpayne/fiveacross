import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import {
  useEventDoc,
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
 * `./admin/*` and keep every write path exactly as built (UI-only re-housing).
 */

const SECTION_TITLES: Record<AdminSection, string> = {
  queue: 'Review queue',
  settings: 'Game settings',
  schedule: 'Schedule',
  pool: 'Prompt pool',
  players: 'Players',
  messages: 'Messages',
};

/**
 * The admin gate shell. Only the event doc (readable by any signed-in player)
 * is subscribed HERE — the admin-only queue/item/proof/claim subscriptions
 * live in `AdminConsole`, which mounts only once `isAdmin` holds. A non-admin
 * deep link therefore gets the dismissible "Admins only." sheet without ever
 * opening a listener `firestore.rules` would deny (Codex P2, PR #410: the old
 * console relied on More's own gate for this; the route-driven mount cannot).
 */
export default function Admin() {
  const { user } = useAuth();
  const { data: event } = useEventDoc();
  const navigate = useNavigate();

  const isAdmin = !!(user && event?.admins?.includes(user.uid));
  if (!isAdmin || !user) {
    return (
      <AdminSheet title="Admin" onDone={() => navigate('/more', { replace: true })}>
        <div className="center muted">Admins only.</div>
      </AdminSheet>
    );
  }
  return <AdminConsole userUid={user.uid} event={event} />;
}

function AdminConsole({ userUid, event }: { userUid: string; event: ReturnType<typeof useEventDoc>['data'] }) {
  const { claims } = usePendingClaims();
  const { flagged } = useReportedProofs();
  const { items } = useAllItems();
  const { items: pendingItems } = usePendingItems();
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

  // The community auto-hide threshold (ADR 0004 Phase 0). Content whose
  // reportCount has REACHED it is already gone from every Player's Feed/pool
  // (useProofFeed / useItems), yet stays reachable in the Review queue so an
  // Admin can restore or delete it — the whole reason the Admin views skip the
  // filter.
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
          event={event}
          reportCount={reports.length}
          approvalCount={pendingItems.length}
          claimCount={claims.length}
          itemCount={items.length}
          pendingCount={pendingCount}
          onOpen={openSection}
        />
      )}
      {section === 'queue' && (
        <ReviewQueue
          event={event}
          reports={reports}
          pendingItems={pendingItems}
          claims={claims}
          adminUid={userUid}
        />
      )}
      {section === 'settings' && <GameSettings event={event} />}
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
