// Owner-approved #1411 exception: a UID-scoped boolean for rendering an
// existing cached Board. No profile fields, timestamp, or deal authority.
const key = (projectId: string, uid: string) => `fiveacross:${projectId}:offline-attested:${uid}`;

// A failed persistent revocation still retires the witness in this process.
// If every write is refused, a fresh process cannot learn that revocation from
// unchanged disk. The owner accepts that narrow fresh-process render residual;
// it grants neither a deal nor server-read authority (specs/private-cache-isolation.md).
const revoked = new Set<string>();
const latestRecord = new Map<string, object>();

// All cooperating same-origin documents serialize this key's storage operations.
// The lock adds no disk record. Its callback performs synchronous storage work
// only; an expired waiter cannot mutate storage after returning to its caller.
async function withWitnessLock<T>(scopedKey: string, work: () => T): Promise<T> {
  if (typeof globalThis.navigator?.locks?.request !== 'function') throw new Error('Witness lock unavailable.');
  const controller = new AbortController();
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      active = false;
      controller.abort();
      reject(new Error('Witness lock timed out.'));
    }, 1000);
  });
  try {
    return await Promise.race([
      navigator.locks.request(scopedKey, { mode: 'exclusive', signal: controller.signal }, () => {
        if (!active) throw new Error('Witness lock expired.');
        return work();
      }),
      deadline,
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
    controller.abort();
  }
}

function revokeStoredWitness(scopedKey: string): void {
  try { localStorage.removeItem(scopedKey); } catch {
    // Some storage failures refuse deletion but still admit replacement.
    // Same-key false has no profile, timestamp, or additional identity data.
    localStorage.setItem(scopedKey, '0');
  }
}

export async function recordOfflineAttestation(
  projectId: string, uid: string, attested: boolean, assertCurrent: () => void = () => {},
): Promise<void> {
  const scopedKey = key(projectId, uid);
  const intent = {};
  latestRecord.set(scopedKey, intent);
  // Definitive absence retires rendering immediately, before any lock wait.
  if (!attested) revoked.add(scopedKey);
  await withWitnessLock(scopedKey, () => {
    if (attested) {
      // An older queued positive must not lift a newer process revocation,
      // even when that newer operation cannot persist its false flag.
      if (latestRecord.get(scopedKey) !== intent) throw new Error('Witness record superseded.');
      assertCurrent();
      localStorage.setItem(scopedKey, '1');
      revoked.delete(scopedKey);
    } else {
      revokeStoredWitness(scopedKey);
    }
  });
}

export async function hasOfflineAttestation(
  projectId: string, uid: string, assertCurrent: () => void = () => {},
): Promise<boolean> {
  const scopedKey = key(projectId, uid);
  try {
    return await withWitnessLock(scopedKey, () => {
      if (revoked.has(scopedKey)) {
        // Retry without nested locking or ever lifting this process's gate.
        revokeStoredWitness(scopedKey);
        return false;
      }
      assertCurrent();
      // Readable but unwritable storage grants no provisional rendering.
      // All writers take this same lock, so this same-value check cannot
      // resurrect another participating document's successful revocation.
      if (localStorage.getItem(scopedKey) !== '1') return false;
      localStorage.setItem(scopedKey, '1');
      return localStorage.getItem(scopedKey) === '1';
    });
  } catch { return false; }
}
