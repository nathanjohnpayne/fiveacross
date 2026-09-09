import { describe, it, expect, vi } from 'vitest';
import {
  SWEEP_LEASE_TTL_MS,
  confinedProofMediaPath,
  hasActiveSweepLease,
  isGenerationMismatch,
  isObjectAlreadyGone,
  isSameRevocation,
  revokeProofMedia,
  sameFirestoreValue,
  type ProofStorageDeleteInput,
  type RevokeProofMediaDeps,
  type SweepLease,
} from '../../functions/src/proofStorageDeletes';

// specs/post-sailing-archive.md § "Moderation is not a gameplay write", the
// durability half (#134 child 5, #1153; Codex P1 on PR #1139).
//
// `deleteProof` commits the Proof document's removal and revokes its media as
// two operations against two services, Firestore first — and that commit is what
// destroys the only record of which object was meant to go. The client writes a
// tombstone in the SAME transaction so the debt outlives the row, and clears it
// once the object is provably gone. This suite covers the other half: the
// server-side sweep that finishes a revocation the client never did.
//
// Every seam is a fake; no Functions runtime, no emulator, no bucket. What is
// asserted throughout is the ORDERING contract — the tombstone is retired only
// after the object is actually gone, never on the strength of an attempt.

/** The generation the fake bucket reports when a case does not care which. */
const SWEPT_GENERATION = '1700000000000900';

