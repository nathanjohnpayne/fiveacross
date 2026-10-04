// Owner-approved #1411 exception: a UID-scoped boolean for rendering an
// existing cached Board. No profile fields, timestamp, or deal authority.
const key = (projectId: string, uid: string) => `fiveacross:${projectId}:offline-attested:${uid}`;

// A failed persistent revocation still retires the witness in this process.
// If every write is refused, a fresh process cannot learn that revocation from
// unchanged disk. The owner accepts that narrow fresh-process render residual;
// it grants neither a deal nor server-read authority (specs/private-cache-isolation.md).
const revoked = new Set<string>();

export function recordOfflineAttestation(projectId: string, uid: string, attested: boolean): void {
  const scopedKey = key(projectId, uid);
  if (attested) {
    localStorage.setItem(scopedKey, '1');
    revoked.delete(scopedKey);
  } else {
    revoked.add(scopedKey);
    try { localStorage.removeItem(scopedKey); } catch {
      // Some storage failures refuse deletion but still admit replacement.
      // Same-key false has no profile, timestamp, or additional identity data.
      localStorage.setItem(scopedKey, '0');
    }
  }
}

export function hasOfflineAttestation(projectId: string, uid: string): boolean {
  if (revoked.has(key(projectId, uid))) {
    // Storage may recover during this process. Retry the same-key revocation
    // before any later reload, without ever lifting the current render gate.
    try { recordOfflineAttestation(projectId, uid, false); } catch { /* still refused */ }
    return false;
  }
  try {
    // Readable but unwritable storage cannot reliably record a later server
    // revocation. In that state the witness grants no provisional rendering.
    const probe = `${key(projectId, uid)}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage.getItem(key(projectId, uid)) === '1';
  } catch { return false; }
}
