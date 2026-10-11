export interface LegacyRecoveryConfirmation {
  allAccountsRecovered: boolean;
  otherTabsClosed: boolean;
}

export interface LegacyRecoveryOperations {
  online: () => boolean;
  currentUid: () => string | null;
  proveServerAccess: (uid: string) => Promise<void>;
  drainActiveUser: () => Promise<void>;
  terminate: () => Promise<void>;
  clear: () => Promise<void>;
  recordCompletion: () => void;
  clearStillPending?: () => void;
}

/**
 * The all-account and other-tab statements are ATTENDED operator confirmations,
 * not properties proved by waitForPendingWrites. The real SDK test proves that
 * an empty active-user queue can coexist with another user's recoverable Mark.
 * Run only in the dedicated recovery document, with no application writers.
 */
export async function completeLegacyCacheRecovery(
  confirmation: LegacyRecoveryConfirmation,
  operations: LegacyRecoveryOperations,
  timeoutMs = 10_000,
): Promise<void> {
  if (!confirmation.allAccountsRecovered || !confirmation.otherTabsClosed) {
    throw new Error('Recover every account’s Marks and close the other tabs first.');
  }
  const uid = operations.currentUid();
  let expired = false;
  const bounded = async (operation: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error("Recovery timed out; reload before retrying.")); }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const assertSession = () => {
    if (expired || !uid || operations.currentUid() !== uid || !operations.online()) {
      throw new Error('Stay signed in and online while finishing device recovery.');
    }
  };
  assertSession();
  await bounded(() => operations.proveServerAccess(uid!));
  assertSession();
  await bounded(operations.drainActiveUser);
  assertSession();
  await bounded(operations.terminate);
  assertSession();
  await clearWithinQuarantine(operations, timeoutMs, () => { expired = true; });
  assertSession();
  // A failed clear never unlocks private views. A storage failure also fails
  // closed; replay requires the same attended recovery confirmations.
  operations.recordCompletion();
}

export interface UnverifiedRecoveryConfirmation {
  unsyncedMarksLossAccepted: boolean;
  otherTabsClosed: boolean;
}

export type UnverifiedRecoveryOperations = Pick<
  LegacyRecoveryOperations, 'terminate' | 'clear' | 'recordCompletion' | 'clearStillPending'
>;

/**
 * Owner-approved escape hatch after a failed attended recovery (#1886). It
 * still removes the legacy cache through supported SDK APIs, but skips the
 * sign-in, online, server-proof and drain prerequisites that protect unsynced
 * Marks. The operator must explicitly accept losing every account's unsynced
 * Marks on this device. Clearing keeps the attended path's quarantine.
 */
export async function clearLegacyCacheWithoutVerification(
  confirmation: UnverifiedRecoveryConfirmation,
  operations: UnverifiedRecoveryOperations,
  timeoutMs = 10_000,
): Promise<void> {
  if (!confirmation.unsyncedMarksLossAccepted || !confirmation.otherTabsClosed) {
    throw new Error('Accept the loss of unsynced Marks and close the other tabs first.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operations.terminate(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Recovery timed out; reload before retrying.')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
  await clearWithinQuarantine(operations, timeoutMs, () => {});
  operations.recordCompletion();
}

// Clearing is destructive and cannot be canceled by Promise.race. A timeout
// may report waiting, but may not release this document while the SDK can
// still erase persistence. Late settlement refuses the completion marker.
async function clearWithinQuarantine(
  operations: Pick<LegacyRecoveryOperations, 'clear' | 'clearStillPending'>,
  timeoutMs: number,
  onExpired: () => void,
): Promise<void> {
  let expired = false;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    clearTimer = setTimeout(() => {
      expired = true;
      onExpired();
      operations.clearStillPending?.();
    }, timeoutMs);
    await operations.clear();
    if (expired) throw new Error('Recovery timed out; reload before retrying.');
  } finally { if (clearTimer) clearTimeout(clearTimer); }
}
