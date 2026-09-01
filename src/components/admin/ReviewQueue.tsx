import { useEffect, useRef, useState } from 'react';
import { isReportHidden, isBanned, isSystemAuthor } from '../../hooks/useData';
import {
  confirmClaim,
  rejectClaim,
  hideProof,
  restoreProof,
  clearProofReports,
  hideItem,
  restoreItem,
  deleteItem,
  clearItemReports,
  approveItem,
  rejectItem,
  bulkApproveItems,
  setItemSpicy,
  banUser,
  unbanUser,
  type ApprovalPlacement,
} from '../../data/admin';
import { deleteProof } from '../../data/proofs';
import { track } from '../../analytics';
import { EVENT_ID } from '../../firebase';
import AsyncButton from './AsyncButton';
import { tutorialDayIndexSet, ceremonialDayIndexSet, standingsFrozen } from '../../game/logic';
import { normalizePool } from '../../game/pool';
import type { ClaimDoc, DayDef, EventDoc, ItemDoc, ProofDoc } from '../../types';
import { editionBrand } from '../../editions';
import { useAdultContentFlipConfirm } from './AdultContentConfirm';

// One report row, tagged so the render can branch to the per-kind affordances
// (Proof vs Prompt writes) while a single list orders across both kinds.
// Ordered OLDEST-FIRST (createdAt asc) per the merged-inbox contract
// (specs/admin-console-ia.md § "Review queue"), superseding the old report
// queue's most-reported-first sort — triage order is now arrival order, the
// same order the Approvals and Pending-claims groups already use.
export type QueueRow =
  | { kind: 'proof'; sortAt: number; proof: ProofDoc }
  | { kind: 'item'; sortAt: number; item: ItemDoc };

/**
 * Ban / Unban the AUTHOR of a queued row (#108). Banning is an admin action on the
 * CURRENT event: it adds/removes the content owner's uid on the event doc's
 * `bannedUids` roster (`data/admin` banUser/unbanUser → arrayUnion/arrayRemove), the
 * ADR 0004 Phase 0 presentational hide/mute the #113 rules landed. It is a
 * MODERATION / DISPUTE tool, NOT anti-cheat (ADR 0001) and NOT hard access
 * revocation (server-authoritative enforcement is #43/#44) — a banned Player's
 * content is filtered from every PUBLIC/player surface (the read hooks + the deal
 * path), yet stays reachable HERE so an Admin can review it and unban. The label
 * reflects the current banned state.
 */
export function BanControl({
  uid,
  bannedUids,
  admins,
}: {
  uid: string;
  bannedUids: string[];
  admins: string[];
}) {
  // Two kinds of author are NOT bannable, so no Ban control renders for them:
  //  - System/sentinel authors ('seed', the createdBy on every seeded default
  //    Prompt) — Codex P1, PR #122: a single Ban click would add 'seed' to
  //    bannedUids and hide the ENTIRE default pool from useItems AND the deal path.
  //  - Fellow ADMINS — Codex P2, PR #122 round 2: #113's rules REJECT any resulting
  //    bannedUids that overlaps `admins` (firestore.rules `!bannedUids.hasAny(admins)`,
  //    pinned in tests/rules/w2-banned-uids.test.ts), so offering Ban on an
  //    admin-authored row is a doomed action that can only fail with a permission
  //    error. Suppress it so the admin never sees an action that cannot succeed.
  // A banned sentinel stays recoverable via the Players section's Unban (not
  // gated); an admin uid can never be in bannedUids in the first place.
  if (isSystemAuthor(uid) || admins.includes(uid)) return null;
  return isBanned(uid, bannedUids) ? (
    <AsyncButton title="Un-mute this player's content" onAction={() => unbanUser(uid)}>
      Unban author
    </AsyncButton>
  ) : (
    <AsyncButton
      title="Mute this player's content on this event (moderation, not anti-cheat)"
      onAction={() => banUser(uid)}
    >
      Ban author
    </AsyncButton>
  );
}

/**
 * One reported-Proof row in the Reports group. `Clear reports` lifts the ADR
 * 0004 Phase 0 community auto-hide by zeroing reportCount — rendered ONLY when the
 * row is actually auto-hidden (the only state with a hide to lift; Codex P2, PR
 * #107 finding 3). It is distinct from Restore, which lifts the `status` hard-hide,
 * so a doubly-hidden row (status hidden AND over threshold) shows both. `Ban author`
 * mutes the Proof's owner across the event (#108); the row stays reachable after.
 */
