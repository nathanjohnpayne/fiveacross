// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  assertReviewedDeployCredential,
  assertReviewedMainCheckout,
  classifyMarkerDocument,
  COMPATIBILITY_PATH,
  executeMarkerEventIdMigration,
  parseAcceptLegacyUntil,
  parseCliArgs,
  parseMarkerPath,
  planCompatibilityWrite,
  planMarkerEventIdMigration,
  resolveMarkerMigrationTarget,
} from "./migrate-marker-event-id.mjs";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const CUTOFF = Date.parse("2026-09-10T00:00:00.000Z");
const CUTOFF_ISO = new Date(CUTOFF).toISOString();

const compatibility = (
  projectId = "fiveacross",
  acceptLegacyUntil = CUTOFF,
) => ({
  schemaVersion: 1,
  projectId,
  acceptLegacyUntil,
});

const marker = (path, data) => ({ path, data });
const missingMarker = () =>
  marker("events/a/tally/prompt/markers/user", { uid: "user" });
const exactMarker = () =>
  marker("events/a/tally/prompt/markers/user", { uid: "user", eventId: "a" });
const otherExactMarker = () =>
  marker("events/a/tally/other-prompt/markers/other-user", {
    uid: "other-user",
    eventId: "a",
  });

function snapshot(ref, data) {
  return {
    ref,
    exists: data !== null,
    data: () => data ?? undefined,
  };
}

function firestoreFixture({
  projectId = "fiveacross",
  config = compatibility(projectId),
  markers = [],
} = {}) {
  const configRef = { path: COMPATIBILITY_PATH };
  const markerRefs = new Map(
    markers.map((row) => [row.path, { path: row.path }]),
  );
  const state = {
    config: config == null ? null : structuredClone(config),
    markers: new Map(
      markers.map((row) => [row.path, structuredClone(row.data)]),
    ),
  };
  const docSnapshot = (ref) =>
    ref.path === COMPATIBILITY_PATH
      ? snapshot(ref, state.config)
      : snapshot(
          ref,
          state.markers.has(ref.path) ? state.markers.get(ref.path) : null,
        );
  const groupSnapshot = () => ({
    docs: [...state.markers].map(([path, data]) =>
      snapshot(markerRefs.get(path) ?? { path }, data),
    ),
  });
  configRef.get = vi.fn(async () => docSnapshot(configRef));
  const groupGet = vi.fn(async () => groupSnapshot());
  const db = {
    doc: vi.fn((path) => {
      if (path !== COMPATIBILITY_PATH)
        throw new Error(`unexpected doc ${path}`);
      return configRef;
    }),
    collectionGroup: vi.fn((name) => {
      if (name !== "markers") throw new Error(`unexpected group ${name}`);
      return { get: groupGet };
    }),
    runTransaction: vi.fn(async (callback) => {
      const writes = [];
      const transaction = {
        get: vi.fn(async (ref) => docSnapshot(ref)),
        set: vi.fn((ref, data) =>
          writes.push(["set", ref, structuredClone(data)]),
        ),
        update: vi.fn((ref, data) =>
          writes.push(["update", ref, structuredClone(data)]),
        ),
      };
      const result = await callback(transaction);
      for (const [kind, ref, data] of writes) {
        if (ref.path === COMPATIBILITY_PATH) state.config = data;
        else if (kind === "update")
          state.markers.set(ref.path, {
            ...state.markers.get(ref.path),
            ...data,
          });
      }
      return result;
    }),
  };
  const initializeFirestore = vi.fn(async () => ({ db, projectId }));
  return { db, state, configRef, markerRefs, groupGet, initializeFirestore };
}

const applyGuards = () => ({
  verifyReviewedSource: vi.fn(),
  verifyReviewedCredential: vi.fn(),
});

