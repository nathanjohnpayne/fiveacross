/** Exported for the Playwright harnesses, which seed a recovered device. */
export const RECOVERY_VERSION = 'private-cache-recovered-v1';
export const privateCacheRecoveryKey = (projectId: string) => `fiveacross:${projectId}:${RECOVERY_VERSION}`;

/** An absent/unwritable marker never grants private access. Recovery writes it only after clearing succeeds. */
export function privateCacheRecovered(projectId: string): boolean {
  try { return localStorage.getItem(privateCacheRecoveryKey(projectId)) === RECOVERY_VERSION; }
  catch { return false; }
}

export function recordPrivateCacheRecovery(projectId: string): void {
  localStorage.setItem(privateCacheRecoveryKey(projectId), RECOVERY_VERSION);
  if (!privateCacheRecovered(projectId)) throw new Error('Device recovery could not be recorded.');
}