function ProofQueueRow({
  proof: p,
  threshold,
  bannedUids,
  admins,
  days,
  frozenAt,
  standingsFreezeAt,
}: {
  proof: ProofDoc;
  threshold: number | undefined;
  bannedUids: string[];
  admins: string[];
  // The Event's Day schedule (#246): present ⇒ daily-cards mode, so a proof
  // deletion unmarks the DAY-SCOPED board for the Proof's own `dayIndex`.
  days: DayDef[] | undefined;
  // The scheduler's freeze stamp (#265) — folded with the schedule through
  // standingsFrozen at delete time.
  frozenAt?: number;
  // The Event's CONFIGURED Standings Freeze (ADR 0011), passed alongside the
  // stamp so the delete-time gate honours an Event that states its own freeze
  // rather than falling back to the ceremonial-Day derivation.
  standingsFreezeAt?: number;
}) {
  const autoHidden = isReportHidden(p.reportCount, threshold);
  return (
    <div className="row">
      <div className="grow">
        <div className="name">
          {p.displayName}
          <span className="pill">{p.reportCount} ⚑</span>
          {p.visionFlag && <span className="pill">{p.visionFlag}</span>}
          {autoHidden && <span className="pill pill-hidden">auto-hidden</span>}
        </div>
        <div className="sub">
          proof · {p.type} · {p.itemText}
        </div>
      </div>
      {autoHidden && (
        <AsyncButton onAction={() => clearProofReports(p.id)}>
          Clear reports
        </AsyncButton>
      )}
      {p.status === 'hidden' ? (
        <AsyncButton onAction={() => restoreProof(p.id)}>
          Restore
        </AsyncButton>
      ) : (
        <AsyncButton onAction={() => hideProof(p.id)}>
          Hide
        </AsyncButton>
      )}
      <BanControl uid={p.uid} bannedUids={bannedUids} admins={admins} />
      <AsyncButton
        className="iconbtn"
        title="Delete"
        onAction={() =>
          deleteProof(p.id, p.storagePath, {
            daily: !!days?.length,
            // Canonical DayDef.index values, not array positions (Phase 4b P1
            // on #447) — same fix as ProofFeed's deleteProof call site.
            dayIndexes: days?.map((d) => d.index),
            tutorialDayIndexes: days ? [...tutorialDayIndexSet(days)] : undefined,
            // #265 (Codex P2 on #278 round 3): the admin moderation delete
            // observes the same freeze/ceremonial gates as the player's own —
            // evaluated inside the transaction via the getter.
            ceremonialDayIndexes: days ? [...ceremonialDayIndexSet(days)] : undefined,
            statsFrozen: () => standingsFrozen({ frozenAt, standingsFreezeAt, days: days ?? [] }),
          })
        }
      >
        🗑
      </AsyncButton>
    </div>
  );
}

/** One reported-Prompt row in the Reports group — the Prompt-side twin of
 * `ProofQueueRow`, with the same `Clear reports` auto-hide lift (finding 3) and the
 * same `Ban author` control (#108), keyed on the Prompt's `createdBy` owner. */
function ItemQueueRow({
  item: it,
  threshold,
  bannedUids,
  admins,
}: {
  item: ItemDoc;
  threshold: number | undefined;
  bannedUids: string[];
  admins: string[];
}) {
  const autoHidden = isReportHidden(it.reportCount, threshold);
  return (
    <div className="row">
      <div className="grow">
        <div className="name">
          {it.text}
          <span className="pill">{it.reportCount} ⚑</span>
          {autoHidden && <span className="pill pill-hidden">auto-hidden</span>}
        </div>
        <div className="sub">prompt · {it.status}</div>
      </div>
      {autoHidden && (
        <AsyncButton onAction={() => clearItemReports(it.id)}>
          Clear reports
        </AsyncButton>
      )}
      {it.status === 'hidden' ? (
        <AsyncButton onAction={() => restoreItem(it.id)}>
          Restore
        </AsyncButton>
      ) : (
        <AsyncButton onAction={() => hideItem(it.id)}>
          Hide
        </AsyncButton>
      )}
      <BanControl uid={it.createdBy} bannedUids={bannedUids} admins={admins} />
      <AsyncButton className="iconbtn" title="Delete" onAction={() => deleteItem(it.id)}>
        🗑
      </AsyncButton>
    </div>
  );
}

