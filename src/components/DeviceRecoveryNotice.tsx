import { useAuth } from '../auth/AuthContext';
import { usePrivateFirestore } from '../hooks/usePrivateFirestore';
import { privateCacheRecoveryHref } from '../auth/privateCacheRecoveryNavigation';

/** Shared gameplay can bootstrap its memory-only block filter during quarantine.
 * Ordinary private tools still need the attended, all-account cache transition. */
export default function DeviceRecoveryNotice() {
  const { user } = useAuth();
  const { recoveryRequired } = usePrivateFirestore();
  if (!user || !recoveryRequired) return null;
  return (
    <aside className="center muted" role="status">
      <p>Finish device recovery to use your profile, submissions, own Claims and organizer tools. An admin-confirmed win first seen after recovery will not get a new Feed announcement. Your Board and queued Marks stay available.</p>
      <a href={privateCacheRecoveryHref(window.location.href)}>Finish device recovery</a>
    </aside>
  );
}
