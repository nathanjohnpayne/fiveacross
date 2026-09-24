// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function classify(args) {
  return classifyFirebaseDeployRequest(["fiveacross", ...args], {
    defaultConfigPath: resolve(repoRoot, "firebase.json"),
  });
}

async function withIndex(lines, run) {
  const fixture = await mkdtemp(join(tmpdir(), "admin-callable-exports-"));
  try {
    await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
    await writeFile(
      resolve(fixture, "firebase.json"),
      JSON.stringify({ functions: { source: "functions" } }),
    );
    await writeFile(resolve(fixture, "functions", "src", "index.ts"), lines.join("\n"));
    return await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

describe("admin-callables deploy scope (#1277)", () => {
  it.each([{ args: [] }, { args: ["--only", "functions"] }, { args: ["--only", "functions:default"] }])(
    "keeps both admin callables the real index exports strict ($args)",
    async ({ args }) => {
      const result = await classify(args);

      expect(result).toMatchObject({
        adminCallablesInvokerSelected: true,
        adminCallablesInvokerConservative: false,
        adminCallablesStrictServices: "unlock,approve",
      });
    },
  );

  it("keeps an exported unlockDayNow strict and tolerates a not-yet-exported approvePrompts", async () => {
    const result = await withIndex(
      [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => 1);",
      ],
      (configPath) =>
        classifyFirebaseDeployRequest(["fiveacross", "--only", "functions"], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: false,
      adminCallablesStrictServices: "unlock",
    });
  });

  it("resolves a local export-star to what the module exports instead of making every admin peer strict", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "admin-callable-star-"));
    try {
      await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
      await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions: { source: "functions" } }));
      await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export * from './admin';\n");
      await writeFile(
        resolve(fixture, "functions", "src", "admin.ts"),
        "import { onCall } from 'firebase-functions/v2/https';\nexport const unlockDayNow = onCall(async () => 1);\n",
      );

      const result = await classifyFirebaseDeployRequest(["fiveacross"], {
        defaultConfigPath: resolve(fixture, "firebase.json"),
      });
      expect(result).toMatchObject({
        adminCallablesInvokerSelected: true,
        adminCallablesInvokerConservative: false,
        adminCallablesStrictServices: "unlock",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("keeps both services strict once approvePrompts is exported", async () => {
    const result = await withIndex(
      [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => 1);",
        "export const approvePrompts = onCall(async () => 1);",
      ],
      (configPath) =>
        classifyFirebaseDeployRequest(["fiveacross"], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: false,
      adminCallablesStrictServices: "unlock,approve",
    });
  });

  it("does not select the family for a codebase that exports neither callable", async () => {
    const result = await withIndex(["export const unrelated = 1;"], (configPath) =>
      classifyFirebaseDeployRequest(["fiveacross"], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: false,
      adminCallablesStrictServices: "",
    });
  });

  it.each([
    ["functions:unlockDayNow", "unlock"],
    ["functions:default:unlockDayNow", "unlock"],
    ["functions:approvePrompts", "approve"],
    ["functions:unlockDayNow,functions:approvePrompts", "unlock,approve"],
    ["functions:someGroup,functions:approvePrompts", "approve"],
  ])("keeps only explicitly selected services strict for %s", async (only, strict) => {
    const result = await classify(["--only", only]);

    expect(result).toMatchObject({
      functionsAttempted: true,
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: false,
      adminCallablesStrictServices: strict,
    });
  });

  it("treats an unfamiliar Functions selector as an allow-missing probe", async () => {
    const result = await classify(["--only", "functions:someGroup"]);

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: true,
      adminCallablesStrictServices: "",
    });
  });

  it("does not inspect admin services for hosting or an unrelated exact endpoint", async () => {
    for (const only of ["hosting", "functions:emailUnsubscribe"]) {
      expect(await classify(["--only", only])).toMatchObject({
        adminCallablesInvokerSelected: false,
        adminCallablesInvokerConservative: false,
        adminCallablesStrictServices: "",
      });
    }
    expect((await classify(["--except", "functions"])).adminCallablesInvokerSelected).toBe(false);
  });

  it("emits the three admin fields in the shell classification deploy.sh parses", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts", "validate-firebase-deploy-filters.mjs"), "--", "fiveacross", "--only", "functions:unlockDayNow"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          FIREBASE_DEPLOY_DEFAULT_CONFIG: resolve(repoRoot, "firebase.json"),
          FIREBASE_DEPLOY_CLASSIFIER_FORMAT: "shell",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ADMIN_CALLABLES_INVOKER_SELECTED=true\n");
    expect(result.stdout).toContain("ADMIN_CALLABLES_INVOKER_CONSERVATIVE=false\n");
    expect(result.stdout).toContain("ADMIN_CALLABLES_STRICT_SERVICES=unlock\n");
    expect(result.stdout.trim().split("\n")).toHaveLength(17);
  });
});
