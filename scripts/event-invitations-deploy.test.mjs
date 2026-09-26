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

// One `functions` config per entry (#1282): `codebase` (omitted for the
// default codebase), `source`, and the `src/index.ts` lines.
async function classifyCodebases(codebases, args) {
  const fixture = await mkdtemp(join(tmpdir(), "event-invitation-codebases-"));
  try {
    for (const { source, index } of codebases) {
      await mkdir(resolve(fixture, source, "src"), { recursive: true });
      await writeFile(resolve(fixture, source, "src", "index.ts"), index.join("\n"));
    }
    const configs = codebases.map(({ codebase, source }) => (codebase ? { source, codebase } : { source }));
    await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions: configs }));
    return await classifyFirebaseDeployRequest(["fiveacross", ...args], {
      defaultConfigPath: resolve(fixture, "firebase.json"),
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const EXPORTS_ALL = [
  { source: "functions", index: ["mint", "redeem", "revoke"].map((verb) => `export const ${verb}EventInvitation = 1;`) },
];

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
      const result = await classifyCodebases(EXPORTS_ALL, ["--only", only]);

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
      const result = await classifyCodebases(EXPORTS_ALL, ["--only", only]);

      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: "redeem",
      });
    },
  );

  // A named service the resolved codebase does not export drops out of the
  // strict set (#1282), and a whole scope with nothing exported beside an
  // unfamiliar selector proves nothing either.
  it.each([
    "functions:someGroup",
    "functions:mintEventInvitation",
    "functions:default,functions:someGroup",
  ])("treats %s against the real index as an allow-missing probe", async (only) => {
    const result = await classify(["--only", only]);

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

describe("event-invitation deploy scope across Functions codebases (#1282)", () => {
  // Only the non-default `invites` codebase exports protected callables.
  const TWO_CODEBASES = [
    { source: "functions", index: ["export const unrelated = 1;"] },
    { codebase: "invites", source: "invites", index: ["mint", "redeem"].map((verb) => `export const ${verb}EventInvitation = 1;`) },
  ];

  // [only, selected, conservative, strict]; no `--only` at all is `null`.
  it.each([
    [null, true, false, "mint,redeem"],
    ["functions", true, false, "mint,redeem"],
    ["functions:default", false, false, ""],
    ["functions:invites", true, false, "mint,redeem"],
    ["functions:mintEventInvitation", true, true, ""],
    ["functions:invites:mintEventInvitation", true, false, "mint"],
    ["functions:invites:revokeEventInvitation", true, true, ""],
    ["functions:default,functions:invites:redeemEventInvitation", true, false, "redeem"],
  ])("marks strict only what the selected codebase exports (%s)", async (only, selected, conservative, strict) => {
    const result = await classifyCodebases(TWO_CODEBASES, only === null ? [] : ["--only", only]);

    expect(result).toMatchObject({
      functionsAttempted: true,
      eventInvitationsInvokerSelected: selected,
      eventInvitationsInvokerConservative: conservative,
      eventInvitationsStrictServices: strict,
    });
  });
});
