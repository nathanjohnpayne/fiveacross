import { ShieldAlert, Wrench, CalendarDays, Lightbulb, Users, Megaphone } from 'lucide-react';
import { MoreRow } from '../MoreRow';
import type { AdminSection } from './route';
import type { EventDoc } from '../../types';

/**
 * The admin hub (specs/admin-console-ia.md § "Hub"): one screen, six doors —
 * a compact card per section with a live badge where a queue waits behind it.
 * Replaces the old three-tab, six-section scroll. The Review-queue badge is
 * the merged inbox's total (reports + approvals + claims-in-admin-confirmed-
 * mode); the Prompt-pool badge is the pending-approvals count the More menu's
 * Admin row already surfaces. Rows reuse the shared `MoreRow`
 * chrome so the hub reads as the same kind of surface (its own module, so the
 * hub never imports the whole More screen — Phase 4b P1, PR #410).
 */
export default function AdminHub({
  event,
  reportCount,
  approvalCount,
  claimCount,
  itemCount,
  pendingCount,
  onOpen,
}: {
  event: EventDoc | null | undefined;
  reportCount: number;
  approvalCount: number;
  claimCount: number;
  itemCount: number;
  pendingCount: number;
  onOpen: (section: AdminSection) => void;
}) {
  const claimsVisible = event?.claimMode === 'admin_confirmed';
  const queueTotal = reportCount + approvalCount + (claimsVisible ? claimCount : 0);
  const days = event?.days ?? [];
  const bannedCount = event?.bannedUids?.length ?? 0;

  // "next unlock Sat 8:00" — the earliest still-locked Day, in the Event's own
  // IANA timezone (the ScheduleList convention) so it reads correctly
  // regardless of the viewer's clock.
  const now = Date.now();
  const nextUnlockAt = days
    .map((d) => d.unlockAt)
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];
  const nextUnlockLabel =
    nextUnlockAt != null
      ? new Intl.DateTimeFormat(undefined, {
          timeZone: event?.timezone || undefined,
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(nextUnlockAt))
      : null;

  const queueSub =
    queueTotal === 0
      ? 'All clear'
      : [`Reports ${reportCount}`, `Approvals ${approvalCount}`, ...(claimsVisible ? [`Claims ${claimCount}`] : [])].join(' · ') +
        '—one inbox, oldest first';

  return (
    <div className="more-rows">
      <MoreRow
        icon={ShieldAlert}
        title="Review queue"
        sub={queueSub}
        badge={queueTotal > 0 ? queueTotal : undefined}
        onClick={() => onOpen('queue')}
      />
      <MoreRow
        icon={Wrench}
        title="Game settings"
        sub="Claim mode · photo source · EXIF · AI screen · auto-hide · easy mix · default theme"
        onClick={() => onOpen('settings')}
      />
      <MoreRow
        icon={CalendarDays}
        title="Schedule"
        sub={`${days.length} days${nextUnlockLabel ? ` · next unlock ${nextUnlockLabel}` : ''} · unlock now / re-snapshot live here`}
        onClick={() => onOpen('schedule')}
      />
      <MoreRow
        icon={Lightbulb}
        title="Prompt pool"
        sub={`${itemCount} prompts · curated add${pendingCount ? ` · ${pendingCount} pending` : ''}`}
        badge={pendingCount > 0 ? pendingCount : undefined}
        onClick={() => onOpen('pool')}
      />
      <MoreRow
        icon={Users}
        title="Players"
        sub={`Banned roster · ${bannedCount} banned`}
        onClick={() => onOpen('players')}
      />
      <MoreRow
        icon={Megaphone}
        title="Messages"
        sub="Post a Notice to everyone · pin to the Feed + Card banner"
        onClick={() => onOpen('messages')}
      />
    </div>
  );
}