describe("marker Event-id migration pure contract", () => {
  it.each([
    ["gaycruisebingo", "gaycruisebingo"],
    ["fiveacross", "fiveacross"],
  ])("pins target %s to project %s", (target, projectId) => {
    expect(resolveMarkerMigrationTarget(target)).toMatchObject({
      target,
      projectId,
    });
  });

  it("never infers or accepts an unregistered target", () => {
    expect(() => resolveMarkerMigrationTarget()).toThrow(
      /explicit positional target/,
    );
    expect(() => resolveMarkerMigrationTarget("production")).toThrow(
      /Unknown deploy target/,
    );
    expect(() => resolveMarkerMigrationTarget("constructor")).toThrow(
      /Unknown deploy target/,
    );
  });

  it("requires a future ISO compatibility cutoff", () => {
    const now = NOW;
    expect(parseAcceptLegacyUntil("2026-09-02T12:00:00.000Z", now)).toBe(
      Date.parse("2026-09-02T12:00:00.000Z"),
    );
    expect(() => parseAcceptLegacyUntil(undefined, now)).toThrow(
      /--accept-legacy-until/,
    );
    expect(() => parseAcceptLegacyUntil("tomorrow", now)).toThrow(
      /ISO timestamp/,
    );
    expect(() =>
      parseAcceptLegacyUntil("2026-09-01T12:00:00.000Z", now),
    ).toThrow(/future/);
    expect(() =>
      parseAcceptLegacyUntil("2100-01-01T00:00:00.000Z", now),
    ).toThrow(/before 2100/);
  });

  it("accepts only the exact Event/Tally marker path", () => {
    expect(parseMarkerPath("events/a/tally/prompt/markers/user")).toEqual({
      eventId: "a",
      itemId: "prompt",
      markerUid: "user",
    });
    for (const path of [
      "events/a/tally/prompt/markers",
      "events/a/other/prompt/markers/user",
      "root/events/a/tally/prompt/markers/user",
      "events//tally/prompt/markers/user",
      "events/a/tally/prompt/markers/user/extra",
    ]) {
      expect(parseMarkerPath(path)).toBeNull();
    }
  });

  it.each([
    [{ uid: "user", eventId: "a" }, "exact"],
    [{ uid: "user" }, "missing"],
    [{ uid: "user", eventId: "b" }, "event-id-mismatch"],
    [{ uid: "user", eventId: 7 }, "event-id-nonstring"],
    [{ uid: "other", eventId: "a" }, "malformed-uid"],
  ])("classifies marker payload %# as %s", (data, classification) => {
    expect(
      classifyMarkerDocument({
        path: "events/a/tally/prompt/markers/user",
        data,
      }),
    ).toMatchObject({ classification });
  });

  it("classifies malformed collection-group paths before trusting payload data", () => {
    expect(
      classifyMarkerDocument({
        path: "events/a/not-tally/prompt/markers/user",
        data: { uid: "user" },
      }),
    ).toMatchObject({ classification: "malformed-path" });
  });

  it("blocks the whole marker plan when even one row is anomalous", () => {
    const plan = planMarkerEventIdMigration([
      missingMarker(),
      exactMarker(),
      marker("events/b/tally/prompt/markers/user", {
        uid: "user",
        eventId: "a",
      }),
    ]);
    expect(plan).toMatchObject({ total: 3, blocked: true });
    expect(plan.missing).toHaveLength(1);
    expect(plan.exact).toHaveLength(1);
    expect(plan.anomalies.map((row) => row.classification)).toEqual([
      "event-id-mismatch",
    ]);
  });

  it("plans config creation, idempotence, and explicit extension", () => {
    const base = {
      projectId: "fiveacross",
      acceptLegacyUntil: Date.parse("2026-09-10T00:00:00.000Z"),
    };
    expect(planCompatibilityWrite(null, base)).toMatchObject({
      action: "create",
    });
    expect(
      planCompatibilityWrite(
        {
          schemaVersion: 1,
          projectId: base.projectId,
          acceptLegacyUntil: base.acceptLegacyUntil,
        },
        base,
      ),
    ).toMatchObject({ action: "none" });
    expect(
      planCompatibilityWrite(
        {
          schemaVersion: 1,
          projectId: base.projectId,
          acceptLegacyUntil: base.acceptLegacyUntil - 1,
        },
        base,
      ),
    ).toMatchObject({ action: "extend" });
  });

  it("refuses config shortening, wrong-project state, and malformed state", () => {
    const desired = { projectId: "fiveacross", acceptLegacyUntil: 200 };
    expect(() =>
      planCompatibilityWrite(
        { schemaVersion: 1, projectId: "fiveacross", acceptLegacyUntil: 201 },
        desired,
      ),
    ).toThrow(/shorten/);
    expect(() =>
      planCompatibilityWrite(
        {
          schemaVersion: 1,
          projectId: "gaycruisebingo",
          acceptLegacyUntil: 100,
        },
        desired,
      ),
    ).toThrow(/wrong project/);
    expect(() =>
      planCompatibilityWrite(
        {
          schemaVersion: 1,
          projectId: "fiveacross",
          acceptLegacyUntil: "later",
        },
        desired,
      ),
    ).toThrow(/malformed/);
    expect(() =>
      planCompatibilityWrite(null, {
        projectId: "",
        acceptLegacyUntil: Number.NaN,
      }),
    ).toThrow(/requested compatibility config is malformed/);
    for (const acceptLegacyUntil of [0, -1, 4_102_444_800_000]) {
      expect(() =>
        planCompatibilityWrite(null, {
          projectId: "fiveacross",
          acceptLegacyUntil,
        }),
      ).toThrow(/requested compatibility config is malformed/);
    }
  });

  it("requires the exact positional CLI and explicit cutoff flag", () => {
    expect(
      parseCliArgs(["fiveacross", "--accept-legacy-until", CUTOFF_ISO], NOW),
    ).toEqual({
      target: "fiveacross",
      acceptLegacyUntil: CUTOFF,
      apply: false,
    });
    expect(
      parseCliArgs(
        ["gaycruisebingo", "--accept-legacy-until", CUTOFF_ISO, "--apply"],
        NOW,
      ),
    ).toMatchObject({ target: "gaycruisebingo", apply: true });
    expect(() =>
      parseCliArgs(["--apply", "--accept-legacy-until", CUTOFF_ISO], NOW),
    ).toThrow(/explicit positional target/);
    expect(() => parseCliArgs(["fiveacross"], NOW)).toThrow(
      /--accept-legacy-until/,
    );
  });
});