/**
 * One row in the Approvals group (#210/#558): a pending Community Prompt with
 * submitter attribution, explicit Easy/Exploratory classification, a main-only
 * spicy toggle, and Approve/Reject. The spicy correction runs as a pending-main
 * transaction so it contends with approval; the rules also reject any write that
 * changes pool/spicy into a non-main + spicy state. Easy approval clears spicy in
 * the same guarded write, before the Prompt can reach an ungated card.
 */
function ApprovalQueueRow({
  item: it,
  spicy,
  difficulty,
  adminUid,
  onToggleSpicy,
  onDifficultyChange,
  onApprove,
}: {
  item: ItemDoc;
  /** The queue's optimistic view of `it.spicy` — the admin's own tick, before
   *  the Firestore snapshot carrying it has come back. */
  spicy: boolean;
  /** The Admin's approval-time classification (#558). This stays local until
   * approval so status, routing, and pool land in one transaction. */
  difficulty: 'main' | 'easy';
  adminUid: string;
  onToggleSpicy: (id: string, spicy: boolean) => Promise<void>;
  onDifficultyChange: (id: string, difficulty: 'main' | 'easy') => void;
  /** Routed through the queue's flip confirm (#610) rather than calling
   *  `approveItem` directly: approving the FIRST explicit Prompt is what turns
   *  the whole Event 18+ (#608), and the row cannot know it is the first. */
  onApprove: (item: ItemDoc) => Promise<unknown>;
}) {
  const [spicyWriteState, setSpicyWriteState] = useState<'idle' | 'busy' | 'error'>('idle');
  const changeSpicy = async (nextSpicy: boolean) => {
    if (spicyWriteState === 'busy') return;
    setSpicyWriteState('busy');
    try {
      await onToggleSpicy(it.id, nextSpicy);
      setSpicyWriteState('idle');
    } catch {
      setSpicyWriteState('error');
    }
  };
  return (
    <div className="row">
      <div className="grow">
        <div className="name" style={{ fontWeight: 500 }}>
          {it.text}
        </div>
        <div className="sub">submitted by {it.createdBy}</div>
      </div>
      <label style={{ fontSize: 12 }}>
        Difficulty{' '}
        <select
          aria-label={`Difficulty for ${it.text}`}
          value={difficulty}
          onChange={(e) => {
            const nextDifficulty = e.target.value as 'main' | 'easy';
            // A spicy-write failure belongs to the classification that exposed
            // the toggle. Changing classification is a fresh decision, so do
            // not leave its now-hidden retry error attached to the row. Preserve
            // `busy`, though: the in-flight write still owns the single-flight
            // fence until it settles.
            if (nextDifficulty !== difficulty && spicyWriteState === 'error') {
              setSpicyWriteState('idle');
            }
            onDifficultyChange(it.id, nextDifficulty);
          }}
        >
          <option value="main">Exploratory</option>
          <option value="easy">Easy</option>
        </select>
      </label>
      {difficulty === 'main' && (
        <label style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={spicy}
            disabled={spicyWriteState === 'busy'}
            onChange={(e) => void changeSpicy(e.target.checked)}
          />{' '}
          🔞 Spicy
        </label>
      )}
      {difficulty === 'main' && spicyWriteState === 'error' && (
        <span className="pill pill-error" role="alert">
          Failed—try again.
        </span>
      )}
      <AsyncButton
        className="btn primary"
        onAction={() =>
          onApprove({
            ...it,
            pool: difficulty,
            spicy: difficulty === 'easy' ? false : spicy,
          })
        }
      >
        Approve
      </AsyncButton>
      <AsyncButton className="iconbtn" title="Reject" onAction={() => rejectItem(it.id, adminUid)}>
        ✕
      </AsyncButton>
    </div>
  );
}

/**
 * The merged review inbox (specs/admin-console-ia.md § "Review queue"): Reports,
 * Approvals, and — in admin-confirmed claim mode only — Pending claims become
 * ONE triage surface, each group oldest-first, every triage action on the row.
 * It replaces the old Moderation report queue, the Approvals tab, and the
 * Moderation Pending-claims section; the write paths are exactly the ones those
 * surfaces used. The hub's Review-queue badge is this surface's total.
 */
