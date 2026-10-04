// Owner-approved #1411 exception: a UID-scoped boolean for rendering an
// existing cached Board. No profile fields, timestamp, or deal authority.
const key = (projectId: string, uid: string) => `fiveacross:${projectId}:offline-attested:${uid}`;

export function recordOfflineAttestation(projectId: string, uid: string, attested: boolean): void {
  if (attested) localStorage.setItem(key(projectId, uid), '1');
  else localStorage.removeItem(key(projectId, uid));
}

export function hasOfflineAttestation(projectId: string, uid: string): boolean {
  try {
    // Readable but unwritable storage cannot reliably record a later server
    // revocation. In that state the witness grants no provisional rendering.
    const probe = `${key(projectId, uid)}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage.getItem(key(projectId, uid)) === '1';
  } catch { return false; }
}
