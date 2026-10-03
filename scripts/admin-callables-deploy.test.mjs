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

  it("stays conservative when a local star re-exports a package star (#1335)", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "admin-callable-package-star-"));
    try {
      await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
      await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions: { source: "functions" } }));
      await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export * from './admin';\n");
      await writeFile(
        resolve(fixture, "functions", "src", "admin.ts"),
        "import { onCall } from 'firebase-functions/v2/https';\nexport const unlockDayNow = onCall(async () => 1);\nexport * from 'my-admin-callables';\n",
      );

      const result = await classifyFirebaseDeployRequest(["fiveacross"], {
        defaultConfigPath: resolve(fixture, "firebase.json"),
      });
      expect(result).toMatchObject({
        adminCallablesInvokerSelected: true,
        adminCallablesInvokerConservative: true,
        adminCallablesStrictServices: "",
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

  it("selects the family conservatively for a codebase that exports neither callable (#1335)", async () => {
    const result = await withIndex(["export const unrelated = 1;"], (configPath) =>
      classifyFirebaseDeployRequest(["fiveacross"], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: true,
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
    expect(result.stdout.trim().split("\n")).toHaveLength(19);
  });
});

// One `functions` config per entry (#1282): `codebase` (omitted for the default
// codebase), `source`, and the `src/index.ts` lines. With no `index` the source
// directory has no TypeScript index; each of `dirs` is an unreadable module, and
// `modules` maps a further `src/` file name to its lines.
async function withCodebases(codebases, args) {
  const fixture = await mkdtemp(join(tmpdir(), "admin-callable-codebases-"));
  try {
    for (const { source, index, dirs = [], modules = {} } of codebases) {
      await mkdir(resolve(fixture, source, "src"), { recursive: true });
      if (index) await writeFile(resolve(fixture, source, "src", "index.ts"), index.join("\n"));
      for (const dir of dirs) await mkdir(resolve(fixture, source, "src", dir));
      for (const [name, lines] of Object.entries(modules)) {
        await writeFile(resolve(fixture, source, "src", name), lines.join("\n"));
      }
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

const UNRELATED = { source: "functions", index: ["export const unrelated = 1;"] };
const UNLOCK = ["import { onCall } from 'firebase-functions/v2/https';", "export const unlockDayNow = onCall(async () => 1);"];
const BOTH_FAMILIES_CONSERVATIVE = {
  eventInvitationsInvokerSelected: true, eventInvitationsInvokerConservative: true, eventInvitationsStrictServices: "",
  adminCallablesInvokerSelected: true, adminCallablesInvokerConservative: true, adminCallablesStrictServices: "",
};

describe("admin-callables deploy scope across Functions codebases (#1282)", () => {
  // Only the non-default `ops` codebase exports a protected callable.
  const TWO_CODEBASES = [UNRELATED, { codebase: "ops", source: "ops", index: UNLOCK }];

  // [args, selected, conservative, strict]. A selected family with nothing
  // strict is an allow-missing probe, the only empty form deploy.sh accepts. A
  // whole-codebase scope selects every family (#1335); the scan only proves
  // which services are strict.
  it.each([
    [[], true, false, "unlock"],
    [["--only", "functions"], true, false, "unlock"],
    [["--only", "functions:default"], true, true, ""],
    [["--only", "functions:ops"], true, false, "unlock"],
    [["--only", "functions:unlockDayNow"], true, true, ""],
    [["--only", "functions:default:unlockDayNow"], true, true, ""],
    [["--only", "functions:ops:unlockDayNow"], true, false, "unlock"],
    [["--only", "functions:ops:approvePrompts"], true, true, ""],
  ])("marks strict only what the selected codebase exports (%j)", async (args, selected, conservative, strict) => {
    expect(await withCodebases(TWO_CODEBASES, args)).toMatchObject({
      functionsAttempted: true,
      adminCallablesInvokerSelected: selected,
      adminCallablesInvokerConservative: conservative,
      adminCallablesStrictServices: strict,
    });
  });

  it("selects a single-service family a codebase selector's index does not export conservatively (#1335)", async () => {
    const result = await withCodebases(TWO_CODEBASES, ["--only", "functions:ops"]);
    expect(result).toMatchObject({
      bugReportInvokerSelected: true, bugReportInvokerConservative: true,
      emailUnsubscribeInvokerSelected: true, emailUnsubscribeInvokerConservative: true,
      authHandoffInvokerSelected: true, authHandoffInvokerConservative: true,
    });
  });

  // A codebase with no TypeScript index (JavaScript, Python), or an index the
  // syntax scan cannot follow, has an unknown surface rather than an empty one
  // and is never refused (#1283): a scope that releases it keeps both families
  // selected with every service allowed absent.
  const NO_INDEX = [UNRELATED, { codebase: "ops", source: "ops" }];
  const UNFOLLOWABLE = [{ source: "functions", index: ["export * from './admin';"], dirs: ["admin.ts"] }];
  it.each([
    [NO_INDEX, []],
    [NO_INDEX, ["--only", "functions"]],
    [NO_INDEX, ["--only", "functions:ops"]],
    [UNFOLLOWABLE, ["--only", "functions:default"]],
  ])("keeps both families selected conservatively for an uninventoried codebase (%#)", async (codebases, args) => {
    expect(await withCodebases(codebases, args)).toMatchObject(BOTH_FAMILIES_CONSERVATIVE);
  });

  // The scan reads only ESM export declarations. An index that reaches its
  // exports object any other way, itself or behind a local star, is unknown
  // rather than empty, so its codebase keeps both families selected
  // conservatively instead of skipping the wrapper for a callable it publishes.
  const ON_CALL = "import { onCall } from 'firebase-functions/v2/https';";
  const CJS_ADMIN = ["import { onCall } from 'firebase-functions/v2/https';", "exports.unlockDayNow = onCall(async () => 1);"];
  it.each([
    ["Object.assign(exports, ...)", [ON_CALL, "Object.assign(exports, { unlockDayNow: onCall(async () => 1) });"]],
    ["exports.x = onCall(...)", [ON_CALL, "exports.unlockDayNow = onCall(async () => 1);"]],
    ["module.exports = {...}", [ON_CALL, "module.exports = { unlockDayNow: onCall(async () => 1) };"]],
    ["Object.defineProperty(exports, ...)", [ON_CALL, "Object.defineProperty(exports, 'unlockDayNow', { enumerable: true, value: onCall(async () => 1) });"]],
    ["a computed member export", [ON_CALL, "const name = 'unlockDayNow';", "exports[name] = onCall(async () => 1);"]],
    ["a top-level this", [ON_CALL, "(this as any).unlockDayNow = onCall(async () => 1);"]],
    ["export =", [ON_CALL, "export = { unlockDayNow: onCall(async () => 1) };"]],
    ["a destructured export", [ON_CALL, "export const { unlockDayNow } = { unlockDayNow: onCall(async () => 1) };"]],
    ["export import", ["export import unlockDayNow = require('./admin');"]],
  ])("keeps both families selected conservatively for an index exporting through %s", async (_form, index) => {
    const ops = { codebase: "ops", source: "ops", index };
    expect(await withCodebases([UNRELATED, ops], ["--only", "functions:ops"])).toMatchObject(BOTH_FAMILIES_CONSERVATIVE);
  });

  it.each([
    [[{ source: "functions", index: CJS_ADMIN }], ["--only", "functions:default"]],
    [[{ source: "functions", index: CJS_ADMIN }], []],
    [[{ source: "functions", index: ["export * from './admin';"], modules: { "admin.ts": CJS_ADMIN } }], ["--only", "functions:default"]],
  ])("treats CommonJS exports in the default codebase, or behind a local star, as unknown (%#)", async (codebases, args) => {
    expect(await withCodebases(codebases, args)).toMatchObject(BOTH_FAMILIES_CONSERVATIVE);
  });

  it("keeps an index inventoried when exports, module and this appear only where they are not the module's", async () => {
    const ops = {
      codebase: "ops",
      source: "ops",
      index: [
        ...UNLOCK,
        "const box = { exports: 1, module: 2 };",
        "export const size = box.exports + box.module;",
        "export function self(this: unknown) { return this; }",
        "export class Holder { value = this; }",
      ],
    };
    // Inventoried, so the proven callable stays strict; an unknown index would prove nothing.
    expect(await withCodebases([UNRELATED, ops], ["--only", "functions:ops"])).toMatchObject({
      eventInvitationsInvokerSelected: true,
      eventInvitationsInvokerConservative: true,
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: false,
      adminCallablesStrictServices: "unlock",
    });
  });

  it("answers functions:default from its own inventory beside an uninventoried codebase", async () => {
    const result = await withCodebases([{ source: "functions", index: UNLOCK }, NO_INDEX[1]], ["--only", "functions:default"]);
    expect(result).toMatchObject({ eventInvitationsInvokerConservative: true, adminCallablesInvokerConservative: false, adminCallablesStrictServices: "unlock" });
  });

  // An opaque star proves nothing (Phase 4b P2 on #1335): unknown, never every service strict.
  it.each([
    [["export * from 'callables-package';"], {}],
    [["export * from './barrel';"], { "barrel.ts": ["export * from 'callables-package';"] }],
  ])("treats a package export-star in the selected codebase as unknown (%#)", async (index, modules) => {
    const ops = { codebase: "ops", source: "ops", index, modules };
    expect(await withCodebases([UNRELATED, ops], ["--only", "functions:ops"])).toMatchObject({
      ...BOTH_FAMILIES_CONSERVATIVE,
      bugReportInvokerConservative: true, emailUnsubscribeInvokerConservative: true,
      authHandoffInvokerConservative: true, authHandoffStrictHalf: "",
    });
  });
});

// The single-service families follow the same per-codebase rules (#1299), and a
// whole-codebase scope selects every family (#1335). Only the non-default `ops`
// codebase exports submitBugReport and mintAuthHandoff; no codebase exports
// emailUnsubscribe or exchangeAuthHandoff.
describe("single-service invoker families across Functions codebases (#1299)", () => {
  const OPS_SINGLES = [
    "import { onCall } from 'firebase-functions/v2/https';",
    "export const submitBugReport = onCall(async () => 1);",
    "export const mintAuthHandoff = onCall(async () => 1);",
  ];
  const TWO_CODEBASES = [UNRELATED, { codebase: "ops", source: "ops", index: OPS_SINGLES }];
  // Per family: "-" not selected, "S" selected strict, "C" selected with the
  // service allowed absent, "mint" auth handoff strict for its mint half only.
  const fields = (bug, email, auth) => ({
    bugReportInvokerSelected: bug !== "-",
    bugReportInvokerConservative: bug === "C",
    emailUnsubscribeInvokerSelected: email !== "-",
    emailUnsubscribeInvokerConservative: email === "C",
    authHandoffInvokerSelected: auth !== "-",
    authHandoffInvokerConservative: auth === "C",
    authHandoffStrictHalf: auth === "mint" ? "mint" : "",
  });

  it.each([
    [[], "S", "C", "mint"],
    [["--only", "functions"], "S", "C", "mint"],
    [["--only", "functions:default"], "C", "C", "C"],
    [["--only", "functions:ops"], "S", "C", "mint"],
    [["--only", "functions:submitBugReport"], "C", "-", "-"],
    [["--only", "functions:default:submitBugReport"], "C", "-", "-"],
    [["--only", "functions:ops:submitBugReport"], "S", "-", "-"],
    [["--only", "functions:emailUnsubscribe"], "-", "C", "-"],
    [["--only", "functions:ops:emailUnsubscribe"], "-", "C", "-"],
    [["--only", "functions:mintAuthHandoff"], "-", "-", "C"],
    [["--only", "functions:default:mintAuthHandoff"], "-", "-", "C"],
    [["--only", "functions:ops:mintAuthHandoff"], "-", "-", "mint"],
    [["--only", "functions:exchangeAuthHandoff"], "-", "-", "C"],
    [["--only", "functions:ops:exchangeAuthHandoff"], "-", "-", "C"],
    [["--only", "functions:ops:mintAuthHandoff,functions:ops:exchangeAuthHandoff"], "-", "-", "mint"],
    [["--only", "functions:default,functions:ops:submitBugReport"], "S", "C", "C"],
  ])("marks strict only what the selected codebase exports (%j)", async (args, bug, email, auth) => {
    expect(await withCodebases(TWO_CODEBASES, args)).toMatchObject({ functionsAttempted: true, ...fields(bug, email, auth) });
  });

  it("keeps only the exchange half strict when the selected codebase exports exchange alone", async () => {
    const ops = {
      codebase: "ops",
      source: "ops",
      index: [OPS_SINGLES[0], "export const submitBugReport = onCall(async () => 1);", "export const exchangeAuthHandoff = onCall(async () => 1);"],
    };
    expect(await withCodebases([UNRELATED, ops], ["--only", "functions:ops"])).toMatchObject({
      authHandoffInvokerSelected: true,
      authHandoffInvokerConservative: false,
      authHandoffStrictHalf: "exchange",
    });
  });

  it("keeps both auth-handoff halves strict when the selected codebase exports both", async () => {
    const ops = { codebase: "ops", source: "ops", index: [...OPS_SINGLES, "export const exchangeAuthHandoff = onCall(async () => 1);"] };
    expect(await withCodebases([UNRELATED, ops], ["--only", "functions:ops"])).toMatchObject(fields("S", "C", "S"));
  });

  // An index the scan does not read (here CommonJS) is unknown, not empty: a
  // scope that releases its codebase keeps all three families selected with
  // every service allowed absent, as a whole-codebase scope of its peer does.
  const OPAQUE = [
    UNRELATED,
    { codebase: "ops", source: "ops", index: ["import { onCall } from 'firebase-functions/v2/https';", "exports.submitBugReport = onCall(async () => 1);"] },
  ];
  it.each([
    [[], "C", "C", "C"],
    [["--only", "functions"], "C", "C", "C"],
    [["--only", "functions:ops"], "C", "C", "C"],
    [["--only", "functions:ops:submitBugReport"], "C", "-", "-"],
    [["--only", "functions:default"], "C", "C", "C"],
  ])("keeps the families conservative for an uninventoried codebase (%j)", async (args, bug, email, auth) => {
    expect(await withCodebases(OPAQUE, args)).toMatchObject(fields(bug, email, auth));
  });

  // A protected name a local star reaches with a value the scan cannot classify
  // is unknown, not absent (Phase 4b P1 on #1335): every family stays selected
  // conservatively instead of skipping a wrapper for a service the build may publish.
  const V2 = "import { https } from 'firebase-functions/v2';";
  const UNREAD_HANDOFF = {
    "an element-access builder": { "handoff.ts": [V2, "export const mintAuthHandoff = https['onCall'](async () => 1);"] },
    "a call through a local alias": { "handoff.ts": [V2, "const make = https.onCall;", "export const mintAuthHandoff = make(async () => 1);"] },
    "a let assigned later": { "handoff.ts": [V2, "export let mintAuthHandoff: unknown;", "mintAuthHandoff = https.onCall(async () => 1);"] },
    "a nested named re-export": {
      "handoff.ts": ["export * from './callables';"],
      "callables.ts": [V2, "const mint = https['onCall'](async () => 1);", "export { mint as mintAuthHandoff };"],
    },
    "a package re-export": { "handoff.ts": ["export { mintAuthHandoff } from 'handoff-package';"] },
    "an unclassified default renamed by a re-export": {
      "handoff.ts": ["export { default as mintAuthHandoff } from './leaf';"],
      "leaf.ts": [V2, "export default https['onCall'](async () => 1);"],
    },
    "a default of an unclassified binding renamed by a re-export": {
      "handoff.ts": ["export { default as mintAuthHandoff } from './leaf';"],
      "leaf.ts": [V2, "const mint = https['onCall'](async () => 1);", "export default mint;"],
    },
    "an unclassified default imported and re-exported": {
      "handoff.ts": ["import mint from './leaf';", "export { mint as mintAuthHandoff };"],
      "leaf.ts": [V2, "export default https['onCall'](async () => 1);"],
    },
  };
  const ALL_CONSERVATIVE = { ...BOTH_FAMILIES_CONSERVATIVE, ...fields("C", "C", "C") };
  const starCases = Object.entries(UNREAD_HANDOFF).flatMap(([form, modules]) => [
    [form, [{ source: "functions", index: ["export * from './handoff';"], modules }], []],
    [form, [{ source: "functions", index: ["export * from './handoff';"], modules }], ["--only", "functions"]],
    [form, [{ source: "functions", index: ["export * from './handoff';"], modules }], ["--only", "functions:default"]],
    [form, [UNRELATED, { codebase: "ops", source: "ops", index: ["export * from './handoff';"], modules }], ["--only", "functions:ops"]],
  ]);
  it.each(starCases)("treats mintAuthHandoff behind a local star through %s as unknown (%#)", async (_form, codebases, args) => {
    expect(await withCodebases(codebases, args)).toMatchObject(ALL_CONSERVATIVE);
  });

  it("keeps a recognized builder behind a local star strict and allows inert or unrelated exports absent", async () => {
    const handoff = [
      "import * as https from 'firebase-functions/v2/https';",
      "import { getFirestore } from 'firebase-admin/firestore';",
      "export const mintAuthHandoff = https.onCall(async () => 1);",
      "export const db = getFirestore();",
      "export function submitBugReport() { return 1; }",
      "export const emailUnsubscribe = 'inert';",
    ];
    const codebases = [{ source: "functions", index: ["export * from './handoff';"], modules: { "handoff.ts": handoff } }];
    expect(await withCodebases(codebases, ["--only", "functions:default"])).toMatchObject({
      ...fields("C", "C", "mint"),
      ...BOTH_FAMILIES_CONSERVATIVE,
    });
  });

  it("keeps a classified default renamed behind a local star strict", async () => {
    const modules = {
      "handoff.ts": ["export { default as mintAuthHandoff } from './leaf';"],
      "leaf.ts": ["import { onCall } from 'firebase-functions/v2/https';", "export default onCall(async () => 1);"],
    };
    const codebases = [{ source: "functions", index: ["export * from './handoff';"], modules }];
    expect(await withCodebases(codebases, ["--only", "functions:default"])).toMatchObject({
      ...fields("C", "C", "mint"),
      ...BOTH_FAMILIES_CONSERVATIVE,
    });
  });
});