export default function ReviewQueue({
  event,
  reports,
  pendingItems,
  claims,
  adminUid,
}: {
  event: EventDoc | null | undefined;
  /** Reported Proofs + Prompts, merged and sorted oldest-first by the caller. */
  reports: QueueRow[];
  /** Pending approvals — `usePendingItems` already sorts oldest-first. */
  pendingItems: ItemDoc[];
  /** Pending claims — `usePendingClaims` already sorts oldest-first. */
  claims: ClaimDoc[];
  adminUid: string;
}) {
  const threshold = event?.settings?.reportHideThreshold;
  const bannedUids = event?.bannedUids ?? [];
  const admins = event?.admins ?? [];
  const claimsVisible = event?.claimMode === 'admin_confirmed';
  const total = reports.length + pendingItems.length + (claimsVisible ? claims.length : 0);
  // The 18+ flip confirm (#610, required by #608's acceptance). BOTH approve
  // paths go through it, and the bulk one is the easy miss: a batch containing
  // one explicit Prompt flips the Event just as surely as approving that Prompt
  // alone. Cancelling applies NONE of the batch — a partial apply would flip the
  // Event anyway and leave the admin unsure which half landed.
  const { guard, dialog } = useAdultContentFlipConfirm();
  // The 🔞 toggle writes to Firestore and the row re-renders from the NEXT
  // snapshot, so an admin who changes it and immediately taps Approve can hand
  // the approval a stale value. This overlay records the exact latest choice.
  // Approval writes that value in its own transaction, so both tick and un-tick
  // are safe to trust here even when the separate correction loses the race.
  const [optimisticSpicy, setOptimisticSpicy] = useState<
    Record<string, { value: boolean; requestId: number; committedRevision?: number }>
  >({});
  const spicyRequestSequence = useRef(0);
  const pendingItemsRef = useRef(pendingItems);
  const [approvalDifficulties, setApprovalDifficulties] = useState<
    Record<string, 'main' | 'easy'>
  >({});
  useEffect(() => {
    // Publish only committed props to the async settlement callback. Writing a
    // ref during render can leak an interrupted/discarded concurrent render;
    // effect ordering also updates this ref before the reconciliation effect
    // below evaluates the same committed pendingItems snapshot.
    pendingItemsRef.current = pendingItems;
  }, [pendingItems]);
  useEffect(() => {
    // The overlay bridges the write→snapshot gap; it must not become a second
    // source of truth. Retire it once the listener reaches THIS transaction's
    // committed revision (or anything newer), regardless of value. That handles
    // both delivery orders: our echo after Promise settlement, and our echo
    // before settlement followed by another Admin's later correction.
    const authoritativeItems = new Map(pendingItems.map((it) => [it.id, it] as const));
    setOptimisticSpicy((prev) => {
      let next = prev;
      for (const [id, overlay] of Object.entries(prev)) {
        const authoritative = authoritativeItems.get(id);
        const authoritativeRevision =
          authoritative &&
          typeof authoritative.spicyRevision === 'number' &&
          Number.isSafeInteger(authoritative.spicyRevision) &&
          authoritative.spicyRevision >= 0
            ? authoritative.spicyRevision
            : 0;
        if (
          !authoritative ||
          (overlay.committedRevision !== undefined &&
            authoritativeRevision >= overlay.committedRevision)
        ) {
          if (next === prev) next = { ...prev };
          delete next[id];
        }
      }
      return next;
    });
  }, [pendingItems]);
  const difficultyFor = (it: ItemDoc): 'main' | 'easy' =>
    approvalDifficulties[it.id] ?? (normalizePool(it.pool) === 'easy' ? 'easy' : 'main');
  const selectedSpicyFor = (it: ItemDoc): boolean =>
    Object.hasOwn(optimisticSpicy, it.id) ? optimisticSpicy[it.id].value : it.spicy === true;
  const isSpicy = (it: ItemDoc) => difficultyFor(it) === 'main' && selectedSpicyFor(it);
  const toggleSpicy = async (id: string, spicy: boolean) => {
    const ownedEventId = EVENT_ID;
    const requestId = ++spicyRequestSequence.current;
    setOptimisticSpicy((prev) => ({
      ...prev,
      [id]: { value: spicy, requestId },
    }));
    try {
      const committedRevision = await setItemSpicy(id, spicy, ownedEventId);
      setOptimisticSpicy((prev) => {
        const current = prev[id];
        if (current?.requestId !== requestId) return prev;
        const authoritative = pendingItemsRef.current.find((it) => it.id === id);
        const authoritativeRevision =
          authoritative &&
          typeof authoritative.spicyRevision === 'number' &&
          Number.isSafeInteger(authoritative.spicyRevision) &&
          authoritative.spicyRevision >= 0
            ? authoritative.spicyRevision
            : 0;
        if (
          !authoritative ||
          typeof committedRevision !== 'number' ||
          authoritativeRevision >= committedRevision
        ) {
          const next = { ...prev };
          delete next[id];
          return next;
        }
        return { ...prev, [id]: { ...current, committedRevision } };
      });
    } catch (error) {
      // The moderation write did not commit. Reconcile the optimistic overlay
      // immediately so the checkbox cannot continue claiming the correction was
      // saved. Reveal the authoritative row rather than pinning a copy of its
      // old value, which could mask another Admin's correction after this error.
      setOptimisticSpicy((prev) => {
        if (prev[id]?.requestId !== requestId) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      throw error;
    }
  };
  const changeDifficulty = (id: string, difficulty: 'main' | 'easy') => {
    setApprovalDifficulties((prev) => ({ ...prev, [id]: difficulty }));
    if (difficulty === 'easy') {
      // A prior optimistic tick must not survive a switch to Easy. Drop the
      // overlay rather than storing false so switching back to Exploratory
      // restores the authoritative row posture.
      setOptimisticSpicy((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };
  const explicitPending = pendingItems.filter(isSpicy);
  // `prompt_suggestion_approved` (#559): one event per row that actually got
  // approved — `stale`/`missing` wrote nothing (a double-click, a vanished
  // row), so they fire nothing. No Prompt text; `outcome` + `dayIndex` only.
  // Wrapped around `run` ITSELF, not chained onto `guard`'s own return: the
  // 18+ flip-confirm dialog's `wouldFlip` branch resolves `guard`'s promise
  // immediately with `undefined` and defers the real call to `pending.run()`
  // inside the dialog's own confirm handler — attaching here means the
  // event fires on whichever path actually runs the approval.
  const trackApproval = (p: ApprovalPlacement, ownedEventId: string): ApprovalPlacement => {
    // Defensive against a nullish placement, not just the real `approveItem`
    // contract (which always resolves one): test doubles for `data/admin`
    // commonly stub a bare `async () => {}`, and analytics is presentational
    // — it must never turn a mocked-away approval into a rejected promise.
    if (EVENT_ID === ownedEventId && p && p.outcome !== 'stale' && p.outcome !== 'missing') {
      track('prompt_suggestion_approved', {
        outcome: p.outcome,
        ...(p.dayIndex != null ? { dayIndex: p.dayIndex } : {}),
      });
    }
    return p;
  };
  // Array.isArray guard for the SAME reason as `trackApproval`'s nullish
  // check above: a test double for `bulkApproveItems` commonly stubs a bare
  // `vi.fn()` (undefined, not even a Promise) rather than an
  // ApprovalPlacement[].
  const trackApprovals = (
    placements: ApprovalPlacement[],
    ownedEventId: string,
  ): ApprovalPlacement[] =>
    Array.isArray(placements)
      ? placements.map((placement) => trackApproval(placement, ownedEventId))
      : placements;
  // Pass the ROW, not the id (#557/#558): approval routes from the authoritative
  // stored target while atomically carrying the Admin's difficulty/spicy choice.
  // `Promise.resolve(...)` wraps each call rather than chaining `.then`
  // directly on its result — a bare `vi.fn()` test double (no async, no
  // explicit resolved value) returns `undefined`, not a thenable, and a raw
  // `.then` on that throws synchronously before the mocked "approval" ever
  // gets a chance to no-op harmlessly.
  const approveOne = (it: ItemDoc) => {
    const ownedEventId = EVENT_ID;
    return guard(isSpicy(it), 'approve', () =>
      Promise.resolve(approveItem(it, adminUid, ownedEventId)).then((placement) =>
        trackApproval(placement, ownedEventId),
      ),
    );
  };
  const approveAll = () => {
    const ownedEventId = EVENT_ID;
    return guard(
      explicitPending.length > 0,
      'bulk-approve',
      () =>
        Promise.resolve(
          bulkApproveItems(
            pendingItems.map((it) => {
              const difficulty = difficultyFor(it);
              return {
                ...it,
                pool: difficulty,
                spicy: difficulty === 'easy' ? false : selectedSpicyFor(it),
              };
            }),
            adminUid,
            ownedEventId,
          ),
        ).then((placements) => trackApprovals(placements, ownedEventId)),
      { explicitCount: explicitPending.length, totalCount: pendingItems.length },
    );
  };

  // The empty state and the flip confirm render TOGETHER, and the dialog is
  // deliberately outside the early return (Phase 4b P2). Confirming the last
  // pending Prompt removes it from the pending query by Firestore's latency
  // compensation — immediately, before the server has accepted or rejected the
  // write — so `total` hits zero and an early return that owned the dialog would
  // unmount it mid-write. The admin would watch the confirm vanish and "All
  // clear." appear, and a rejection would take its own error state down with it:
  // the write silently did not happen, on the one action in this console that
  // cannot be undone.
  if (!total) {
    return (
      <>
        <p className="muted" style={{ fontSize: 13 }}>
          {editionBrand().reviewQueueAllClear}
        </p>
        {dialog}
      </>
    );
  }

  return (
    <>
      {/* Reports — ADR 0004 Phase 0: any row tagged "auto-hidden" has crossed
          reportHideThreshold and already self-hid on every Player's Feed/pool
          with no Admin action; it stays reachable here so an Admin can hide
          (hard), restore, or delete it. The community hide is presentational
          and bypassable by design — server-authoritative removal is #43. */}
      <div className="admin-section queue">
        <h3>Reports{reports.length ? ` (${reports.length})` : ''}</h3>
        {!reports.length && <p className="muted" style={{ fontSize: 12 }}>Nothing reported.</p>}
        <div className="list">
          {reports.map((entry) =>
            entry.kind === 'proof' ? (
              <ProofQueueRow
                key={`proof-${entry.proof.id}`}
                proof={entry.proof}
                threshold={threshold}
                bannedUids={bannedUids}
                admins={admins}
                days={event?.days}
                frozenAt={event?.frozenAt}
                standingsFreezeAt={event?.standingsFreezeAt}
              />
            ) : (
              <ItemQueueRow
                key={`item-${entry.item.id}`}
                item={entry.item}
                threshold={threshold}
                bannedUids={bannedUids}
                admins={admins}
              />
            ),
          )}
        </div>
      </div>

      {/* Approvals (#210): the pending main-pool queue, oldest-first, with the
          bulk-approve control for taste. */}
      <div className="admin-section">
        <h3>Approvals{pendingItems.length ? ` (${pendingItems.length})` : ''}</h3>
        {!pendingItems.length && (
          <p className="muted" style={{ fontSize: 12 }}>
            Nothing pending review.
          </p>
        )}
        {!!pendingItems.length && (
          <AsyncButton onAction={approveAll}>
            Approve all
          </AsyncButton>
        )}
        <div className="list">
          {pendingItems.map((it) => (
            <ApprovalQueueRow
              key={it.id}
              item={it}
              spicy={isSpicy(it)}
              difficulty={difficultyFor(it)}
              adminUid={adminUid}
              onToggleSpicy={toggleSpicy}
              onDifficultyChange={changeDifficulty}
              onApprove={approveOne}
            />
          ))}
        </div>
      </div>

      {/* Pending claims — admin-confirmed mode only (#269, the wireframes'
          caption): in the other claim modes there is no claims queue at all. */}
      {claimsVisible && (
        <div className="admin-section">
          <h3>Pending claims{claims.length ? ` (${claims.length})` : ''}</h3>
          {!claims.length && <p className="muted" style={{ fontSize: 12 }}>Nothing to confirm.</p>}
          <div className="list">
            {claims.map((c) => (
              <div key={c.id} className="row">
                <div className="grow">
                  <div className="name">{c.displayName}</div>
                  <div className="sub">{c.itemText}</div>
                </div>
                <AsyncButton onAction={() => confirmClaim(c, adminUid)}>
                  Confirm
                </AsyncButton>
                <AsyncButton className="iconbtn" title="Reject" onAction={() => rejectClaim(c, adminUid)}>
                  ✕
                </AsyncButton>
              </div>
            ))}
          </div>
        </div>
      )}
      {dialog}
    </>
  );
}
