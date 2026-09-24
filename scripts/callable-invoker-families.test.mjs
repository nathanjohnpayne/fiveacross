// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALLABLE_INVOKER_FAMILIES,
  httpsFunctionExports,
  unfamiliedHttpsExports,
} from "./callable-invoker-families.mjs";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realIndex = resolve(repoRoot, "functions", "src", "index.ts");
const fixtures = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "callable-families-"));
  fixtures.push(root);
  await mkdir(resolve(root, "functions", "src"), { recursive: true });
  await writeFile(resolve(root, "firebase.json"), JSON.stringify({ functions: { source: "functions" } }));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(resolve(root, "functions", "src", name), text);
  }
  return root;
}

describe("callable invoker families (#1277)", () => {
  it("leaves no HTTPS export of the real Functions index unfamilied", () => {
    expect(unfamiliedHttpsExports(realIndex)).toEqual([]);
    expect([...httpsFunctionExports(realIndex)]).toContain("unlockDayNow");
  });

  it("registers a wrapper that exists for every family", () => {
    for (const family of CALLABLE_INVOKER_FAMILIES) {
      expect(existsSync(resolve(repoRoot, family.wrapper)), family.wrapper).toBe(true);
    }
  });

  it("finds direct, aliased, local-renamed and re-exported HTTPS functions but not other triggers", async () => {
    const root = await fixture({
      "index.ts": [
        "import { onCall as call, onRequest } from 'firebase-functions/v2/https';",
        "import * as https from 'firebase-functions/v2/https';",
        "import { onSchedule } from 'firebase-functions/v2/scheduler';",
        "export const direct = call({}, async () => 1);",
        "export const viaNamespace = https.onRequest((req, res) => res.end());",
        "const hidden = onRequest((req, res) => res.end());",
        "export { hidden as renamed };",
        "export const scheduled = onSchedule('every day 00:00', async () => {});",
        "export const factory = () => call({}, async () => 1);",
        "export { remote } from './remote.js';",
        "export * from './star';",
      ].join("\n"),
      "remote.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport const remote = onCall(async () => 1);\n",
      "star.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport const starred = onCall(async () => 1);\n",
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "direct",
      "remote",
      "renamed",
      "starred",
      "viaNamespace",
    ]);
  });

  it("fails the deploy classification, naming the export, for an unfamilied callable", async () => {
    const root = await fixture({
      "index.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => 1);",
        "export const brandNewCallable = onCall(async () => 1);",
      ].join("\n"),
    });

    await expect(
      classifyFirebaseDeployRequest(["fiveacross", "--only", "functions"], {
        defaultConfigPath: resolve(root, "firebase.json"),
      }),
    ).rejects.toThrow(/brandNewCallable.*belongs to no Cloud Run invoker family/);
  });

  it("does not block a deploy that cannot release Functions", async () => {
    const root = await fixture({
      "index.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport const brandNewCallable = onCall(async () => 1);\n",
    });
    await writeFile(
      resolve(root, "firebase.json"),
      JSON.stringify({ hosting: { public: "dist" }, functions: { source: "functions" } }),
    );

    const result = await classifyFirebaseDeployRequest(["fiveacross", "--only", "hosting"], {
      defaultConfigPath: resolve(root, "firebase.json"),
    });
    expect(result.functionsAttempted).toBe(false);
  });
});
