import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc } from "firebase/firestore";

// specs/community-squares-quota.md (#558) — Easy/closing Prompts are outside
// the Event adult-content gate, so their RESULTING stored state must stay tame.
// The PERMISSION_DENIED lines emitted by assertFails are expected denials.

const RULES_PATH = fileURLToPath(
  new URL("../../firestore.rules", import.meta.url),
);
const EVENT = "cruise";
const ADMIN = "admin-uid";
const PLAYER = "player-uid";

let testEnv: RulesTestEnvironment;
const db = (uid = ADMIN) => testEnv.authenticatedContext(uid).firestore();
const itemPath = (id: string) => `events/${EVENT}/items/${id}`;

const activePayload = (pool: string, spicy: boolean) => ({
  text: "Classified Prompt",
  createdBy: ADMIN,
  createdAt: Date.now(),
  status: "active",
  pool,
  reportCount: 0,
  spicy,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  const [hostname, port] = host.split(":");
  testEnv = await initializeTestEnvironment({
    projectId: "demo-fiveacross-community-squares-quota",
    firestore: {
      host: hostname,
      port: Number(port),
      rules: readFileSync(RULES_PATH, "utf8"),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `events/${EVENT}`), {
      name: "Cruise",
      status: "active",
      admins: [ADMIN],
      settings: { reportHideThreshold: 4 },
      timezone: "Europe/Rome",
    });
  });
});

describe("Community Prompt pool/spicy resulting-state invariant (#558)", () => {
  it("allows active main content to be spicy", async () => {
    await assertSucceeds(
      setDoc(doc(db(), itemPath("main")), activePayload("main", true)),
    );
  });

  it("denies spicy Easy/closing creates in canonical and legacy spellings", async () => {
    for (const pool of ["easy", "embark", "closing", "farewell"]) {
      await assertFails(
        setDoc(doc(db(), itemPath(`spicy-${pool}`)), activePayload(pool, true)),
      );
    }
  });

  it("allows tame Easy/closing creates in canonical and legacy spellings", async () => {
    for (const pool of ["easy", "embark", "closing", "farewell"]) {
      await assertSucceeds(
        setDoc(doc(db(), itemPath(`tame-${pool}`)), activePayload(pool, false)),
      );
    }
  });

  it("allows an Admin to correct a still-pending main Prompt’s spicy flag", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), itemPath("pending-main")), {
        ...activePayload("main", false),
        status: "pending",
      });
    });

    await assertSucceeds(
      updateDoc(doc(db(), itemPath("pending-main")), { spicy: true }),
    );
  });

  it("treats an absent legacy pool as main when correcting a pending spicy flag", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const { pool: _pool, ...legacy } = {
        ...activePayload("main", false),
        status: "pending",
      };
      await setDoc(
        doc(ctx.firestore(), itemPath("pending-legacy-main")),
        legacy,
      );
    });

    await assertSucceeds(
      updateDoc(doc(db(), itemPath("pending-legacy-main")), { spicy: true }),
    );
  });

  it("allows Easy approval only when the same resulting write clears spicy", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), itemPath("approval")), {
        ...activePayload("main", true),
        status: "pending",
      });
    });

    await assertFails(
      updateDoc(doc(db(), itemPath("approval")), {
        status: "active",
        approvedBy: ADMIN,
        approvedAt: Date.now(),
        pool: "embark",
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db(), itemPath("approval")), {
        status: "active",
        approvedBy: ADMIN,
        approvedAt: Date.now(),
        pool: "embark",
        spicy: false,
      }),
    );
  });

  it("denies a late stale spicy toggle after an Easy approval", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), itemPath("approved-easy")),
        activePayload("embark", false),
      );
    });

    await assertFails(
      updateDoc(doc(db(), itemPath("approved-easy")), { spicy: true }),
    );
  });

  it("keeps the report-only arm unchanged for a legacy item with no pool", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const { pool: _pool, ...legacy } = activePayload("main", false);
      await setDoc(doc(ctx.firestore(), itemPath("legacy-no-pool")), legacy);
    });

    await assertSucceeds(
      updateDoc(doc(db(PLAYER), itemPath("legacy-no-pool")), {
        reportCount: 1,
      }),
    );
  });

  it("keeps unrelated Admin edits working on a legacy item with no pool", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const { pool: _pool, ...legacy } = activePayload("main", false);
      await setDoc(doc(ctx.firestore(), itemPath("legacy-admin-edit")), legacy);
    });

    await assertSucceeds(
      updateDoc(doc(db(), itemPath("legacy-admin-edit")), {
        text: "Corrected wording",
      }),
    );
  });
});
