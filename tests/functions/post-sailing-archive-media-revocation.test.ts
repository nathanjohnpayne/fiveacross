import { describe, it, expect, vi } from 'vitest';
import {
  confinedProofMediaPath,
  isGenerationMismatch,
  isObjectAlreadyGone,
  revokeProofMedia,
  type RevokeProofMediaDeps,
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

function makeDeps(
  deleteObject: (storagePath: string) => Promise<void>,
  // Whether a Proof document holds this id at sweep time. Default FALSE, which
  // is what a standing tombstone is supposed to mean; the cases that matter set
  // it true, or reject, on purpose.
  proofExists: () => Promise<boolean> = async () => false,
): RevokeProofMediaDeps & {
  objectDeletes: Array<{ storagePath: string; generation: string | null }>;
  tombstoneDeletes: number;
  warnings: Array<{ message: string; context: Record<string, unknown> }>;
} {
  const objectDeletes: Array<{ storagePath: string; generation: string | null }> = [];
  const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
  const deps = {
    objectDeletes,
    tombstoneDeletes: 0,
    warnings,
    proofExists,
    deleteObject: async (storagePath: string, generation: string | null) => {
      objectDeletes.push({ storagePath, generation });
      await deleteObject(storagePath);
    },
    deleteTombstone: async () => {
      deps.tombstoneDeletes += 1;
    },
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
      deleteTombstone: async () => {
        order.push('tombstone');
        await deps.deleteTombstone();
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
    const deps = makeDeps(async () => {});

    await revokeProofMedia(deps, {
      ...TARGET,
      tombstone: { ...TARGET.tombstone, storagePath: 'proofs/other-event/alice/proof-1.jpg' },
    });

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(1);
    expect(deps.warnings).toHaveLength(1);
  });

  it('drops a row carrying no usable storagePath at all', async () => {
    const deps = makeDeps(async () => {});

    await revokeProofMedia(deps, { ...TARGET, tombstone: { uid: 'alice' } });

    expect(deps.objectDeletes).toEqual([]);
    expect(deps.tombstoneDeletes).toBe(1);
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

  it('binds the delete to the generation the row recorded, and to nothing when it recorded none', async () => {
    const bound = makeDeps(async () => {});
    await revokeProofMedia(bound, BOUND);
    expect(bound.objectDeletes).toEqual([
      { storagePath: 'proofs/med-2026/alice/proof-1.jpg', generation: '1700000000000001' },
    ]);

    // A row written before this existed, or by a client whose metadata read
    // failed, still revokes by path — the pre-generation behaviour, unchanged.
    const unbound = makeDeps(async () => {});
    await revokeProofMedia(unbound, TARGET);
    expect(unbound.objectDeletes).toEqual([
      { storagePath: 'proofs/med-2026/alice/proof-1.jpg', generation: null },
    ]);

    // A non-string generation is no generation: the row is client-written and
    // this handler holds a bucket-wide delete, so a value it cannot use is
    // ignored rather than passed through to the precondition.
    const junk = makeDeps(async () => {});
    await revokeProofMedia(junk, {
      ...TARGET,
      tombstone: { ...TARGET.tombstone, generation: 17 },
    });
    expect(junk.objectDeletes[0].generation).toBeNull();
  });

  it('LEAVES a re-uploaded object alone when the generation no longer matches', async () => {
    // 412 is Cloud Storage answering "that is not the object you asked about".
    // The only way to reach it is that the name was re-occupied after the row
    // was written, so the bytes there now belong to a write this revocation says
    // nothing about. Retiring rather than retrying, because redelivery cannot
    // turn the old generation back up.
    const deps = makeDeps(async () => {
      throw Object.assign(new Error('Precondition Failed'), { code: 412 });
    });

    await expect(revokeProofMedia(deps, BOUND)).resolves.toBeUndefined();

    expect(deps.tombstoneDeletes).toBe(1);
    expect(deps.warnings).toHaveLength(1);
  });

  it('logs through console.warn when no sink is injected', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await revokeProofMedia(
        {
          proofExists: async () => false,
          deleteObject: async () => {
            throw new Error('the bucket must not be reached');
          },
          deleteTombstone: async () => {},
        },
        { ...TARGET, tombstone: { storagePath: 'nonsense' } },
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
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
