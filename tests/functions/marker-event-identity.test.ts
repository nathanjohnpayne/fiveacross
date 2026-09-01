import { describe, expect, it } from "vitest";
import {
  MARKER_DELIVERY_COMPATIBILITY_PATH,
  repairLegacyMarkerEventIdentity,
  type MarkerIdentityFirestore,
} from "../../functions/src/markerEventIdentity";

type StoredDoc = {
  data: Record<string, unknown>;
  updateTimeMs: number;
};

function memoryFirestore(initial: Record<string, StoredDoc>) {
  const docs = new Map(Object.entries(initial));
  const reads: string[] = [];
  const updates: Array<{ path: string; data: Record<string, unknown> }> = [];

  const db: MarkerIdentityFirestore = {
    doc: (path) => ({ path }),
    runTransaction: async (work) =>
      work({
        get: async (ref) => {
          reads.push(ref.path);
          const stored = docs.get(ref.path);
          return {
            exists: stored !== undefined,
            data: () => stored?.data,
            updateTime: stored
              ? { toMillis: () => stored.updateTimeMs }
              : undefined,
          };
        },
        update: (ref, data) => {
          const stored = docs.get(ref.path);
          if (!stored) throw new Error(`missing ${ref.path}`);
          updates.push({ path: ref.path, data });
          docs.set(ref.path, {
            data: { ...stored.data, ...data },
            updateTimeMs: stored.updateTimeMs + 1,
          });
        },
      }),
  };

  return { db, docs, reads, updates };
}

const markerPath = "events/event-a/tally/item-1/markers/alice";
const params = {
  projectId: "fiveacross",
  eventId: "event-a",
  itemId: "item-1",
  markerUid: "alice",
};
const compatibility = (acceptLegacyUntil: unknown) => ({
  [MARKER_DELIVERY_COMPATIBILITY_PATH]: {
    data: { schemaVersion: 1, projectId: "fiveacross", acceptLegacyUntil },
    updateTimeMs: 50,
  },
});