describe("marker Event-id migration guards", () => {
  it("accepts only the exact selected-project deploy credential for both targets", () => {
    for (const target of ["gaycruisebingo", "fiveacross"]) {
      const projectId = target;
      const path = `/tmp/${projectId}-firebase-deployer.json`;
      const environment = {
        GOOGLE_APPLICATION_CREDENTIALS: path,
        OP_PREFLIGHT_FIREBASE_SA_TMPFILE: path,
        OP_PREFLIGHT_FIREBASE_PROJECT: projectId,
      };
      expect(
        assertReviewedDeployCredential({
          target,
          environment,
          readCredential: () =>
            JSON.stringify({
              type: "service_account",
              project_id: projectId,
              client_email: `firebase-deployer@${projectId}.iam.gserviceaccount.com`,
            }),
        }),
      ).toBe(path);
    }
  });

  it("refuses a credential for the other registered project", () => {
    expect(() =>
      assertReviewedDeployCredential({
        target: "fiveacross",
        environment: {
          GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json",
          OP_PREFLIGHT_FIREBASE_SA_TMPFILE: "/tmp/key.json",
          OP_PREFLIGHT_FIREBASE_PROJECT: "gaycruisebingo",
        },
        readCredential: () =>
          JSON.stringify({
            type: "service_account",
            project_id: "gaycruisebingo",
            client_email:
              "firebase-deployer@gaycruisebingo.iam.gserviceaccount.com",
          }),
      }),
    ).toThrow(/exact fiveacross deploy preflight credential/);
  });

  it("uses the exact-main deploy guard and reports its refusal", () => {
    const runGuard = vi.fn(() => ({ status: 1, stderr: "wrong branch\n" }));
    expect(() =>
      assertReviewedMainCheckout({ runGuard, target: "fiveacross" }),
    ).toThrow(/clean main checkout at exact origin\/main/);
    expect(runGuard).toHaveBeenCalledOnce();
  });
});

