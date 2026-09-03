// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("event-invitation deploy scope", () => {
  it("does not claim services that the real Functions index does not export", async () => {
    const source = await readFile(
      resolve(repoRoot, "functions", "src", "index.ts"),
      "utf8",
    );

    expect(source).not.toMatch(
      /export\s+const\s+(?:mintEventInvitation|redeemEventInvitation|revokeEventInvitation)\b/,
    );
  });

  it.each([
    { args: [] },
    { args: ["--only", "functions"] },
    { args: ["--only", "functions:default"] },
  ])(
    "skips unexported services for a full Functions release ($args)",
    async ({ args }) => {
      const result = await classify(args);

      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: false,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: "",
      });
    },
  );

  it("keeps every actually exported service strict for a full Functions release", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "event-invitation-exports-"));
    try {
      await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
      await writeFile(
        resolve(fixture, "firebase.json"),
        JSON.stringify({ functions: { source: "functions" } }),
      );
      await writeFile(
        resolve(fixture, "functions", "src", "index.ts"),
        [
          "export const mintEventInvitation = 1;",
          "const redeemHandler = 2;",
          "export { redeemHandler as redeemEventInvitation };",
          "export { revokeEventInvitation } from './revoke.js';",
        ].join("\n"),
      );

      const result = await classifyFirebaseDeployRequest(["fiveacross"], {
        defaultConfigPath: resolve(fixture, "firebase.json"),
      });
      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: "mint,redeem,revoke",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("ignores type-only export declarations that Firebase cannot deploy", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "event-invitation-type-exports-"));
    try {
      await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
      await writeFile(
        resolve(fixture, "firebase.json"),
        JSON.stringify({ functions: { source: "functions" } }),
      );
      await writeFile(
        resolve(fixture, "functions", "src", "index.ts"),
        [
          "type mintEventInvitation = string;",
          "export type { mintEventInvitation };",
          "export type { redeemEventInvitation, revokeEventInvitation } from './types.js';",
        ].join("\n"),
      );

      const result = await classifyFirebaseDeployRequest(["fiveacross"], {
        defaultConfigPath: resolve(fixture, "firebase.json"),
      });
      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: false,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: "",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("fails closed for a runtime export-star whose names cannot be known locally", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "event-invitation-star-export-"));
    try {
      await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
      await writeFile(
        resolve(fixture, "firebase.json"),
        JSON.stringify({ functions: { source: "functions" } }),
      );
      await writeFile(
        resolve(fixture, "functions", "src", "index.ts"),
        "export * from './runtime.js';\n",
      );

      const result = await classifyFirebaseDeployRequest(["fiveacross"], {
        defaultConfigPath: resolve(fixture, "firebase.json"),
      });
      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: "mint,redeem,revoke",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ["functions:mintEventInvitation", "mint"],
    ["functions:default:redeemEventInvitation", "redeem"],
    ["functions:revokeEventInvitation", "revoke"],
    [
      "functions:mintEventInvitation,functions:revokeEventInvitation",
      "mint,revoke",
    ],
  ])(
    "keeps only explicitly selected services strict for %s",
    async (only, strict) => {
      const result = await classify(["--only", only]);

      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: strict,
      });
    },
  );

  it.each([
    "functions:someGroup,functions:redeemEventInvitation",
    "functions:redeemEventInvitation,functions:someGroup",
  ])(
    "keeps an exact endpoint strict alongside an unfamiliar selector (%s)",
    async (only) => {
      const result = await classify(["--only", only]);

      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: "redeem",
      });
    },
  );

  it("treats an unfamiliar Functions selector as an allow-missing probe", async () => {
    const result = await classify(["--only", "functions:someGroup"]);

    expect(result).toMatchObject({
      eventInvitationsInvokerSelected: true,
      eventInvitationsInvokerConservative: true,
      eventInvitationsStrictServices: "",
    });
  });

  it("does not inspect invitation services for an unrelated exact endpoint", async () => {
    const result = await classify(["--only", "functions:emailUnsubscribe"]);

    expect(result).toMatchObject({
      eventInvitationsInvokerSelected: false,
      eventInvitationsInvokerConservative: false,
      eventInvitationsStrictServices: "",
    });
  });

  it("honors only the top-level Functions exclusion", async () => {
    const excluded = await classify(["--except", "functions"]);
    expect(excluded.eventInvitationsInvokerSelected).toBe(false);

    const endpointQualifiedNoop = await classify([
      "--except",
      "functions:mintEventInvitation",
    ]);
    expect(endpointQualifiedNoop).toMatchObject({
      eventInvitationsInvokerSelected: false,
      eventInvitationsInvokerConservative: false,
      eventInvitationsStrictServices: "",
    });
  });
});
