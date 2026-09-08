import { describe, it, expect, vi } from 'vitest';
import {
  confinedProofMediaPath,
  isObjectAlreadyGone,
  revokeProofMedia,
  type RevokeProofMediaDeps,
} from '../../functions/src/proofStorageDeletes';

// specs/post-sailing-archive.md § "Moderation is not a gameplay write", the
// durability half (#134, Codex P1 on PR #1139).
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
): RevokeProofMediaDeps & {
  objectDeletes: string[];
  tombstoneDeletes: number;
  warnings: Array<{ message: string; context: Record<string, unknown> }>;
} {
  const objectDeletes: string[] = [];
  const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
  const deps = {
    objectDeletes,
    tombstoneDeletes: 0,
    warnings,
    deleteObject: async (storagePath: string) => {
      objectDeletes.push(storagePath);
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

const TARGET = {
  eventId: 'med-2026',
  proofId: 'proof-1',
  tombstone: { storagePath: 'proofs/med-2026/alice/proof-1.jpg', uid: 'alice', requestedAt: 1000 },
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

    expect(deps.objectDeletes).toEqual(['proofs/med-2026/alice/proof-1.jpg']);
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

  it('logs through console.warn when no sink is injected', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await revokeProofMedia(
        {
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
