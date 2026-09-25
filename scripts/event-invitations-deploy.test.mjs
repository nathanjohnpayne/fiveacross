// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A Node Functions source: `src/` plus the `package.json` whose presence makes
// the CLI pick the Node runtime, with the conventional `lib/index.js` entry.
async function nodeSource(dir) {
  await mkdir(resolve(dir, "src"), { recursive: true });
  await writeFile(resolve(dir, "package.json"), JSON.stringify({ main: "lib/index.js" }));
}

async function classify(args) {
  return classifyFirebaseDeployRequest(["fiveacross", ...args], {
    defaultConfigPath: resolve(repoRoot, "firebase.json"),
  });
}

async function classifyAt(configPath, args) {
  return classifyFirebaseDeployRequest(["fiveacross", ...args], {
    defaultConfigPath: configPath,
  });
}

const ALL_INVITATIONS = [
  "export const mintEventInvitation = 1;",
  "export const redeemEventInvitation = 2;",
  "export const revokeEventInvitation = 3;",
];

// A fixture project with one `functions` config per entry: `codebase` (omitted
// for the default codebase), `source`, and the `src/index.ts` lines.
async function withCodebases(codebases, run) {
  const fixture = await mkdtemp(join(tmpdir(), "event-invitation-codebases-"));
  try {
    const configs = [];
    for (const { codebase, source, index } of codebases) {
      await nodeSource(resolve(fixture, source));
      await writeFile(resolve(fixture, source, "src", "index.ts"), index.join("\n"));
      configs.push(codebase ? { source, codebase } : { source });
    }
    await writeFile(
      resolve(fixture, "firebase.json"),
      JSON.stringify({ functions: configs.length === 1 ? configs[0] : configs }),
    );
    return await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
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
      await nodeSource(resolve(fixture, "functions"));
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
      await nodeSource(resolve(fixture, "functions"));
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
      await nodeSource(resolve(fixture, "functions"));
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
      const result = await withCodebases(
        [{ source: "functions", index: ALL_INVITATIONS }],
        (configPath) => classifyAt(configPath, ["--only", only]),
      );

      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: strict,
      });
    },
  );

  it("drops a named service the real index does not export out of the strict set (#1282)", async () => {
    const result = await classify(["--only", "functions:mintEventInvitation"]);

    // Nothing proven released, so the family is an allow-missing probe.
    expect(result).toMatchObject({
      eventInvitationsInvokerSelected: true,
      eventInvitationsInvokerConservative: true,
      eventInvitationsStrictServices: "",
    });
  });

  it.each([
    "functions:someGroup,functions:redeemEventInvitation",
    "functions:redeemEventInvitation,functions:someGroup",
  ])(
    "keeps an exact endpoint strict alongside an unfamiliar selector (%s)",
    async (only) => {
      const result = await withCodebases(
        [{ source: "functions", index: ALL_INVITATIONS }],
        (configPath) => classifyAt(configPath, ["--only", only]),
      );

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

describe("event-invitation deploy scope across Functions codebases (#1282)", () => {
  // Only the non-default codebase exports protected callables.
  const TWO_CODEBASES = [
    { source: "functions", index: ["export const unrelated = 1;"] },
    {
      codebase: "invites",
      source: "invites",
      index: ["export const mintEventInvitation = 1;", "export const redeemEventInvitation = 2;"],
    },
  ];

  // [args, selected, conservative, strict]. A selected family with nothing
  // strict is an allow-missing probe, the only empty form deploy.sh accepts.
  it.each([
    [[], true, false, "mint,redeem"],
    [["--only", "functions"], true, false, "mint,redeem"],
    [["--only", "functions:default"], false, false, ""],
    [["--only", "functions:invites"], true, false, "mint,redeem"],
    [["--only", "functions:mintEventInvitation"], true, true, ""],
    [["--only", "functions:default:mintEventInvitation"], true, true, ""],
    [["--only", "functions:invites:mintEventInvitation"], true, false, "mint"],
    [["--only", "functions:invites:revokeEventInvitation"], true, true, ""],
    [["--only", "functions:default,functions:invites:redeemEventInvitation"], true, false, "redeem"],
    [["--only", "functions:someGroup,functions:default"], true, true, ""],
  ])("marks strict only what the selected codebase exports (%j)", async (args, selected, conservative, strict) => {
    const result = await withCodebases(TWO_CODEBASES, (configPath) => classifyAt(configPath, args));

    expect(result).toMatchObject({
      functionsAttempted: true,
      eventInvitationsInvokerSelected: selected,
      eventInvitationsInvokerConservative: conservative,
      eventInvitationsStrictServices: strict,
    });
  });

  it("keeps the families this ticket does not scope conservative for a non-default codebase", async () => {
    const result = await withCodebases(TWO_CODEBASES, (configPath) =>
      classifyAt(configPath, ["--only", "functions:invites"]),
    );

    expect(result).toMatchObject({
      bugReportInvokerSelected: true,
      bugReportInvokerConservative: true,
      emailUnsubscribeInvokerConservative: true,
      authHandoffInvokerConservative: true,
    });
  });
});
