import type { CommittedReplica, RegistryState } from './contracts';
import type { RecoveryRecord } from './recovery';
import { registryLookup } from './state';

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/;
export const AUDIT_PAGE_SIZE = 100;

export type RegistryAuditPage = {
  committed: null | Pick<CommittedReplica, 'revision' | 'digest'>;
  minimumPublisherEpoch: string;
  highestAuthenticatedPublisherEpoch: string;
  highestQuarantinedPublisherEpoch: string;
  recoveryLock: RegistryState['recoveryLock'];
  lookup: { kind: 'unknown-host' } | { kind: 'unavailable' } | { kind: 'committed'; revision: string };
  records: RecoveryRecord[];
  nextAfter: string | null;
};

export function createAuditPage(
  state: RegistryState,
  recordsAfterCursor: readonly RecoveryRecord[],
  afterRecoverySequence: string,
): RegistryAuditPage {
  if (
    !NON_NEGATIVE_DECIMAL.test(afterRecoverySequence) ||
    BigInt(afterRecoverySequence) > BigInt(state.recoverySequence)
  ) {
    throw new Error('audit cursor is malformed or unknown-ahead');
  }
  const expectedFirst = BigInt(afterRecoverySequence) + 1n;
  for (const [index, record] of recordsAfterCursor.entries()) {
    if (BigInt(record.sequence) !== expectedFirst + BigInt(index)) {
      throw new Error('audit history is non-contiguous');
    }
  }
  const hasMore = recordsAfterCursor.length > AUDIT_PAGE_SIZE;
  const records = recordsAfterCursor.slice(0, AUDIT_PAGE_SIZE);
  const lookup = registryLookup(state);
  return {
    committed:
      state.committed === null
        ? null
        : {
            revision: state.committed.revision,
            digest: state.committed.digest,
          },
    minimumPublisherEpoch: state.minimumPublisherEpoch,
    highestAuthenticatedPublisherEpoch: state.highestAuthenticatedPublisherEpoch,
    highestQuarantinedPublisherEpoch: state.highestQuarantinedPublisherEpoch,
    recoveryLock: state.recoveryLock,
    lookup: lookup.kind === 'committed' ? { kind: 'committed', revision: lookup.revision } : lookup,
    records,
    nextAfter: hasMore ? (records.at(-1)?.sequence ?? null) : null,
  };
}
