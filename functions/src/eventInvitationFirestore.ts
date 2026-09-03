/** Admin SDK adapter for the pure Event Invitation decision layer. */
import type {
  DocumentReference,
  Firestore,
  Query,
} from 'firebase-admin/firestore';
import type {
  InvitationDocRef,
  InvitationFirestore,
  InvitationQuery,
  InvitationSnapshot,
} from './eventInvitations';

interface AdminInvitationRef extends InvitationDocRef {
  readonly native: DocumentReference;
}

interface AdminInvitationQuery extends InvitationQuery {
  readonly native: Query;
}

function refOf(ref: InvitationDocRef): DocumentReference {
  return (ref as AdminInvitationRef).native;
}

function queryOf(query: InvitationQuery): Query {
  return (query as AdminInvitationQuery).native;
}

function snapshotOf(snapshot: {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}): InvitationSnapshot {
  return { exists: snapshot.exists, data: () => snapshot.data() };
}

/** Optional diagnostics used to prove retry semantics against the emulator. */
export interface EventInvitationFirestoreHooks {
  onTransactionAttempt?(): void;
  beforeGet?(path: string): Promise<void> | void;
}

/**
 * Dress one Admin SDK Firestore instance as the minimal injected surface.
 * Production callables and emulator transaction proofs use this exact adapter.
 */
export function eventInvitationFirestore(
  db: Firestore,
  hooks: EventInvitationFirestoreHooks = {},
): InvitationFirestore {
  return {
    doc: (path): AdminInvitationRef => ({ path, native: db.doc(path) }),
    hostnamesForEvent: (eventId): AdminInvitationQuery => ({
      eventId,
      native: db.collection('hostnames').where('eventId', '==', eventId),
    }),
    runTransaction: (work) => db.runTransaction(async (transaction) => {
      hooks.onTransactionAttempt?.();
      return work({
        get: async (ref) => {
          await hooks.beforeGet?.(ref.path);
          return snapshotOf(await transaction.get(refOf(ref)));
        },
        getQuery: async (query) => {
          const snapshot = await transaction.get(queryOf(query));
          return {
            docs: snapshot.docs.map((doc) => ({
              id: doc.id,
              data: () => doc.data() as Record<string, unknown>,
            })),
          };
        },
        create: (ref, data) => {
          transaction.create(refOf(ref), data);
        },
        set: (ref, data) => {
          transaction.set(refOf(ref), data);
        },
        update: (ref, data) => {
          transaction.update(refOf(ref), data);
        },
      });
    }),
  };
}