describe("legacy marker Event identity compatibility", () => {
  it("transactionally stamps a missing eventId written inside the compatibility window", async () => {
    const memory = memoryFirestore({
      [markerPath]: { data: { uid: "alice" }, updateTimeMs: 999 },
      ...compatibility(1_000),
    });

    await expect(
      repairLegacyMarkerEventIdentity(memory.db, params),
    ).resolves.toBe("repaired");
    expect(memory.updates).toEqual([
      { path: markerPath, data: { eventId: "event-a" } },
    ]);
    expect(memory.docs.get(markerPath)?.data).toEqual({
      uid: "alice",
      eventId: "event-a",
    });
  });

  it("repairs an accepted write whose commit timestamp lands within the one-minute cutoff grace", async () => {
    const memory = memoryFirestore({
      [markerPath]: { data: { uid: "alice" }, updateTimeMs: 61_000 },
      ...compatibility(1_000),
    });

    await expect(
      repairLegacyMarkerEventIdentity(memory.db, params),
    ).resolves.toBe("repaired");
    expect(memory.updates).toEqual([
      { path: markerPath, data: { eventId: "event-a" } },
    ]);
  });

  it("is idempotent and does not spend a compatibility read on an already-scoped marker", async () => {
    const memory = memoryFirestore({
      [markerPath]: { data: { uid: "alice" }, updateTimeMs: 999 },
      ...compatibility(1_000),
    });

    await repairLegacyMarkerEventIdentity(memory.db, params);
    memory.reads.length = 0;
    await expect(
      repairLegacyMarkerEventIdentity(memory.db, params),
    ).resolves.toBe("already-scoped");
    expect(memory.updates).toHaveLength(1);
    expect(memory.reads).toEqual([markerPath]);
  });

  it("never repairs a present Event identity that disagrees with the path", async () => {
    const memory = memoryFirestore({
      [markerPath]: {
        data: { uid: "alice", eventId: "event-b" },
        updateTimeMs: 999,
      },
      ...compatibility(1_000),
    });

    await expect(
      repairLegacyMarkerEventIdentity(memory.db, params),
    ).resolves.toBe("mismatched-event-id");
    expect(memory.updates).toEqual([]);
    expect(memory.reads).toEqual([markerPath]);
  });

  it("treats a present non-string eventId as invalid rather than as a legacy omission", async () => {
    const memory = memoryFirestore({
      [markerPath]: {
        data: { uid: "alice", eventId: null },
        updateTimeMs: 999,
      },
      ...compatibility(1_000),
    });

    await expect(
      repairLegacyMarkerEventIdentity(memory.db, params),
    ).resolves.toBe("invalid-event-id");
    expect(memory.updates).toEqual([]);
    expect(memory.reads).toEqual([markerPath]);
  });

  it("never stamps a marker whose payload uid disagrees with its document id", async () => {
    const memory = memoryFirestore({
      [markerPath]: { data: { uid: "mallory" }, updateTimeMs: 999 },
      ...compatibility(1_000),
    });

    await expect(
      repairLegacyMarkerEventIdentity(memory.db, params),
    ).resolves.toBe("invalid-marker-uid");
    expect(memory.updates).toEqual([]);
    expect(memory.reads).toEqual([markerPath]);
  });

  it("does nothing when the marker was deleted before the trigger transaction ran", async () => {
    const memory = memoryFirestore(compatibility(1_000));

    await expect(
      repairLegacyMarkerEventIdentity(memory.db, params),
    ).resolves.toBe("deleted");
    expect(memory.reads).toEqual([markerPath]);
    expect(memory.updates).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "tomorrow"],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["at the year-2100 upper bound", 4_102_444_800_000],
  ])(
    "fails closed when the compatibility cutoff is %s",
    async (_label, cutoff) => {
      const compatibilityDoc =
        cutoff === undefined ? {} : compatibility(cutoff);
      const memory = memoryFirestore({
        [markerPath]: { data: { uid: "alice" }, updateTimeMs: 999 },
        ...compatibilityDoc,
      });

      await expect(
        repairLegacyMarkerEventIdentity(memory.db, params),
      ).resolves.toBe("compatibility-closed");
      expect(memory.updates).toEqual([]);
    },
  );

  it("refuses a missing eventId whose current committed version is beyond the one-minute cutoff grace", async () => {
    const memory = memoryFirestore({
      [markerPath]: { data: { uid: "alice" }, updateTimeMs: 61_001 },
      ...compatibility(1_000),
    });

    await expect(
      repairLegacyMarkerEventIdentity(memory.db, params),
    ).resolves.toBe("compatibility-closed");
    expect(memory.updates).toEqual([]);
  });

  it("fails closed when Firestore cannot supply the current marker version", async () => {
    const reads: string[] = [];
    const db: MarkerIdentityFirestore = {
      doc: (path) => ({ path }),
      runTransaction: async (work) =>
        work({
          get: async (ref) => {
            reads.push(ref.path);
            if (ref.path === markerPath) {
              return { exists: true, data: () => ({ uid: "alice" }) };
            }
            return {
              exists: true,
              data: () => ({
                schemaVersion: 1,
                projectId: "fiveacross",
                acceptLegacyUntil: 1_000,
              }),
              updateTime: { toMillis: () => 50 },
            };
          },
          update: () => {
            throw new Error("must not write");
          },
        }),
    };

    await expect(repairLegacyMarkerEventIdentity(db, params)).resolves.toBe(
      "compatibility-closed",
    );
    expect(reads).toEqual([markerPath, MARKER_DELIVERY_COMPATIBILITY_PATH]);
  });

  it.each([
    [
      "wrong project",
      {
        projectId: "gaycruisebingo",
        schemaVersion: 1,
        acceptLegacyUntil: 1_000,
      },
    ],
    [
      "wrong schema",
      { projectId: "fiveacross", schemaVersion: 2, acceptLegacyUntil: 1_000 },
    ],
  ])(
    "fails closed on a %s compatibility control document",
    async (_label, control) => {
      const memory = memoryFirestore({
        [markerPath]: { data: { uid: "alice" }, updateTimeMs: 999 },
        [MARKER_DELIVERY_COMPATIBILITY_PATH]: {
          data: control,
          updateTimeMs: 50,
        },
      });

      await expect(
        repairLegacyMarkerEventIdentity(memory.db, params),
      ).resolves.toBe("compatibility-closed");
      expect(memory.updates).toEqual([]);
    },
  );

  it("lets transient transaction failures escape so the retry-enabled trigger can retry", async () => {
    const transient = Object.assign(new Error("firestore unavailable"), {
      code: 14,
    });
    const db: MarkerIdentityFirestore = {
      doc: (path) => ({ path }),
      runTransaction: async () => Promise.reject(transient),
    };

    await expect(repairLegacyMarkerEventIdentity(db, params)).rejects.toBe(
      transient,
    );
  });
});