function makeDeps(
  deleteObject: (storagePath: string) => Promise<void>,
  // Whether a Proof document holds this id at sweep time. Default FALSE, which
  // is what a standing tombstone is supposed to mean; the cases that matter set
  // it true, or reject, on purpose.
  proofExists: () => Promise<boolean> = async () => false,
  // The row standing at the tombstone's path at sweep time. Default `undefined`,
  // which the harness resolves to the target's OWN row — the ordinary delivery,
  // arriving while its own revocation is still owed. Cases pass `null` for a
  // retired row, a different row for the reuse hazard, or a rejecting reader.
  currentTombstone?: () => Promise<ProofStorageDeleteInput | null>,
  ownRow: ProofStorageDeleteInput = TARGET.tombstone,
  // The row the RETIREMENT transaction finds when it re-reads (#1153, Codex
  // round 4 P2). Default `undefined`, which the harness resolves to whatever
  // `currentTombstone` hands back — the ordinary case, where nothing moved
  // between the pre-check and the retirement. A case that passes something else
  // is modelling exactly the gap this dep exists to close.
  atRetirement?: () => Promise<ProofStorageDeleteInput | null>,
  // The sweep-lease seams (#1153, Codex round 6 P2). `objectGeneration` is what
  // the bucket reports for a row that recorded none — `null` models an object
  // that is already gone by the time the metadata read runs.
  leaseOptions: { objectGeneration?: string | null; now?: () => number } = {},
): RevokeProofMediaDeps & {
  objectDeletes: Array<{ storagePath: string; generation: string | null }>;
  generationReads: string[];
  claims: SweepLease[];
  tombstoneDeletes: number;
  retirementRefusals: number;
  warnings: Array<{ message: string; context: Record<string, unknown> }>;
} {
  const objectDeletes: Array<{ storagePath: string; generation: string | null }> = [];
  const generationReads: string[] = [];
  const claims: SweepLease[] = [];
  const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
  // The lease this delivery holds once it has claimed the row. The row-reading
  // seams above are plain callbacks rather than a store, so the harness OVERLAYS
  // the granted lease onto whatever they hand back — but only on a row that does
  // not already declare one, so a case can still put somebody else's lease on
  // the row and have it stick.
  let granted: { leaseId: string; leaseAt: number } | null = null;
  const leased = (row: ProofStorageDeleteInput | null): ProofStorageDeleteInput | null =>
    row !== null && granted !== null && row.leaseId === undefined ? { ...row, ...granted } : row;
  const deps = {
    objectDeletes,
    generationReads,
    claims,
    tombstoneDeletes: 0,
    retirementRefusals: 0,
    warnings,
    // A FRESH object on every read, so the identity check below is proven to
    // compare by VALUE — a reference-equality implementation would pass the
    // ordinary cases here and still mis-handle a real Firestore snapshot.
    currentTombstone: currentTombstone ?? (async () => ({ ...ownRow })),
    proofExists,
    // The REAL claim transaction, modelled: re-read, re-ask both pre-check
    // questions, and refuse a row another delivery still holds.
    claimSweepLease: async (identity: ProofStorageDeleteInput, lease: SweepLease) => {
      claims.push(lease);
      const standing = leased(await deps.currentTombstone());
      if (standing === null || !isSameRevocation(standing, identity)) return 'lost' as const;
      if (hasActiveSweepLease(standing, lease.at) && standing.leaseId !== lease.id) {
        return 'held' as const;
      }
      granted = { leaseId: lease.id, leaseAt: lease.at };
      return 'claimed' as const;
    },
    currentObjectGeneration: async (storagePath: string) => {
      generationReads.push(storagePath);
      return leaseOptions.objectGeneration === undefined
        ? SWEPT_GENERATION
        : leaseOptions.objectGeneration;
    },
    deleteObject: async (storagePath: string, generation: string) => {
      objectDeletes.push({ storagePath, generation });
      await deleteObject(storagePath);
    },
    // The REAL compare-and-delete, modelled: re-read the row and delete it only
    // while it is still the one this delivery is holding, under this delivery's
    // own lease. `index.ts` runs this inside `db.runTransaction`; here the
    // re-read is a seam so a case can put a DIFFERENT row there and prove the
    // retirement declines.
    retireTombstoneIfSame: async (identity: ProofStorageDeleteInput, leaseId: string | null) => {
      const standing = leased(await (atRetirement ?? deps.currentTombstone)());
      const ours =
        standing !== null &&
        isSameRevocation(standing, identity) &&
        (leaseId === null || standing.leaseId === leaseId);
      if (!ours) {
        deps.retirementRefusals += 1;
        return false;
      }
      deps.tombstoneDeletes += 1;
      return true;
    },
    now: leaseOptions.now ?? (() => 1_000_000),
    newLeaseId: () => `lease-${claims.length + 1}`,
    warn: (message: string, context: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
  };
  return deps;
}

/** The paths a successful sweep touched, without the generation column. */
const paths = (deleted: Array<{ storagePath: string }>) => deleted.map((d) => d.storagePath);

const TARGET = {
  eventId: 'med-2026',
  proofId: 'proof-1',
  tombstone: { storagePath: 'proofs/med-2026/alice/proof-1.jpg', uid: 'alice', requestedAt: 1000 },
};

/** The same row, carrying the generation `deleteProof` read off the object. */
const BOUND = {
  ...TARGET,
  tombstone: { ...TARGET.tombstone, generation: '1700000000000001' },
};

describe('revokeProofMedia — the server finishes a revocation the client could not (#134)', () => {
  it('deletes the object and only then retires the tombstone', async () => {
    const order: string[] = [];
    const deps = makeDeps(async () => {
      order.push('object');
    });
    const wrapped: RevokeProofMediaDeps = {
      ...deps,
      retireTombstoneIfSame: async (identity, leaseId) => {
        order.push('tombstone');
        return await deps.retireTombstoneIfSame(identity, leaseId);
      },
    };

    await revokeProofMedia(wrapped, TARGET);

    expect(paths(deps.objectDeletes)).toEqual(['proofs/med-2026/alice/proof-1.jpg']);
    expect(deps.tombstoneDeletes).toBe(1);
    expect(order).toEqual(['object', 'tombstone']);
  });

  it('counts "already gone" as success — the ordinary case, where the client won the race', async () => {
    // The deleting client's own Storage delete usually lands first, so the sweep
    // arrives at a missing object. Retrying that would hammer a discharged
    // revocation until the platform gave up and strand the tombstone forever.
    const deps = makeDeps(async () => {
      throw Object.assign(new Error('No such object'), { code: 404 });
    });

    await expect(revokeProofMedia(deps, TARGET)).resolves.toBeUndefined();

    expect(deps.tombstoneDeletes).toBe(1);
  });

  it('counts the client SDK’s own not-found code as success too', async () => {
    const deps = makeDeps(async () => {
      throw Object.assign(new Error('object not found'), { code: 'storage/object-not-found' });
    });

    await revokeProofMedia(deps, TARGET);

    expect(deps.tombstoneDeletes).toBe(1);
  });

  it('THROWS on any other Storage failure and leaves the tombstone standing', async () => {
    // `retry: true` on the trigger turns this into redelivery. Retiring the row
    // here would mark a revocation done that never happened, which is precisely
    // the state the tombstone exists to make impossible.
    const deps = makeDeps(async () => {
      throw Object.assign(new Error('backend error'), { code: 503 });
    });

    await expect(revokeProofMedia(deps, TARGET)).rejects.toThrow('backend error');

    expect(deps.tombstoneDeletes).toBe(0);
  });

  it('drops — never retries — a row whose path escapes its own Event and Proof', async () => {
    // `firestore.rules` pins the path at create, so nothing reachable produces
    // one. If one exists anyway it did not come through the rules, and no amount
    // of redelivery can make an unconfinable path confinable: retrying would only
    // buy an immortal poison row. The bucket is never touched.
    // The row STANDING at the path is the poison row — it is what triggered this
    // delivery — so the compare-and-delete matches and retires it.
    const poison = { ...TARGET.tombstone, storagePath: 'proofs/other-event/alice/proof-1.jpg' };
    const deps = makeDeps(async () => {}, undefined, undefined, poison);

    await revokeProofMedia(deps, { ...TARGET, tombstone: poison });

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(1);
    expect(deps.warnings).toHaveLength(1);
  });

  it('drops a row carrying no usable storagePath at all', async () => {
    const unusable = { uid: 'alice' };
    const deps = makeDeps(async () => {}, undefined, undefined, unusable);

    await revokeProofMedia(deps, { ...TARGET, tombstone: unusable });

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(1);
  });

  it('RETIRES a MALFORMED row on the defensive path, even when its fields are containers (#1153)', async () => {
    // Codex round 5 P2. `confinedProofMediaPath` refuses a non-string
    // `storagePath`, so an Admin-SDK-written row carrying an ARRAY there takes
    // the defensive branch — which drops the row rather than retrying, because
    // redelivery cannot make an unconfinable path confinable.
    //
    // Reference equality made that drop unreachable. The event snapshot and the
    // retirement transaction's own re-read deserialise the array into two
    // DIFFERENT JavaScript objects, so `isSameRevocation` reported two different
    // revocations for one unchanged row, `retireTombstoneIfSame` refused, and
    // the poison row stood forever — with the Proof create arm holding that id
    // for just as long, because the hold lifts only when the row is retired.
    //
    // Both reads here are DEEP copies, which is the point: a shallow spread
    // would share the array reference and let the old implementation pass.
    const poison: ProofStorageDeleteInput = {
      storagePath: ['proofs', 'med-2026', 'alice', 'proof-1.jpg'],
      uid: 'alice',
      requestedAt: 1000,
    };
    const readBack = (): ProofStorageDeleteInput => structuredClone(poison);
    const deps = makeDeps(
      async () => {
        throw new Error('the bucket must not be reached');
      },
      async () => false,
      readBack,
      poison,
      readBack,
    );

    await revokeProofMedia(deps, { ...TARGET, tombstone: poison });

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(1);
    expect(deps.retirementRefusals).toBe(0);
    expect(deps.warnings.map((w) => w.message)).toEqual([
      'proof media revocation refused: path outside its own Event/Proof',
    ]);
  });

  it('ABANDONS a delivery whose tombstone has already been retired — bucket untouched, nothing deleted', async () => {
    // The stale-delivery hazard (#1153, Phase 4b P2). The event snapshot
    // describes the row as it was CREATED; `retry: true` and ordinary delivery
    // latency both let this run long after the deleting client discharged the
    // revocation and cleared the row — which is the ORDINARY outcome, since the
    // client's own Storage delete usually wins the race.
    //
    // The moment that row goes, `firestore.rules` frees the Proof id for reuse.
    // A permitted re-post uploads its replacement media BEFORE it creates its
    // Proof document, so the Proof read below is still false, and a row whose
    // metadata read had failed carries no generation to protect the object — the
    // delayed delivery would delete the REPLACEMENT and leave the new Feed entry
    // pointing at nothing.
    //
    // So a missing row ends the delivery outright. Retirement is NOT
    // called either: there is nothing of ours left to retire, and a blind delete
    // at that path could only take a LATER revocation's row with it.
    const deps = makeDeps(
      async () => {
        throw new Error('the bucket must not be reached');
      },
      async () => false,
      async () => null,
    );

    await revokeProofMedia(deps, TARGET);

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(0);
    expect(deps.warnings).toHaveLength(1);
  });

  it('ABANDONS a delivery whose path now holds a DIFFERENT revocation — and leaves that row STANDING', async () => {
    // The reuse hazard the `.exists` recheck still admitted (#1153, Codex round
    // 3 P2). Retirement frees the Proof id, so the sequence is reachable:
    // delivery A is created, an earlier delivery retires A's row, the freed id
    // is re-posted and taken down again, and row B is now standing at the very
    // same path. `.exists` answers yes to B, so A proceeds on its own stale
    // snapshot — and A's generation takes `412` against B's object, after which
    // the unconditional retirement clears B while B's media is still in the
    // bucket. A real revocation marked done that never happened.
    //
    // So the standing row is compared against the event snapshot's own operation
    // identity, and a mismatch abandons: the bucket is never touched, and B's row
    // is left exactly where it is, because B's own delivery still owes it.
    const rowB: ProofStorageDeleteInput = {
      ...TARGET.tombstone,
      requestedAt: 9000,
      generation: '1700000000000002',
    };
    const deps = makeDeps(
      async () => {
        throw new Error('the bucket must not be reached');
      },
      async () => false,
      async () => rowB,
    );

    await revokeProofMedia(deps, BOUND);

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(0);
    expect(deps.warnings).toHaveLength(1);
    expect(deps.warnings[0].context).toMatchObject({
      requestedAt: 1000,
      standingRequestedAt: 9000,
    });
  });

  it('ABANDONS on ANY disagreeing field, generation PRESENCE included', async () => {
    // Each of the four is load-bearing. `generation` above all: a row that
    // records one and a row that does not are two different revocations even
    // when everything else matches, and the absent-generation row is precisely
    // the one that would sweep by PATH and take whatever now answers to it.
    const differing: ProofStorageDeleteInput[] = [
      { ...BOUND.tombstone, requestedAt: 2000 },
      { ...BOUND.tombstone, uid: 'bob' },
      { ...BOUND.tombstone, storagePath: 'proofs/med-2026/alice/proof-1.webm' },
      { ...BOUND.tombstone, generation: '1700000000000002' },
      { ...TARGET.tombstone },
    ];
    for (const standing of differing) {
      const deps = makeDeps(
        async () => {
          throw new Error('the bucket must not be reached');
        },
        async () => false,
        async () => standing,
      );

      await revokeProofMedia(deps, BOUND);

      expect(deps.objectDeletes).toEqual([]);
      expect(deps.tombstoneDeletes).toBe(0);
    }
  });

  it('REDELIVERS rather than deleting when it cannot tell whether the tombstone still stands', async () => {
    // Same rule as the Proof read: "I could not tell" must never resolve to
    // "delete it". The failure propagates with the row intact and `retry: true`
    // brings the sweep back.
    const deps = makeDeps(
      async () => {
        throw new Error('the bucket must not be reached');
      },
      async () => false,
      async () => {
        throw new Error('firestore unavailable');
      },
    );

    await expect(revokeProofMedia(deps, TARGET)).rejects.toThrow('firestore unavailable');

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(0);
  });

  it('asks whether the debt is still owed BEFORE the Proof and BEFORE the bucket, and LEASES before either', async () => {
    // Order is the claim, not merely presence: the row is re-read on EVERY
    // delivery and ahead of everything else, because a retired row makes every
    // later question one about somebody else's object. The ordinary delivery is
    // otherwise unchanged — object first, tombstone after.
    //
    // And the lease is taken before the Proof read, the metadata read and the
    // delete alike (#1153, Codex round 6 P2). That is the whole point of it:
    // every read that authorises the bucket call has to happen INSIDE the window
    // no other delivery can be working in, not before it.
    const order: string[] = [];
    const deps = makeDeps(
      async () => {
        order.push('object-delete');
      },
      async () => {
        order.push('proof');
        return false;
      },
      async () => {
        order.push('tombstone-read');
        return { ...TARGET.tombstone };
      },
    );
    const wrapped: RevokeProofMediaDeps = {
      ...deps,
      claimSweepLease: async (identity, lease) => {
        order.push('lease-claim');
        return await deps.claimSweepLease(identity, lease);
      },
      currentObjectGeneration: async (storagePath) => {
        order.push('object-generation');
        return await deps.currentObjectGeneration(storagePath);
      },
      retireTombstoneIfSame: async (identity, leaseId) => {
        order.push('tombstone-retire');
        return await deps.retireTombstoneIfSame(identity, leaseId);
      },
    };

    await revokeProofMedia(wrapped, TARGET);

    // The `tombstone-read` inside `lease-claim` and the trailing one are the
    // claim's and the RETIREMENT's own re-reads (#1153, Codex rounds 4 P2 and 6
    // P2): both are compare-and-swap against the row as it stands at that moment,
    // not operations authorised by the pre-check at the top.
    expect(order).toEqual([
      'tombstone-read',
      'lease-claim',
      'tombstone-read',
      'proof',
      'object-generation',
      'object-delete',
      'tombstone-retire',
      'tombstone-read',
    ]);
    expect(paths(deps.objectDeletes)).toEqual(['proofs/med-2026/alice/proof-1.jpg']);
  });

  it('SKIPS the bucket entirely when a Proof document holds this id again', async () => {
    // The reuse hazard (#1153, Phase 4b P1). A standing tombstone is supposed to
    // mean a Proof that is already gone — `firestore.rules` admits the row only
    // alongside its own Proof's deletion, and the Proof create arm now refuses
    // to bring the id back while the row stands. But the Admin SDK bypasses both
    // and this handler holds a bucket-wide delete, so the sweeper ASKS rather
    // than assuming: media a live Feed entry points at is never revoked on the
    // strength of a row written about an earlier Proof. The row still goes,
    // because redelivery cannot make a live Proof absent.
    const deps = makeDeps(
      async () => {
        throw new Error('the bucket must not be reached');
      },
      async () => true,
      undefined,
      BOUND.tombstone,
    );

    await revokeProofMedia(deps, BOUND);

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(1);
    expect(deps.warnings).toHaveLength(1);
  });

  it('REDELIVERS rather than deleting when it cannot tell whether the Proof is back', async () => {
    // "I could not read the Proof" must never resolve to "delete the media", so
    // the read failure propagates with the row intact and `retry: true` brings
    // the sweep back.
    const deps = makeDeps(
      async () => {},
      async () => {
        throw new Error('firestore unavailable');
      },
    );

    await expect(revokeProofMedia(deps, TARGET)).rejects.toThrow('firestore unavailable');

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(0);
  });

  it('binds the delete to the generation the row recorded, and asks the bucket when it recorded none', async () => {
    const bound = makeDeps(async () => {}, undefined, undefined, BOUND.tombstone);
    await revokeProofMedia(bound, BOUND);
    expect(bound.objectDeletes).toEqual([
      { storagePath: 'proofs/med-2026/alice/proof-1.jpg', generation: '1700000000000001' },
    ]);
    // The row named the object, so nothing is asked of the bucket first.
    expect(bound.generationReads).toEqual([]);

    // A row written before this existed, or by a client whose metadata read
    // failed, is NOT revoked by bare path (#1153, Codex round 6 P2). It reads the
    // generation the object carries right now — under the lease claimed above,
    // so nothing can replace the object between the read and the delete — and
    // binds the delete to THAT.
    const unbound = makeDeps(async () => {});
    await revokeProofMedia(unbound, TARGET);
    expect(unbound.generationReads).toEqual(['proofs/med-2026/alice/proof-1.jpg']);
    expect(unbound.objectDeletes).toEqual([
      { storagePath: 'proofs/med-2026/alice/proof-1.jpg', generation: SWEPT_GENERATION },
    ]);

    // A non-string generation is no generation: the row is client-written and
    // this handler holds a bucket-wide delete, so a value it cannot use is
    // ignored rather than passed through to the precondition — and the bucket is
    // asked instead, exactly as for an absent one.
    const junkRow = { ...TARGET.tombstone, generation: 17 };
    const junk = makeDeps(async () => {}, undefined, undefined, junkRow);
    await revokeProofMedia(junk, { ...TARGET, tombstone: junkRow });
    expect(junk.objectDeletes[0].generation).toBe(SWEPT_GENERATION);
  });

  it('NEVER issues an unbound delete — the seam cannot even express one (#1153)', async () => {
    // Codex round 6 P2, stated as an invariant over every path that reaches the
    // bucket rather than case by case. `null` was the shape a stale delivery used
    // to take a live re-post's media with; there is no call left that produces it.
    for (const row of [TARGET.tombstone, BOUND.tombstone, { ...TARGET.tombstone, generation: '' }]) {
      const deps = makeDeps(async () => {}, undefined, undefined, row);
      await revokeProofMedia(deps, { ...TARGET, tombstone: row });
      expect(deps.objectDeletes).toHaveLength(1);
      expect(typeof deps.objectDeletes[0].generation).toBe('string');
      expect(deps.objectDeletes[0].generation).not.toBe('');
    }
  });

  it('retires WITHOUT a bucket call when the object is already gone at the metadata read', async () => {
    // The ordinary discharged revocation on a generation-less row: the deleting
    // client's own inline Storage delete won the race, so there is nothing at the
    // path to bind a delete to. That is success, not a failure to retry — the same
    // answer the 404 from the delete itself has always produced.
    const deps = makeDeps(
      async () => {
        throw new Error('the bucket delete must not be reached');
      },
      undefined,
      undefined,
      TARGET.tombstone,
      undefined,
      { objectGeneration: null },
    );

    await revokeProofMedia(deps, TARGET);

    expect(deps.generationReads).toEqual(['proofs/med-2026/alice/proof-1.jpg']);
    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(1);
    expect(deps.warnings.map((w) => w.message)).toEqual([
      'proof media revocation: the object was already gone before the delete',
    ]);
  });

  it('LEAVES a re-uploaded object alone when the generation no longer matches', async () => {
    // 412 is Cloud Storage answering "that is not the object you asked about".
    // The only way to reach it is that the name was re-occupied after the row
    // was written, so the bytes there now belong to a write this revocation says
    // nothing about. Retiring rather than retrying, because redelivery cannot
    // turn the old generation back up.
    const deps = makeDeps(
      async () => {
        throw Object.assign(new Error('Precondition Failed'), { code: 412 });
      },
      undefined,
      undefined,
      BOUND.tombstone,
    );

    await expect(revokeProofMedia(deps, BOUND)).resolves.toBeUndefined();

    expect(deps.tombstoneDeletes).toBe(1);
    expect(deps.warnings).toHaveLength(1);
  });

  it('LEAVES a row that was REPLACED between the pre-check and the retirement (#1153)', async () => {
    // Codex round 4 P2, and the reason retirement is a compare-and-delete rather
    // than a delete. `currentTombstone()` is a pre-check taken at one instant;
    // the retirement it authorises happens at a later one, after a bucket round
    // trip. Duplicate delivery A validates row A, pauses, and A2 discharges and
    // retires it; the rules FREE the Proof id the moment that lands, so the id
    // is re-posted and taken down again and row B is standing at the same path
    // when A resumes. A's generation answers 412 against B's object — and an
    // UNCONDITIONAL retirement would then delete B, whose own delivery would
    // find no tombstone, abandon by design, and leave B's media in the bucket.
    //
    // So the identity is re-checked INSIDE the transaction that deletes: B is
    // left exactly where it is, its own delivery still owed.
    //
    // Since the sweep lease (Codex round 6 P2) this whole sequence needs A's
    // lease to have EXPIRED first — A2 cannot claim a row A still holds. It is
    // still reachable, which is why the compare-and-delete stays: a lease is
    // wall-clock liveness, and an overtaken holder must still be refused.
    const rowB = { ...BOUND.tombstone, requestedAt: 9000, generation: '1700000000000002' };
    const deps = makeDeps(
      async () => {
        throw Object.assign(new Error('Precondition Failed'), { code: 412 });
      },
      undefined,
      undefined,
      BOUND.tombstone,
      // Row A stood at the pre-check; row B stands by the time the retirement
      // re-reads. This seam IS the window the transaction closes.
      async () => rowB,
    );

    await expect(revokeProofMedia(deps, BOUND)).resolves.toBeUndefined();

    expect(deps.tombstoneDeletes).toBe(0);
    expect(deps.retirementRefusals).toBe(1);
    expect(deps.warnings.map((w) => w.message)).toEqual([
      'proof media revocation skipped: the object was replaced after the tombstone',
      'proof media revocation: the tombstone was NOT retired — the row there is no longer ours',
    ]);
  });

  it('still retires the row on the ORDINARY delivery, where nothing moved (#1153)', async () => {
    // The control the case above needs: the compare-and-delete is a guard on a
    // race, not a new refusal. When the row that triggered the delivery is still
    // the row standing at retirement time — which is every ordinary sweep — the
    // object goes and the row goes with it, and the successful path logs nothing.
    const deps = makeDeps(async () => {}, undefined, undefined, BOUND.tombstone, async () => ({
      ...BOUND.tombstone,
    }));

    await revokeProofMedia(deps, BOUND);

    expect(paths(deps.objectDeletes)).toEqual(['proofs/med-2026/alice/proof-1.jpg']);
    expect(deps.tombstoneDeletes).toBe(1);
    expect(deps.retirementRefusals).toBe(0);
    expect(deps.warnings).toEqual([]);
  });

  it('logs through console.warn when no sink is injected', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await revokeProofMedia(
        {
          currentTombstone: async () => ({ ...TARGET.tombstone }),
          proofExists: async () => false,
          claimSweepLease: async () => 'claimed',
          currentObjectGeneration: async () => SWEPT_GENERATION,
          deleteObject: async () => {
            throw new Error('the bucket must not be reached');
          },
          retireTombstoneIfSame: async () => true,
        },
        { ...TARGET, tombstone: { storagePath: 'nonsense' } },
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// A FAITHFUL LITTLE WORLD: one Firestore row, one bucket object, shared by every
// delivery in a case (#1153, Codex round 6 P2). The callback harness above is
// enough for a single delivery's decision table, but the hazard this suite is
// about is two deliveries INTERLEAVING — so these cases need state that one
// delivery's writes are visible to the other's reads, exactly as Firestore and
// Cloud Storage behave.
function makeWorld(initial: {
  row: ProofStorageDeleteInput | null;
  object: { generation: string } | null;
  proofExists?: boolean;
  now?: number;
}) {
  const world = {
    row: initial.row,
    object: initial.object,
    proofExists: initial.proofExists ?? false,
    now: initial.now ?? 1_000_000,
  };

  /** One delivery's seams, all bound to the shared world above. */
  function delivery(leaseId: string): RevokeProofMediaDeps & {
    objectDeletes: Array<{ storagePath: string; generation: string | null }>;
    warnings: Array<{ message: string; context: Record<string, unknown> }>;
  } {
    const objectDeletes: Array<{ storagePath: string; generation: string | null }> = [];
    const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
    return {
      objectDeletes,
      warnings,
      // Firestore hands back a fresh object per read, so nothing here can be
      // mutated through a reference a delivery is still holding.
      currentTombstone: async () => (world.row === null ? null : structuredClone(world.row)),
      proofExists: async () => world.proofExists,
      claimSweepLease: async (identity, lease) => {
        const row = world.row;
        if (row === null) return 'lost';
        if (!isSameRevocation(row, identity)) return 'lost';
        if (hasActiveSweepLease(row, lease.at) && row.leaseId !== lease.id) return 'held';
        world.row = { ...row, leaseId: lease.id, leaseAt: lease.at };
        return 'claimed';
      },
      currentObjectGeneration: async () => world.object?.generation ?? null,
      // The bucket, modelled — INCLUDING the shape a delete with no generation
      // takes, which is what makes a reverted fix visibly destroy the wrong
      // bytes rather than quietly no-op. `ifGenerationMatch` is a precondition,
      // and omitting it means "whatever answers to this name".
      deleteObject: async (storagePath, generation) => {
        objectDeletes.push({ storagePath, generation: generation ?? null });
        if (world.object === null) throw Object.assign(new Error('No such object'), { code: 404 });
        if (generation != null && world.object.generation !== generation) {
          throw Object.assign(new Error('Precondition Failed'), { code: 412 });
        }
        world.object = null;
      },
      retireTombstoneIfSame: async (identity, id) => {
        const row = world.row;
        if (row === null) return false;
        if (!isSameRevocation(row, identity)) return false;
        if (id !== null && row.leaseId !== id) return false;
        world.row = null;
        return true;
      },
      now: () => world.now,
      newLeaseId: () => leaseId,
      warn: (message, context) => {
        warnings.push({ message, context });
      },
    };
  }

  return { world, delivery };
}

describe('the sweep lease — exclusive processing through the bucket delete (#1153)', () => {
  // Codex round 6 P2. The compare-and-delete of round 4 protected the
  // RETIREMENT; the bucket call in front of it was still authorised by reads
  // taken before it, and nothing serialised two deliveries across it.
  const UNBOUND = { storagePath: 'proofs/med-2026/alice/proof-1.jpg', uid: 'alice', requestedAt: 1000 };

  it('leaves a re-posted Proof’s LIVE media alone when a stale duplicate resumes mid-sweep', async () => {
    // THE FINDING, exactly as reported. The row carries no `generation` because
    // the deleting client's metadata read failed, which is the case the old code
    // fell back to an unconditioned path delete for.
    //
    // Duplicate deliveries A and A2 both pass the two Firestore pre-checks; A
    // pauses; A2 deletes the old object and retires the row; the rules free the
    // Proof id, which is re-posted with NEW media uploaded to the very same path
    // before its Proof document is created — so the Proof read is still false.
    // A then resumes into the delete. Under the old code that delete was
    // unconditioned and took the replacement's bytes.
    const { world, delivery } = makeWorld({ row: { ...UNBOUND }, object: { generation: 'gen-A' } });
    const a = delivery('lease-A');
    const a2 = delivery('lease-A2');

    // A's pre-check read is where it pauses. Everything the world does while it
    // is paused happens INSIDE that await, which is the interleaving.
    const aReads = a.currentTombstone;
    const paused: RevokeProofMediaDeps = {
      ...a,
      currentTombstone: async () => {
        const seen = await aReads();
        await revokeProofMedia(a2, { ...TARGET, tombstone: { ...UNBOUND } });
        // The freed id, re-posted: new bytes at the same name.
        world.object = { generation: 'gen-B' };
        return seen;
      },
    };

    await revokeProofMedia(paused, { ...TARGET, tombstone: { ...UNBOUND } });

    // A2 did its job: the ORIGINAL object went and the row was retired.
    expect(paths(a2.objectDeletes)).toEqual(['proofs/med-2026/alice/proof-1.jpg']);
    // And A, resuming, touched nothing at all — it never got the lease, because
    // there was no longer a row of its own to claim.
    expect(a.objectDeletes).toEqual([]);
    expect(world.object).toEqual({ generation: 'gen-B' });
    expect(a.warnings.map((w) => w.message)).toEqual([
      'proof media revocation abandoned: the row changed before the sweep lease was taken',
    ]);
  });

  it('DEFERS a second delivery while the first still holds the lease — bucket and row untouched', async () => {
    // The narrower interleaving, where A has already CLAIMED before A2 arrives.
    // A2 must not delete, must not retire, and must not steal the lease: A is
    // discharging the revocation right now.
    //
    // And A2 must REJECT rather than resolve. Nothing was discharged on its
    // behalf, and `retry: true` redelivers a rejected delivery and only a
    // rejected one — so acking here would end the retry chain for a revocation
    // that a FAILED holder (whose lease outlives its own rejection by the TTL)
    // may well still owe. That is the durability regression an "abandon quietly"
    // would have shipped.
    const { world, delivery } = makeWorld({ row: { ...UNBOUND }, object: { generation: 'gen-A' } });
    const a = delivery('lease-A');
    const a2 = delivery('lease-A2');

    // A pauses AFTER claiming — between the lease and the bucket — which is the
    // window A2 must find closed.
    const aGeneration = a.currentObjectGeneration;
    let a2Rejected: unknown;
    const paused: RevokeProofMediaDeps = {
      ...a,
      currentObjectGeneration: async (storagePath) => {
        a2Rejected = await revokeProofMedia(a2, { ...TARGET, tombstone: { ...UNBOUND } }).catch(
          (err: unknown) => err,
        );
        return await aGeneration(storagePath);
      },
    };

    await revokeProofMedia(paused, { ...TARGET, tombstone: { ...UNBOUND } });

    expect(a2.objectDeletes).toEqual([]);
    expect(a2Rejected).toBeInstanceOf(Error);
    expect((a2Rejected as Error).message).toContain('held by another sweep delivery');
    expect(a2.warnings.map((w) => w.message)).toEqual([
      'proof media revocation deferred: another delivery holds the sweep lease',
    ]);
    // A, the holder, still finishes normally: one bound delete, and the row goes.
    expect(a.objectDeletes).toEqual([
      { storagePath: 'proofs/med-2026/alice/proof-1.jpg', generation: 'gen-A' },
    ]);
    expect(world.object).toBeNull();
    expect(world.row).toBeNull();
  });

  it('REDELIVERS a deferred delivery into a lease that has since aged out', async () => {
    // The other half of the deferral, and what makes it a deferral rather than a
    // loss: the holder failed and never came back, so the redelivery that lands
    // past the TTL claims the row and discharges the revocation. Without the
    // rejection above there would BE no redelivery to land.
    const { world, delivery } = makeWorld({ row: { ...UNBOUND }, object: { generation: 'gen-A' } });
    const stalled = delivery('lease-stalled');
    expect(await stalled.claimSweepLease({ ...UNBOUND }, { id: 'lease-stalled', at: world.now })).toBe(
      'claimed',
    );

    // The redelivery, arriving before the lease ages out: refused, and rejected.
    const soon = delivery('lease-soon');
    await expect(
      revokeProofMedia(soon, { ...TARGET, tombstone: { ...UNBOUND } }),
    ).rejects.toThrow('held by another sweep delivery');
    expect(soon.objectDeletes).toEqual([]);
    expect(world.row).not.toBeNull();

    // The one after it, past the TTL: claims, sweeps, retires.
    world.now += SWEEP_LEASE_TTL_MS;
    const later = delivery('lease-later');
    await revokeProofMedia(later, { ...TARGET, tombstone: { ...UNBOUND } });
    expect(later.objectDeletes).toEqual([
      { storagePath: 'proofs/med-2026/alice/proof-1.jpg', generation: 'gen-A' },
    ]);
    expect(world.object).toBeNull();
    expect(world.row).toBeNull();
  });

  it('lets an EXPIRED lease be re-claimed, and refuses the overtaken holder’s retirement', async () => {
    // A lease has to expire or a holder that crashed mid-sweep would hold the
    // revocation forever — the media in the bucket, the row standing, and the
    // Proof create arm's hold on that id standing with it. So B takes the row
    // once the TTL has passed. A, if it somehow resumes, must not then retire a
    // row that is no longer its own to retire: B's bucket call may still be
    // outstanding, and retiring would free the Proof id underneath it.
    const { world, delivery } = makeWorld({ row: { ...UNBOUND }, object: { generation: 'gen-A' } });
    const a = delivery('lease-A');

    expect(await a.claimSweepLease({ ...UNBOUND }, { id: 'lease-A', at: world.now })).toBe('claimed');
    expect(world.row?.leaseId).toBe('lease-A');

    // One millisecond inside the TTL: still A's.
    const b = delivery('lease-B');
    const justInside = world.now + SWEEP_LEASE_TTL_MS - 1;
    expect(await b.claimSweepLease({ ...UNBOUND }, { id: 'lease-B', at: justInside })).toBe('held');
    expect(world.row?.leaseId).toBe('lease-A');

    // One past it: B takes over.
    const expired = world.now + SWEEP_LEASE_TTL_MS;
    expect(await b.claimSweepLease({ ...UNBOUND }, { id: 'lease-B', at: expired })).toBe('claimed');
    expect(world.row?.leaseId).toBe('lease-B');

    // A, overtaken, may not retire — even though the row is unmistakably still
    // the same revocation it was created for.
    expect(await a.retireTombstoneIfSame({ ...UNBOUND }, 'lease-A')).toBe(false);
    expect(world.row).not.toBeNull();
    // B, the holder, may.
    expect(await b.retireTombstoneIfSame({ ...UNBOUND }, 'lease-B')).toBe(true);
    expect(world.row).toBeNull();
  });

  it('does NOT retire when this delivery’s lease was overtaken mid-sweep', async () => {
    // The end-to-end half of the case above: the lease id has to be THREADED to
    // the retirement, not merely checkable. A sweeps, its lease ages out and B
    // claims the row while A is still between the lease and the bucket; A's
    // delete then lands, but the row is no longer A's to retire. Retiring it
    // would free the Proof id underneath B, whose own bucket call is outstanding
    // — the exact shape of "a revocation marked done that never happened", one
    // holder removed.
    const { world, delivery } = makeWorld({ row: { ...UNBOUND }, object: { generation: 'gen-A' } });
    const a = delivery('lease-A');
    const b = delivery('lease-B');

    const aGeneration = a.currentObjectGeneration;
    const overtaken: RevokeProofMediaDeps = {
      ...a,
      currentObjectGeneration: async (storagePath) => {
        // A's lease ages out and B takes the row, all inside A's own await.
        const claimed = await b.claimSweepLease(
          { ...UNBOUND },
          { id: 'lease-B', at: world.now + SWEEP_LEASE_TTL_MS },
        );
        expect(claimed).toBe('claimed');
        return await aGeneration(storagePath);
      },
    };

    await revokeProofMedia(overtaken, { ...TARGET, tombstone: { ...UNBOUND } });

    // A's delete still landed — it was bound to the generation it read, so it
    // could only ever have taken that object.
    expect(a.objectDeletes).toEqual([
      { storagePath: 'proofs/med-2026/alice/proof-1.jpg', generation: 'gen-A' },
    ]);
    // But the row is still standing, and still B's.
    expect(world.row).not.toBeNull();
    expect(world.row?.leaseId).toBe('lease-B');
    expect(a.warnings.map((w) => w.message)).toEqual([
      'proof media revocation: the tombstone was NOT retired — the row there is no longer ours',
    ]);
  });

  it('re-takes a lease this delivery already holds, so a transaction retry is idempotent', async () => {
    // The claim runs inside `db.runTransaction`, which re-runs its callback on
    // contention. A delivery must not lock itself out of its own row.
    const { world, delivery } = makeWorld({ row: { ...UNBOUND }, object: { generation: 'gen-A' } });
    const a = delivery('lease-A');
    const lease: SweepLease = { id: 'lease-A', at: world.now };

    expect(await a.claimSweepLease({ ...UNBOUND }, lease)).toBe('claimed');
    expect(await a.claimSweepLease({ ...UNBOUND }, lease)).toBe('claimed');
  });

  it('sweeps the ORDINARY delivery unchanged — one bound delete, then the row', async () => {
    // The control every guard above needs: with nothing racing, a generation-less
    // row is still discharged, and it is discharged against the object that is
    // actually there rather than against its name.
    const { world, delivery } = makeWorld({ row: { ...UNBOUND }, object: { generation: 'gen-A' } });
    const only = delivery('lease-A');

    await revokeProofMedia(only, { ...TARGET, tombstone: { ...UNBOUND } });

    expect(only.objectDeletes).toEqual([
      { storagePath: 'proofs/med-2026/alice/proof-1.jpg', generation: 'gen-A' },
    ]);
    expect(world.object).toBeNull();
    expect(world.row).toBeNull();
    expect(only.warnings).toEqual([]);
  });
});

describe('hasActiveSweepLease — is this row still somebody’s to sweep (#1153)', () => {
  const AT = 1_000_000;

  it('is active inside the TTL and expired at it', () => {
    expect(hasActiveSweepLease({ leaseId: 'a', leaseAt: AT }, AT)).toBe(true);
    expect(hasActiveSweepLease({ leaseId: 'a', leaseAt: AT }, AT + SWEEP_LEASE_TTL_MS - 1)).toBe(true);
    expect(hasActiveSweepLease({ leaseId: 'a', leaseAt: AT }, AT + SWEEP_LEASE_TTL_MS)).toBe(false);
  });

  it('expires a stamp far in the FUTURE too, so a skewed clock cannot pin the row', () => {
    // The lease is wall-clock bookkeeping shared between instances whose clocks
    // are merely close. Measured in one direction only, an instance running an
    // hour fast would hold every row it touched for an hour after it had gone.
    expect(hasActiveSweepLease({ leaseId: 'a', leaseAt: AT + SWEEP_LEASE_TTL_MS - 1 }, AT)).toBe(true);
    expect(hasActiveSweepLease({ leaseId: 'a', leaseAt: AT + SWEEP_LEASE_TTL_MS }, AT)).toBe(false);
  });

  it('treats a lease it cannot read as NO lease at all', () => {
    // The safe direction, and the same reasoning the structural comparison
    // shipped for (Codex round 5 P2): a row no delivery could ever claim is a row
    // no delivery could ever discharge or retire, which is an immortal poison row
    // with the Proof id held behind it. Only the Admin SDK can write these two
    // fields, and it writes them together.
    expect(hasActiveSweepLease({}, AT)).toBe(false);
    expect(hasActiveSweepLease({ leaseId: 'a' }, AT)).toBe(false);
    expect(hasActiveSweepLease({ leaseAt: AT }, AT)).toBe(false);
    expect(hasActiveSweepLease({ leaseId: '', leaseAt: AT }, AT)).toBe(false);
    expect(hasActiveSweepLease({ leaseId: 7, leaseAt: AT }, AT)).toBe(false);
    expect(hasActiveSweepLease({ leaseId: 'a', leaseAt: 'soon' }, AT)).toBe(false);
    expect(hasActiveSweepLease({ leaseId: 'a', leaseAt: Number.NaN }, AT)).toBe(false);
    expect(hasActiveSweepLease({ leaseId: 'a', leaseAt: Number.POSITIVE_INFINITY }, AT)).toBe(false);
  });
});

describe('isSameRevocation — is the standing row the one THIS delivery was created for', () => {
  const ROW: ProofStorageDeleteInput = {
    storagePath: 'proofs/med-2026/alice/proof-1.jpg',
    uid: 'alice',
    requestedAt: 1000,
    generation: '1700000000000001',
  };

  it('accepts an equal row read back as a separate object', () => {
    // Two readings of ONE row: the fields cannot change while it stands, because
    // `firestore.rules` denies every update on the collection.
    expect(isSameRevocation({ ...ROW }, { ...ROW })).toBe(true);
  });

  it('rejects a disagreement in ANY of the four identity fields', () => {
    expect(isSameRevocation({ ...ROW, requestedAt: 1001 }, ROW)).toBe(false);
    expect(isSameRevocation({ ...ROW, uid: 'bob' }, ROW)).toBe(false);
    expect(isSameRevocation({ ...ROW, storagePath: 'proofs/med-2026/alice/proof-1.webm' }, ROW)).toBe(
      false,
    );
    expect(isSameRevocation({ ...ROW, generation: '1700000000000002' }, ROW)).toBe(false);
  });

  it('treats generation PRESENCE as part of the identity, in both directions', () => {
    // A row that recorded a generation and a row that did not are two different
    // revocations even when the other three agree — and the absent-generation
    // one is exactly the row that would sweep by PATH and take whatever now
    // answers to it.
    const withoutGeneration: ProofStorageDeleteInput = {
      storagePath: ROW.storagePath,
      uid: ROW.uid,
      requestedAt: ROW.requestedAt,
    };
    expect(isSameRevocation(withoutGeneration, ROW)).toBe(false);
    expect(isSameRevocation(ROW, withoutGeneration)).toBe(false);
    expect(isSameRevocation({ ...withoutGeneration }, withoutGeneration)).toBe(true);
  });

  it('IGNORES the sweep lease, which is the one thing on the row that moves (#1153)', () => {
    // Codex round 6 P2. `leaseId` / `leaseAt` are written by the sweeper itself,
    // so a row that has just been claimed is the same revocation it was a
    // moment earlier. Folding them into the identity would make every delivery's
    // own claim look like somebody else's row: the retirement immediately after
    // it would compare the leased row against the unleased event snapshot,
    // refuse, and strand every revocation this module ever discharged.
    expect(isSameRevocation({ ...ROW, leaseId: 'lease-A', leaseAt: 1_000_000 }, ROW)).toBe(true);
    expect(isSameRevocation({ ...ROW, leaseId: 'lease-A' }, { ...ROW, leaseId: 'lease-B' })).toBe(
      true,
    );
    // …and it is only the LEASE that is exempt: a real disagreement beside one
    // still mismatches.
    expect(isSameRevocation({ ...ROW, leaseId: 'lease-A', uid: 'bob' }, ROW)).toBe(false);
  });

  it('matches a CONTAINER field that is equal by structure but not by reference (#1153)', () => {
    // Codex round 5 P2. `firestore.rules` type-checks all four fields, so no
    // reachable row carries a map or an array — but the Admin SDK bypasses the
    // rules, and such a row is exactly the poison row `revokeProofMedia`'s
    // malformed-path branch exists to RETIRE. Firestore deserialises a container
    // into a fresh JavaScript object on every read, so reference equality said
    // "a different revocation" about one unchanged row, the retirement refused,
    // and the row stood forever with the Proof id held behind it.
    //
    // `structuredClone` is the point: these two readings share no references.
    const mapRow: ProofStorageDeleteInput = {
      ...ROW,
      storagePath: { bucket: 'b', segments: ['proofs', 'med-2026'], meta: { deep: [1, 2] } },
    };
    expect(isSameRevocation(structuredClone(mapRow), structuredClone(mapRow))).toBe(true);
    const arrayRow: ProofStorageDeleteInput = { ...ROW, uid: ['alice', { alias: 'a' }] };
    expect(isSameRevocation(structuredClone(arrayRow), structuredClone(arrayRow))).toBe(true);
  });

  it('still MISMATCHES a container row whose other fields disagree', () => {
    // The control the case above needs: structural comparison is what makes an
    // unchanged malformed row retirable, not a licence to treat two different
    // rows as one. A different `requestedAt` is still a different revocation,
    // and so is a container that differs one level down.
    const mapRow: ProofStorageDeleteInput = {
      ...ROW,
      storagePath: { bucket: 'b', segments: ['proofs', 'med-2026'] },
    };
    expect(
      isSameRevocation(structuredClone(mapRow), { ...structuredClone(mapRow), requestedAt: 1001 }),
    ).toBe(false);
    expect(
      isSameRevocation(structuredClone(mapRow), {
        ...ROW,
        storagePath: { bucket: 'b', segments: ['proofs', 'other-event'] },
      }),
    ).toBe(false);
    // A key present on one side only is a disagreement, not a field skipped.
    expect(
      isSameRevocation(structuredClone(mapRow), {
        ...ROW,
        storagePath: { bucket: 'b', segments: ['proofs', 'med-2026'], extra: 1 },
      }),
    ).toBe(false);
  });
});

describe('sameFirestoreValue — two readings, one stored value (#1153)', () => {
  it('is plain `===` for every value a well-formed row carries', () => {
    expect(sameFirestoreValue('proofs/a/b/c.jpg', 'proofs/a/b/c.jpg')).toBe(true);
    expect(sameFirestoreValue(1000, 1000)).toBe(true);
    expect(sameFirestoreValue(1000, 1001)).toBe(false);
    expect(sameFirestoreValue(true, false)).toBe(false);
    // Present-against-absent, which `isSameRevocation` leans on for `generation`.
    expect(sameFirestoreValue(undefined, undefined)).toBe(true);
    expect(sameFirestoreValue(null, null)).toBe(true);
    expect(sameFirestoreValue(undefined, null)).toBe(false);
    expect(sameFirestoreValue(null, '')).toBe(false);
    expect(sameFirestoreValue(undefined, '1700000000000001')).toBe(false);
    // Never a loose comparison: a string is not the number it spells.
    expect(sameFirestoreValue('1000', 1000)).toBe(false);
    expect(sameFirestoreValue(0, false)).toBe(false);
  });

  it('compares arrays and maps by structure, recursively', () => {
    expect(sameFirestoreValue([1, 'a', { b: [2] }], [1, 'a', { b: [2] }])).toBe(true);
    expect(sameFirestoreValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameFirestoreValue([1, 2], [2, 1])).toBe(false);
    expect(sameFirestoreValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameFirestoreValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameFirestoreValue({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    // Containers of different KINDS are never equal, whatever they hold.
    expect(sameFirestoreValue([], {})).toBe(false);
  });

  it('uses the Admin SDK value types’ own `isEqual`, and needs it on both sides', () => {
    // `Timestamp`, `GeoPoint` and `DocumentReference` all publish `isEqual`, so
    // the SDK's own answer is used rather than an import or a field-name guess.
    class FakeTimestamp {
      constructor(
        readonly seconds: number,
        readonly nanoseconds: number,
      ) {}
      isEqual(other: unknown): boolean {
        return (
          other instanceof FakeTimestamp &&
          other.seconds === this.seconds &&
          other.nanoseconds === this.nanoseconds
        );
      }
    }
    expect(sameFirestoreValue(new FakeTimestamp(1, 2), new FakeTimestamp(1, 2))).toBe(true);
    expect(sameFirestoreValue(new FakeTimestamp(1, 2), new FakeTimestamp(1, 3))).toBe(false);
    // A library type is never asked to compare itself against a plain map: that
    // falls through to the plain-object branch, which refuses a class instance.
    expect(sameFirestoreValue(new FakeTimestamp(1, 2), { seconds: 1, nanoseconds: 2 })).toBe(false);
  });

  it('compares bytes by content, and refuses anything it cannot reason about', () => {
    expect(sameFirestoreValue(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(sameFirestoreValue(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(sameFirestoreValue(Buffer.from('abc'), Buffer.from('ab'))).toBe(false);
    // A class instance with no `isEqual` is not a Firestore map, so it compares
    // unequal unless it is literally the same object — the safe direction, since
    // a false POSITIVE would retire somebody else's revocation.
    class Opaque {
      constructor(readonly v: number) {}
    }
    const one = new Opaque(1);
    expect(sameFirestoreValue(one, one)).toBe(true);
    expect(sameFirestoreValue(new Opaque(1), new Opaque(1))).toBe(false);
    expect(sameFirestoreValue(new Date(0), new Date(0))).toBe(false);
  });
});

describe('confinedProofMediaPath — may THIS trigger delete THAT object', () => {
  const OK = 'proofs/med-2026/alice/proof-1.jpg';

  it('accepts the object named after its own Event, owner and Proof', () => {
    expect(confinedProofMediaPath(OK, 'med-2026', 'proof-1')).toBe(OK);
  });

  it('accepts the audio extensions the same naming convention produces', () => {
    for (const ext of ['webm', 'm4a']) {
      const path = `proofs/med-2026/alice/proof-1.${ext}`;
      expect(confinedProofMediaPath(path, 'med-2026', 'proof-1')).toBe(path);
    }
  });

  it('strips only the FINAL extension, so a dotted Proof id is matched whole', () => {
    // Firestore permits a Proof id carrying a dot (`p.q`, media `p.q.jpg`), and
    // splitting on the FIRST one compares `p` against the id and refuses a
    // perfectly legitimate row — which here would strand its media forever,
    // since the sweeper drops an unconfinable path rather than retrying it.
    // Same trap `storage.rules`' orphan carve-out fixed in Phase 4b P1 on
    // PR #1157.
    const path = 'proofs/med-2026/alice/p.q.jpg';
    expect(confinedProofMediaPath(path, 'med-2026', 'p.q')).toBe(path);
    expect(confinedProofMediaPath(path, 'med-2026', 'p')).toBeNull();
  });

  it('refuses another Event, another Proof, another prefix, and a traversal', () => {
    expect(confinedProofMediaPath(OK, 'other-event', 'proof-1')).toBeNull();
    expect(confinedProofMediaPath(OK, 'med-2026', 'proof-2')).toBeNull();
    expect(confinedProofMediaPath('avatars/med-2026/alice/proof-1.jpg', 'med-2026', 'proof-1')).toBeNull();
    expect(confinedProofMediaPath('proofs/med-2026/../../avatars/alice.jpg', 'med-2026', 'proof-1')).toBeNull();
  });

  it('refuses a non-string, an empty owner segment, a missing extension and a deeper path', () => {
    expect(confinedProofMediaPath(undefined, 'med-2026', 'proof-1')).toBeNull();
    expect(confinedProofMediaPath(42, 'med-2026', 'proof-1')).toBeNull();
    expect(confinedProofMediaPath('proofs/med-2026//proof-1.jpg', 'med-2026', 'proof-1')).toBeNull();
    expect(confinedProofMediaPath('proofs/med-2026/alice/proof-1', 'med-2026', 'proof-1')).toBeNull();
    expect(confinedProofMediaPath('proofs/med-2026/alice/proof-1.', 'med-2026', 'proof-1')).toBeNull();
    expect(confinedProofMediaPath('proofs/med-2026/alice/sub/proof-1.jpg', 'med-2026', 'proof-1')).toBeNull();
  });
});

describe('isObjectAlreadyGone', () => {
  it('recognizes the Admin SDK 404 and the client SDK not-found code, and nothing else', () => {
    expect(isObjectAlreadyGone({ code: 404 })).toBe(true);
    expect(isObjectAlreadyGone({ code: '404' })).toBe(true);
    expect(isObjectAlreadyGone({ code: 'storage/object-not-found' })).toBe(true);
    expect(isObjectAlreadyGone({ code: 403 })).toBe(false);
    expect(isObjectAlreadyGone({ code: 'storage/unauthorized' })).toBe(false);
    expect(isObjectAlreadyGone(new Error('network'))).toBe(false);
    expect(isObjectAlreadyGone(undefined)).toBe(false);
    expect(isObjectAlreadyGone(null)).toBe(false);
  });
});

describe('isGenerationMismatch', () => {
  it('recognizes the precondition failure and nothing else — a 404 is a different answer', () => {
    // The two both end in retirement but describe different worlds: 404 means
    // the debt was discharged, 412 means it can no longer be discharged against
    // this path. Conflating them would log the wrong thing about the wrong case.
    expect(isGenerationMismatch({ code: 412 })).toBe(true);
    expect(isGenerationMismatch({ code: '412' })).toBe(true);
    expect(isGenerationMismatch({ code: 404 })).toBe(false);
    expect(isGenerationMismatch({ code: 503 })).toBe(false);
    expect(isGenerationMismatch(new Error('network'))).toBe(false);
    expect(isGenerationMismatch(undefined)).toBe(false);
    expect(isGenerationMismatch(null)).toBe(false);
  });
});
