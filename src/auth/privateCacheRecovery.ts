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
  await bounded(operations.clear);
  assertSession();
  // A failed clear never unlocks private views. A storage failure also fails
  // closed; replay requires the same attended recovery confirmations.
  operations.recordCompletion();
}