describe("marker Event-id migration execution", () => {
  it("keeps dry-run fully read-only while reporting the complete safe plan", async () => {
    const fixture = firestoreFixture({
      config: null,
      markers: [missingMarker(), otherExactMarker()],
    });
    const result = await executeMarkerEventIdMigration({
      target: "fiveacross",
      acceptLegacyUntil: CUTOFF,
      now: NOW,
      initializeFirestore: fixture.initializeFirestore,
      environment: {},
      log: vi.fn(),
    });
    expect(result).toMatchObject({
      wroteCompatibility: false,
      wroteMarkers: 0,
    });
    expect(result.compatibilityPlan.action).toBe("create");
    expect(result.markerPlan.missing).toHaveLength(1);
    expect(fixture.db.runTransaction).not.toHaveBeenCalled();
    expect(fixture.initializeFirestore).toHaveBeenCalledWith({
      allowLocalServiceAccountKey: true,
    });
  });

  it("blocks every write when the initial scan contains one anomaly", async () => {
    const fixture = firestoreFixture({
      config: null,
      markers: [
        missingMarker(),
        marker("events/b/tally/prompt/markers/user", {
          uid: "user",
          eventId: "a",
        }),
      ],
    });
    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now: NOW,
        initializeFirestore: fixture.initializeFirestore,
        environment: {},
        log: vi.fn(),
        ...applyGuards(),
      }),
    ).rejects.toThrow(/initial scan found 1 anomalous marker/);
    expect(fixture.db.runTransaction).not.toHaveBeenCalled();
  });

  it("opens compatibility first, backfills missing markers, and verifies exact readback", async () => {
    const fixture = firestoreFixture({
      config: null,
      markers: [missingMarker(), otherExactMarker()],
    });
    const result = await executeMarkerEventIdMigration({
      target: "fiveacross",
      acceptLegacyUntil: CUTOFF,
      apply: true,
      now: NOW,
      initializeFirestore: fixture.initializeFirestore,
      environment: {},
      log: vi.fn(),
      ...applyGuards(),
    });
    expect(result).toMatchObject({ wroteCompatibility: true, wroteMarkers: 1 });
    expect(fixture.state.config).toEqual(compatibility());
    expect(fixture.state.markers.get(missingMarker().path)).toMatchObject({
      eventId: "a",
    });
    expect(fixture.db.runTransaction).toHaveBeenCalledTimes(2);
    expect(fixture.initializeFirestore).toHaveBeenCalledWith({
      allowLocalServiceAccountKey: false,
    });
  });

  it("refuses to open compatibility when the reviewed cutoff expires during the initial scan", async () => {
    const fixture = firestoreFixture({
      config: null,
      markers: [missingMarker()],
    });

    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now: vi.fn().mockReturnValueOnce(NOW).mockReturnValueOnce(CUTOFF),
        initializeFirestore: fixture.initializeFirestore,
        environment: {},
        log: vi.fn(),
        ...applyGuards(),
      }),
    ).rejects.toThrow(/cutoff expired before compatibility could be opened/);
    expect(fixture.state.config).toBeNull();
    expect(fixture.state.markers.get(missingMarker().path)).not.toHaveProperty(
      "eventId",
    );
  });

  it("rechecks the cutoff on every compatibility transaction retry", async () => {
    const fixture = firestoreFixture({ config: null, markers: [] });
    fixture.db.runTransaction.mockImplementationOnce(async (callback) => {
      const firstAttempt = {
        get: vi.fn(async () => snapshot(fixture.configRef, null)),
        set: vi.fn(),
        update: vi.fn(),
      };
      await callback(firstAttempt);
      expect(firstAttempt.set).toHaveBeenCalledOnce();
      return callback({
        get: vi.fn(async () => snapshot(fixture.configRef, null)),
        set: vi.fn(),
        update: vi.fn(),
      });
    });
    const now = vi
      .fn()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(CUTOFF - 1)
      .mockReturnValueOnce(CUTOFF);

    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now,
        initializeFirestore: fixture.initializeFirestore,
        environment: {},
        log: vi.fn(),
        ...applyGuards(),
      }),
    ).rejects.toThrow(/cutoff expired before compatibility could be opened/);
    expect(now).toHaveBeenCalledTimes(3);
    expect(fixture.state.config).toBeNull();
  });

  it("is an idempotent apply when config and every marker are already exact", async () => {
    const fixture = firestoreFixture({ markers: [exactMarker()] });
    const result = await executeMarkerEventIdMigration({
      target: "fiveacross",
      acceptLegacyUntil: CUTOFF,
      apply: true,
      now: NOW,
      initializeFirestore: fixture.initializeFirestore,
      environment: {},
      log: vi.fn(),
      ...applyGuards(),
    });
    expect(result).toMatchObject({
      wroteCompatibility: false,
      wroteMarkers: 0,
    });
    expect(fixture.db.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("resets retry accounting when another writer converges config and marker first", async () => {
    const configRef = { path: COMPATIBILITY_PATH };
    const markerRef = { path: missingMarker().path };
    let groupReads = 0;
    const db = {
      doc: vi.fn(() => ({
        ...configRef,
        get: async () =>
          snapshot(configRef, groupReads === 0 ? null : compatibility()),
      })),
      collectionGroup: vi.fn(() => ({
        get: async () => {
          groupReads += 1;
          return {
            docs: [
              snapshot(
                markerRef,
                groupReads === 1 ? missingMarker().data : exactMarker().data,
              ),
            ],
          };
        },
      })),
      runTransaction: vi
        .fn()
        .mockImplementationOnce(async (callback) => {
          const first = {
            get: async () => snapshot(configRef, null),
            set: vi.fn(),
            update: vi.fn(),
          };
          await callback(first);
          const retry = {
            get: async () => snapshot(configRef, compatibility()),
            set: vi.fn(),
            update: vi.fn(),
          };
          return callback(retry);
        })
        .mockImplementationOnce(async (callback) => {
          const first = {
            get: async () => snapshot(markerRef, missingMarker().data),
            set: vi.fn(),
            update: vi.fn(),
          };
          await callback(first);
          const retry = {
            get: async () => snapshot(markerRef, exactMarker().data),
            set: vi.fn(),
            update: vi.fn(),
          };
          return callback(retry);
        }),
    };
    const result = await executeMarkerEventIdMigration({
      target: "fiveacross",
      acceptLegacyUntil: CUTOFF,
      apply: true,
      now: NOW,
      initializeFirestore: async () => ({ db, projectId: "fiveacross" }),
      environment: {},
      log: vi.fn(),
      ...applyGuards(),
    });
    expect(result).toMatchObject({
      wroteCompatibility: false,
      wroteMarkers: 0,
    });
  });

  it("refuses a fresh transaction read that drifted to a mismatched Event", async () => {
    const fixture = firestoreFixture({ markers: [missingMarker()] });
    fixture.db.runTransaction
      .mockImplementationOnce(async (callback) =>
        callback({
          get: async () => snapshot(fixture.configRef, compatibility()),
          set: vi.fn(),
          update: vi.fn(),
        }),
      )
      .mockImplementationOnce(async (callback) =>
        callback({
          get: async (ref) =>
            snapshot(ref, { uid: "user", eventId: "wrong-event" }),
          set: vi.fn(),
          update: vi.fn(),
        }),
      );
    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now: NOW,
        initializeFirestore: fixture.initializeFirestore,
        environment: {},
        log: vi.fn(),
        ...applyGuards(),
      }),
    ).rejects.toThrow(/marker drifted after planning.*event-id-mismatch/);
  });

  it.each([
    ["deletion", null, /marker deleted after planning/],
    [
      "path drift",
      {
        refPath: "events/other/tally/prompt/markers/user",
        data: missingMarker().data,
      },
      /marker path drifted after planning/,
    ],
  ])("refuses fresh transaction %s", async (_case, freshState, message) => {
    const fixture = firestoreFixture({ markers: [missingMarker()] });
    fixture.db.runTransaction
      .mockImplementationOnce(async (callback) =>
        callback({
          get: async () => snapshot(fixture.configRef, compatibility()),
          set: vi.fn(),
          update: vi.fn(),
        }),
      )
      .mockImplementationOnce(async (callback) => {
        const ref = {
          path:
            freshState && "refPath" in freshState
              ? freshState.refPath
              : fixture.markerRefs.get(missingMarker().path).path,
        };
        return callback({
          get: async () =>
            snapshot(ref, freshState == null ? null : freshState.data),
          set: vi.fn(),
          update: vi.fn(),
        });
      });
    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now: NOW,
        initializeFirestore: fixture.initializeFirestore,
        environment: {},
        log: vi.fn(),
        ...applyGuards(),
      }),
    ).rejects.toThrow(message);
  });

  it("fails if final marker readback does not converge", async () => {
    const fixture = firestoreFixture({ markers: [missingMarker()] });
    fixture.db.runTransaction.mockImplementation(async (callback) =>
      callback({
        get: async (ref) =>
          ref.path === COMPATIBILITY_PATH
            ? snapshot(ref, compatibility())
            : snapshot(ref, missingMarker().data),
        set: vi.fn(),
        update: vi.fn(),
      }),
    );
    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now: NOW,
        initializeFirestore: fixture.initializeFirestore,
        environment: {},
        log: vi.fn(),
        ...applyGuards(),
      }),
    ).rejects.toThrow(/readback did not converge/);
  });

  it("fails if final compatibility readback is not exact", async () => {
    const fixture = firestoreFixture({ config: null, markers: [] });
    fixture.db.runTransaction.mockImplementation(async (callback) =>
      callback({
        get: async (ref) => snapshot(ref, null),
        set: vi.fn(),
        update: vi.fn(),
      }),
    );
    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now: NOW,
        initializeFirestore: fixture.initializeFirestore,
        environment: {},
        log: vi.fn(),
        ...applyGuards(),
      }),
    ).rejects.toThrow(/readback is not the exact requested config/);
  });

  it("runs source and credential guards before Firestore initialization", async () => {
    const initializeFirestore = vi.fn();
    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now: NOW,
        initializeFirestore,
        verifyReviewedSource: () => {
          throw new Error("source refused");
        },
        verifyReviewedCredential: vi.fn(),
        environment: {},
      }),
    ).rejects.toThrow("source refused");
    expect(initializeFirestore).not.toHaveBeenCalled();

    await expect(
      executeMarkerEventIdMigration({
        target: "gaycruisebingo",
        acceptLegacyUntil: CUTOFF,
        apply: true,
        now: NOW,
        initializeFirestore,
        verifyReviewedSource: vi.fn(),
        verifyReviewedCredential: () => {
          throw new Error("credential refused");
        },
        environment: {},
      }),
    ).rejects.toThrow("credential refused");
    expect(initializeFirestore).not.toHaveBeenCalled();
  });

  it("refuses a Firestore initializer that resolved the other project", async () => {
    const fixture = firestoreFixture({ projectId: "gaycruisebingo" });
    await expect(
      executeMarkerEventIdMigration({
        target: "fiveacross",
        acceptLegacyUntil: CUTOFF,
        now: NOW,
        initializeFirestore: fixture.initializeFirestore,
        environment: {},
      }),
    ).rejects.toThrow(/refusing Firestore project gaycruisebingo/);
    expect(fixture.db.doc).not.toHaveBeenCalled();
  });
});
