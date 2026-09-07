// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The conventional Firebase predeploy hook. */
const PREDEPLOY = ['npm --prefix "$RESOURCE_DIR" run build'];

function classify(args, configPath = resolve(repoRoot, "firebase.json")) {
  return classifyFirebaseDeployRequest(["fiveacross", ...args], {
    defaultConfigPath: configPath,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
//
// The classifier answers by BUILDING a codebase the way the deploy will and
// walking the artifact, so a fixture is a real (tiny) Functions package: a
// `tsc` on PATH, a stub `firebase-functions` in its own `node_modules` (real
// files, so the compile typechecks and nothing reaches the network), and
// whatever package.json / tsconfig / predeploy shape the case is about.
// ---------------------------------------------------------------------------

/**
 * A stub `firebase-functions` whose `onX` factories return exactly what the
 * runtime loader looks for: a FUNCTION carrying an `__endpoint` object
 * (`firebase-functions/lib/runtime/loader.js` `extractStack`).
 */
const STUB_SDK_INDEX = [
  '"use strict";',
  "exports.builder = (factory) => (...args) => {",
  "  const endpoint = function handler() {};",
  '  endpoint.__endpoint = { platform: "gcfv2", factory, args: args.length };',
  "  return endpoint;",
  "};",
].join("\n");

const STUB_SDK_MODULES = {
  "package.json": JSON.stringify({
    name: "firebase-functions",
    version: "0.0.0-stub",
    main: "index.js",
  }),
  "index.js": STUB_SDK_INDEX,
  "index.d.ts": "export declare function builder(factory: string): (...a: any[]) => any;\n",
  "v2/scheduler.js": 'module.exports = { onSchedule: require("../index.js").builder("onSchedule") };\n',
  "v2/scheduler.d.ts":
    "export declare function onSchedule(schedule: string, handler: (...a: any[]) => any): any;\n",
  "v2/https.js":
    'module.exports = { onCall: require("../index.js").builder("onCall"), HttpsError: function () {} };\n',
  "v2/https.d.ts": [
    "export declare function onCall(handler: (...a: any[]) => any): any;",
    "export declare function HttpsError(code: string, message: string): any;",
  ].join("\n"),
  // A provider TWO levels deep: the classifier's stub recognises any SDK
  // subpath, so this must be exempt without the subpath being enumerated
  // anywhere.
  "v2/alerts/billing.js":
    'module.exports = { onPlanUpdatePublished: require("../../index.js").builder("onPlanUpdatePublished") };\n',
  "v2/alerts/billing.d.ts":
    "export declare function onPlanUpdatePublished(handler: (...a: any[]) => any): any;\n",
};

const DEFAULT_PACKAGE = {
  name: "fixture-functions",
  private: true,
  main: "lib/index.js",
  engines: { node: "22" },
  scripts: { build: "tsc" },
};

const DEFAULT_TSCONFIG = {
  compilerOptions: {
    module: "commonjs",
    target: "es2021",
    outDir: "lib",
    rootDir: "src",
    esModuleInterop: true,
    skipLibCheck: true,
    moduleResolution: "node",
  },
  // As this repository's own functions/tsconfig.json does. It also keeps a
  // fixture's spare `.ts` payload (the file a pre/predeploy step copies over
  // the entrypoint) out of the program, so those cases fail on the ARTIFACT
  // rather than on a compile error about an unrelated file.
  include: ["src"],
};

async function writeUnder(dir, relativePath, contents) {
  const target = resolve(dir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

/** `tsc`, Node's ambient types, and the stub SDK, in one codebase's `node_modules`. */
async function installToolchain(functionsDir) {
  const modules = resolve(functionsDir, "node_modules");
  await mkdir(resolve(modules, ".bin"), { recursive: true });
  await mkdir(resolve(modules, "@types"), { recursive: true });
  await symlink(
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    resolve(modules, ".bin", "tsc"),
  );
  // So a fixture can write `exports.x = …` — a Functions entrypoint really does
  // have Node's globals, and the CommonJS-mutation cases are about what the
  // ARTIFACT ends up exporting, not about whether the name typechecks.
  await symlink(join(repoRoot, "node_modules", "@types", "node"), resolve(modules, "@types", "node"));
  for (const [file, contents] of Object.entries(STUB_SDK_MODULES)) {
    await writeUnder(resolve(modules, "firebase-functions"), file, contents);
  }
}

const BUILDER_IMPORT = "import { onSchedule } from 'firebase-functions/v2/scheduler';";

const endpoint = (name) =>
  [BUILDER_IMPORT, `export const ${name} = onSchedule('every day 00:00', () => {});`].join("\n");

/**
 * A prewritten artifact: the CommonJS `lib/index.js` shape the runtime loader
 * would find. Used by cases about what the artifact IS, as opposed to cases
 * about what a build DOES to it.
 */
const artifact = (body) =>
  [
    '"use strict";',
    "function endpoint() {",
    "  const e = function handler() {};",
    '  e.__endpoint = { platform: "gcfv2" };',
    "  return e;",
    "}",
    body,
  ].join("\n");

/**
 * One temp project with one Functions codebase.
 *
 * @param {{
 *   source?: string,            // functions/src/index.ts
 *   pkg?: object,               // functions/package.json (replaces the default)
 *   tsconfig?: object | null,   // functions/tsconfig.json (null omits it)
 *   functionsConfig?: object,   // merged into firebase.json's functions config
 *   files?: Record<string, string>, // extra files, relative to the fixture root
 * }} spec
 */
async function withFunctionsProject(spec, run) {
  const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-scope-"));
  try {
    const functionsDir = resolve(fixture, "functions");
    await mkdir(resolve(functionsDir, "src"), { recursive: true });
    await installToolchain(functionsDir);
    await writeUnder(
      functionsDir,
      "package.json",
      JSON.stringify(spec.pkg ?? DEFAULT_PACKAGE),
    );
    if (spec.tsconfig !== null) {
      await writeUnder(
        functionsDir,
        "tsconfig.json",
        JSON.stringify(spec.tsconfig ?? DEFAULT_TSCONFIG),
      );
    }
    await writeUnder(functionsDir, "src/index.ts", spec.source ?? endpoint("daily"));
    for (const [file, contents] of Object.entries(spec.files ?? {})) {
      await writeUnder(fixture, file, contents);
    }
    await writeUnder(
      fixture,
      "firebase.json",
      JSON.stringify({
        functions: { source: "functions", predeploy: PREDEPLOY, ...spec.functionsConfig },
      }),
    );
    await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

/** The shorthand most fail-closed cases need: only `src/index.ts` varies. */
const withFunctionsSource = (source, run) => withFunctionsProject({ source }, run);

/**
 * A temp project with several configured codebases. `sources` maps a codebase
 * name to its `src/index.ts`; the key "default" writes a config with no
 * explicit `codebase` key, which is how Firebase spells the default.
 */
async function withCodebases(sources, run) {
  const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-codebases-"));
  try {
    const functions = [];
    for (const [codebase, source] of Object.entries(sources)) {
      const dir = `functions-${codebase}`;
      await mkdir(resolve(fixture, dir, "src"), { recursive: true });
      await installToolchain(resolve(fixture, dir));
      await writeUnder(resolve(fixture, dir), "package.json", JSON.stringify(DEFAULT_PACKAGE));
      await writeUnder(resolve(fixture, dir), "tsconfig.json", JSON.stringify(DEFAULT_TSCONFIG));
      await writeUnder(resolve(fixture, dir), "src/index.ts", source);
      functions.push(
        codebase === "default"
          ? { source: dir, predeploy: PREDEPLOY }
          : { source: dir, codebase, predeploy: PREDEPLOY },
      );
    }
    await writeUnder(fixture, "firebase.json", JSON.stringify({ functions }));
    await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

// Every invoker the conservative fallback would otherwise switch on. Asserting
// the whole set matters: the bug this closes was one selector forcing ALL of
// them true, not just the auth-handoff one.
const NO_INVOKER_SELECTED = {
  bugReportInvokerSelected: false,
  emailUnsubscribeInvokerSelected: false,
  authHandoffInvokerSelected: false,
  eventInvitationsInvokerSelected: false,
};

const EXEMPT = { ...NO_INVOKER_SELECTED, functionsAttempted: true };

/**
 * Proving a scope runs that codebase's real `predeploy` hooks, so these suites
 * shell out to `npm` and `tsc`. A shared-CI runner is several times slower than
 * a dev machine at both, and vitest's 5s default is not a budget any of this
 * fits in; the ceiling below exists to catch a HANG, not to police duration.
 */
const RUNS_A_BUILD = { timeout: 120_000 };

const ALL_INVOKERS_CONSERVATIVE = {
  bugReportInvokerSelected: true,
  emailUnsubscribeInvokerSelected: true,
  authHandoffInvokerSelected: true,
  authHandoffInvokerConservative: true,
};

describe("exact single-endpoint scopes against the real Functions index", RUNS_A_BUILD, () => {
  it("does not select any invoker for endpoints the artifact deploys alone", async () => {
    const result = await classify([
      "--only",
      "functions:dailyEngagementEmail,functions:adminAlertDigest",
    ]);
    expect(result).toMatchObject({
      functionsAttempted: true,
      hostingAttempted: false,
      ...NO_INVOKER_SELECTED,
    });
  });

  it("accepts the codebase-qualified form of the same endpoint", async () => {
    // `functions:<codebase>:<name>` is Firebase's documented three-part form.
    const result = await classify(["--only", "functions:default:dailyEngagementEmail"]);
    expect(result).toMatchObject(EXEMPT);
  });

  it.each(["functions:mintAuthHandoff", "functions:exchangeAuthHandoff"])(
    "still selects the auth-handoff invoker for %s",
    async (selector) => {
      const result = await classify(["--only", selector]);
      // Non-conservative: the callable is NAMED, not merely possible.
      expect(result).toMatchObject({
        authHandoffInvokerSelected: true,
        authHandoffInvokerConservative: false,
      });
    },
  );

  it.each([
    ["functions:submitBugReport", "bugReportInvokerSelected"],
    ["functions:emailUnsubscribe", "emailUnsubscribeInvokerSelected"],
  ])("keeps %s bound to its own invoker and no other", async (selector, key) => {
    const result = await classify(["--only", selector]);
    expect(result[key]).toBe(true);
    expect(result.authHandoffInvokerSelected).toBe(false);
  });

  it("stays conservative for a name the index does not export", async () => {
    const result = await classify(["--only", "functions:someUnknownGroup"]);
    expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
  });

  it("stays conservative for a dotted group path", async () => {
    // `--only functions:group1.subgroup1` is Firebase's group syntax; a dotted
    // tail is never a single endpoint.
    const result = await classify(["--only", "functions:group1.subgroup1"]);
    expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
  });

  it("still selects everything for a whole-codebase scope", async () => {
    const result = await classify(["--only", "functions"]);
    expect(result).toMatchObject({
      authHandoffInvokerSelected: true,
      authHandoffInvokerConservative: false,
    });
  });
});

describe("the built artifact decides, not the TypeScript source", RUNS_A_BUILD, () => {
  it("exempts a single endpoint that survives the real build", async () => {
    // The positive control for this whole describe: without it, every
    // assertion below would still pass if the exemption never fired at all.
    await withFunctionsProject({}, async (configPath) => {
      expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
    });
  });

  it("refuses a build script that overwrites the entrypoint after compiling", async () => {
    // Codex P1 (round 9): `tsc && cp group.js lib/index.js` compiles the proven
    // source and then replaces what Firebase loads. The compile is real; the
    // artifact is a group.
    await withFunctionsProject(
      {
        pkg: { ...DEFAULT_PACKAGE, scripts: { build: "tsc && cp group.js lib/index.js" } },
        files: {
          "functions/group.js": artifact("exports.daily = { submitBugReport: endpoint() };"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an npm postbuild script that swaps the artifact", async () => {
    // Codex P1 (round 9): npm runs `postbuild` automatically after `build`, so
    // nothing in `scripts.build` or the predeploy hook mentions the swap.
    await withFunctionsProject(
      {
        pkg: {
          ...DEFAULT_PACKAGE,
          scripts: { build: "tsc", postbuild: "cp group.js lib/index.js" },
        },
        files: {
          "functions/group.js": artifact("exports.daily = { submitBugReport: endpoint() };"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an npm prebuild script that rewrites the source before it compiles", async () => {
    // The other half of the same finding: `prebuild` replaces the file the
    // pre-check read, and `tsc` then compiles a group under the same name.
    await withFunctionsProject(
      {
        pkg: {
          ...DEFAULT_PACKAGE,
          scripts: { prebuild: "cp group-index.ts src/index.ts", build: "tsc" },
        },
        files: {
          "functions/group-index.ts": [
            BUILDER_IMPORT,
            "export const daily = { submitBugReport: onSchedule('every day 00:00', () => {}) };",
          ].join("\n"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an earlier predeploy step that rewrites the source", async () => {
    // Codex P1 (round 9): hooks run in order, so a step BEFORE the build can
    // replace the inventoried source and the build then succeeds on a group.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: ["cp functions/group-index.ts functions/src/index.ts", ...PREDEPLOY],
        },
        files: {
          "functions/group-index.ts": [
            BUILDER_IMPORT,
            "export const daily = { submitBugReport: onSchedule('every day 00:00', () => {}) };",
          ].join("\n"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses a short-circuited build that never compiles anything", async () => {
    // Codex P1 (round 9): `true || tsc` exits 0 with nothing built. There is no
    // artifact to load, so there is nothing to be exempt about.
    await withFunctionsProject(
      { pkg: { ...DEFAULT_PACKAGE, scripts: { build: "true || tsc" } } },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("exempts a builder from a nested SDK provider subpath", async () => {
    // `firebase-functions/v2/alerts/billing` is two levels below `v2`. The walk
    // recognises the SHAPE the loader recognises, so no subpath is enumerated.
    await withFunctionsProject(
      {
        source: [
          "import { onPlanUpdatePublished } from 'firebase-functions/v2/alerts/billing';",
          "export const daily = onPlanUpdatePublished(() => {});",
        ].join("\n"),
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("exempts a source that binds `module` as an ordinary local name", async () => {
    // The artifact walk reads VALUES, so an identifier that merely spells
    // `module` or `exports` costs nothing — where a source-text guard had to
    // refuse the whole file to stay safe.
    await withFunctionsProject(
      {
        source: [
          BUILDER_IMPORT,
          "const describe = (module: string, exports: number) => `${module}:${exports}`;",
          "export const daily = onSchedule('every day 00:00', () => {",
          "  console.log(describe('engagement', 3));",
          "});",
        ].join("\n"),
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("refuses a CommonJS mutation that turns a proven export into a group", async () => {
    // `exports.daily = { … }` after the proven declaration. The compile
    // preserves it and the loader discovers `daily-submitBugReport`.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export const daily = onSchedule('every day 00:00', () => {});",
        "Object.assign(exports, { daily: { submitBugReport: onSchedule('every day 00:00', () => {}) } });",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses a reassignable binding that is overwritten with a group", async () => {
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export let daily: unknown = onSchedule('every day 00:00', () => {});",
        "daily = { submitBugReport: onSchedule('every day 00:00', () => {}) };",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("exempts a reassignable binding that is never reassigned", async () => {
    // Discriminates the case above: `let` is not itself the hazard, the
    // overwrite is, and only the artifact can tell them apart.
    await withFunctionsSource(
      [BUILDER_IMPORT, "export let daily = onSchedule('every day 00:00', () => {});"].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });
});

describe("the artifact decides even when no hook rebuilds it", RUNS_A_BUILD, () => {
  /**
   * No predeploy at all: whatever `main` already points at is exactly what
   * Firebase loads, so the artifact is inventoried as it stands.
   */
  const withPrewrittenArtifact = (body, run, extra = {}) =>
    withFunctionsProject(
      {
        functionsConfig: { predeploy: [], ...extra.functionsConfig },
        files: { "functions/lib/index.js": artifact(body), ...extra.files },
      },
      run,
    );

  it("exempts an unbuilt codebase whose artifact really is one endpoint", async () => {
    await withPrewrittenArtifact("exports.daily = endpoint();", async (configPath) => {
      expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
    });
  });

  it("refuses an unbuilt codebase whose artifact exports a group", async () => {
    // The old guard refused every hookless config on principle. The question
    // was never whether a hook ran; it is what `main` exports.
    await withPrewrittenArtifact(
      "exports.daily = { submitBugReport: endpoint() };",
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses when another deployed id falls inside the selector's prefix", async () => {
    // The CLI matches `id === prefix || id.startsWith(prefix + "-")`, so
    // `daily-submitBugReport` is inside `--only functions:daily`.
    await withPrewrittenArtifact(
      ['exports.daily = endpoint();', 'exports["daily-submitBugReport"] = endpoint();'].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("exempts a prefix-sharing export that is not an endpoint at all", async () => {
    // Discriminates the prefix rule from the NAME: a `daily-…` property that
    // the loader never turns into an endpoint is not deployed, so it cannot
    // widen the selector.
    await withPrewrittenArtifact(
      ['exports.daily = endpoint();', 'exports["daily-submitBugReport"] = 1;'].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("refuses when a discovery manifest supplies the deployed surface", async () => {
    // Codex P1 (round 9): the Node delegate tries `functions.yaml` BEFORE
    // loading the artifact, so the manifest — not `main` — decides what
    // `--only functions:daily` matches.
    await withPrewrittenArtifact(
      "exports.daily = endpoint();",
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
      {
        files: {
          "functions/functions.yaml": [
            "specVersion: v1alpha1",
            "endpoints:",
            "  daily-submitBugReport:",
            "    entryPoint: daily.submitBugReport",
          ].join("\n"),
        },
      },
    );
  });

  it("refuses an artifact that throws while loading", async () => {
    await withPrewrittenArtifact(
      'throw new Error("entrypoint blew up");',
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses when `main` points at an artifact that does not exist", async () => {
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        pkg: { ...DEFAULT_PACKAGE, main: "dist/server.js" },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });
});

describe("fail-closed: shapes the source pre-check refuses without building", RUNS_A_BUILD, () => {
  it("refuses a require() group, whose initializer is also a CallExpression", async () => {
    // The exact hazard: `exports.metrics = require('./metrics')` deploys as
    // `--only functions:metrics` and may contain a protected callable. It is a
    // call, so an initializer-is-a-call test alone would wrongly exempt it.
    await withFunctionsSource(
      [BUILDER_IMPORT, "export const metrics = require('./metrics');"].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:metrics"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses an object-literal group", async () => {
    await withFunctionsSource(
      [BUILDER_IMPORT, "const a = 1; const b = 2;", "export const metrics = { a, b };"].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:metrics"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a builder-shaped call whose callee is not a firebase-functions import", async () => {
    // Same syntax as a real endpoint, but `onSchedule` here is local. Trusting
    // the NAME rather than the import would spend a build on every factory.
    await withFunctionsSource(
      ["const onSchedule = (fn) => fn;", "export const daily = onSchedule(() => {});"].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses when a configured entrypoint cannot be read", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-missing-"));
    try {
      await mkdir(resolve(fixture, "functions"), { recursive: true });
      await writeUnder(
        fixture,
        "firebase.json",
        JSON.stringify({ functions: { source: "functions", predeploy: PREDEPLOY } }),
      );
      // No src/index.ts: "unreadable" must not degrade to "exports nothing".
      const result = await classify(
        ["--only", "functions:daily"],
        resolve(fixture, "firebase.json"),
      );
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("does not let a type-only import supply a builder name", async () => {
    await withFunctionsSource(
      [
        "import type { onSchedule } from 'firebase-functions/v2/scheduler';",
        "export const daily = onSchedule('every day 00:00', () => {});",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a builder imported from a package that merely starts with firebase-functions", async () => {
    // `firebase-functions-wrapper` is a different package; its factory may
    // return an object the runtime loader discovers as a group.
    await withFunctionsSource(
      [
        "import { onSchedule } from 'firebase-functions-wrapper';",
        "export const daily = onSchedule('every day 00:00', () => {});",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a non-builder export of an endpoint module", async () => {
    await withFunctionsSource(
      [
        "import { HttpsError } from 'firebase-functions/v2/https';",
        "export const daily = HttpsError('internal', 'x');",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });
});

describe("codebase precedence and per-codebase keying", RUNS_A_BUILD, () => {
  it("refuses a selector naming a configured codebase, even when an endpoint shares the name", async () => {
    // firebase-tools' parseFunctionSelector gives a configured codebase name
    // precedence over any endpoint id, and a filter with no second fragment
    // carries no idChunks — so endpointMatchesFilter admits EVERY endpoint in
    // that codebase, including protected callables. Reading it as the
    // same-named single endpoint would release them with no reconciliation.
    await withCodebases(
      {
        api: [
          BUILDER_IMPORT,
          "export const api = onSchedule('every day 00:00', () => {});",
          "export const alsoHere = onSchedule('every day 00:00', () => {});",
        ].join("\n"),
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:api"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("applies codebase precedence before the protected-name branches", async () => {
    // A configured codebase named `submitBugReport` makes
    // `--only functions:submitBugReport` deploy that codebase's WHOLE surface
    // (here it also carries a handoff callable), not the one protected endpoint
    // the name suggests. The explicit endpoint branch must not see it first,
    // or the other invokers stay unselected while their services are released.
    await withCodebases(
      {
        submitBugReport: [
          BUILDER_IMPORT,
          "export const submitBugReport = onSchedule('every day 00:00', () => {});",
          "export const mintAuthHandoff = onSchedule('every day 00:00', () => {});",
        ].join("\n"),
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:submitBugReport"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
    // Control: with no such codebase the same selector is still the one
    // protected endpoint, selecting only its own invoker, non-conservatively.
    await withCodebases({ default: endpoint("unrelated") }, async (configPath) => {
      const result = await classify(["--only", "functions:submitBugReport"], configPath);
      expect(result).toMatchObject({
        bugReportInvokerSelected: true,
        bugReportInvokerConservative: false,
        authHandoffInvokerSelected: false,
        emailUnsubscribeInvokerSelected: false,
      });
    });
  });

  it("does not let one codebase's export vouch for another codebase's selector", async () => {
    // `endpointMatchesFilter` rejects an endpoint whose codebase differs from
    // the filter's, so a union across codebases would be unsound.
    await withCodebases(
      { alpha: endpoint("alphaOnly"), beta: endpoint("betaOnly") },
      async (configPath) => {
        const result = await classify(["--only", "functions:alpha:betaOnly"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("exempts a codebase-qualified endpoint proven in that same codebase", async () => {
    await withCodebases(
      { alpha: endpoint("alphaOnly"), beta: endpoint("betaOnly") },
      async (configPath) => {
        const result = await classify(["--only", "functions:alpha:alphaOnly"], configPath);
        expect(result).toMatchObject(EXEMPT);
      },
    );
  });

  it("refuses an unqualified name no default codebase claims", async () => {
    // Unqualified selectors resolve to DEFAULT_CODEBASE, so a project whose
    // codebases are all named cannot vouch for one.
    await withCodebases(
      {
        alpha: endpoint("shared"),
        beta: [BUILDER_IMPORT, "export const shared = require('./shared');"].join("\n"),
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:shared"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a qualified selector whose codebase is not configured", async () => {
    await withCodebases({ alpha: endpoint("alphaOnly") }, async (configPath) => {
      const result = await classify(["--only", "functions:ghost:alphaOnly"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });

  it("refuses a hyphenated selector, which Firebase treats as an id prefix", async () => {
    // idChunks split on `-` and match `id === prefix || id.startsWith(prefix + '-')`,
    // so a hyphenated selector is a prefix filter rather than one endpoint.
    await withCodebases({ default: endpoint("daily") }, async (configPath) => {
      const result = await classify(["--only", "functions:daily-extra"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });
});

describe("selector resolution mirrors the pinned firebase-tools parser", RUNS_A_BUILD, () => {
  it("does not let a remoteSource codebase be read as a same-named local endpoint", async () => {
    // projectConfig accepts `remoteSource` as an alternative to `source`, and
    // such a config still carries a codebase. Dropping its NAME would let
    // codebase precedence be missed and release its whole surface — protected
    // callables included — with every invoker flag false (Codex P2, round 2).
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-remote-"));
    try {
      const dir = resolve(fixture, "functions-default");
      await mkdir(resolve(dir, "src"), { recursive: true });
      await installToolchain(dir);
      await writeUnder(dir, "package.json", JSON.stringify(DEFAULT_PACKAGE));
      await writeUnder(dir, "tsconfig.json", JSON.stringify(DEFAULT_TSCONFIG));
      await writeUnder(dir, "src/index.ts", endpoint("api"));
      await writeUnder(
        fixture,
        "firebase.json",
        JSON.stringify({
          functions: [
            { source: "functions-default", predeploy: PREDEPLOY },
            { codebase: "api", remoteSource: { repository: "r", ref: "main" } },
          ],
        }),
      );
      const result = await classify(
        ["--only", "functions:api"],
        resolve(fixture, "firebase.json"),
      );
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("does not let another codebase veto an unqualified default-codebase proof", async () => {
    // `fragments.length < 2` resolves to DEFAULT_CODEBASE, so a non-endpoint of
    // the same name in `beta` is unreachable and must not force conservatism.
    await withCodebases(
      {
        default: endpoint("shared"),
        beta: [BUILDER_IMPORT, "export const shared = require('./shared');"].join("\n"),
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:shared"], configPath);
        expect(result).toMatchObject(EXEMPT);
      },
    );
  });

  it("does not let one codebase's unreadable source poison a qualified proof in another", async () => {
    // endpointMatchesFilter rejects a codebase mismatch before comparing ids,
    // so uncertainty in `beta` cannot widen an explicitly qualified `alpha`.
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-authority-"));
    try {
      const alpha = resolve(fixture, "functions-alpha");
      await mkdir(resolve(alpha, "src"), { recursive: true });
      await installToolchain(alpha);
      await writeUnder(alpha, "package.json", JSON.stringify(DEFAULT_PACKAGE));
      await writeUnder(alpha, "tsconfig.json", JSON.stringify(DEFAULT_TSCONFIG));
      await writeUnder(alpha, "src/index.ts", endpoint("alphaOnly"));
      await mkdir(resolve(fixture, "functions-beta"), { recursive: true }); // no src/index.ts
      await writeUnder(
        fixture,
        "firebase.json",
        JSON.stringify({
          functions: [
            { source: "functions-alpha", codebase: "alpha", predeploy: PREDEPLOY },
            { source: "functions-beta", codebase: "beta", predeploy: PREDEPLOY },
          ],
        }),
      );
      const result = await classify(
        ["--only", "functions:alpha:alphaOnly"],
        resolve(fixture, "firebase.json"),
      );
      expect(result).toMatchObject(EXEMPT);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("allows a hyphenated CODEBASE while still refusing a hyphenated endpoint id", async () => {
    // validateCodebase permits [a-z0-9_-]+, and the parser splits the codebase
    // off before applying idChunks, so the hyphen rule belongs to the id alone.
    await withCodebases({ "my-codebase": endpoint("daily") }, async (configPath) => {
      const ok = await classify(["--only", "functions:my-codebase:daily"], configPath);
      expect(ok).toMatchObject(EXEMPT);

      const prefixed = await classify(["--only", "functions:my-codebase:daily-extra"], configPath);
      expect(prefixed).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });
});

describe("configs whose deployed surface this classifier cannot reproduce", RUNS_A_BUILD, () => {
  it("refuses a non-Node runtime even when decoy TypeScript is present", async () => {
    // The CLI picks its runtime delegate from the configured runtime, so a
    // python codebase's endpoints never come from the Node artifact built here.
    await withFunctionsProject(
      { functionsConfig: { runtime: "python311" } },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("accepts an explicitly declared Node runtime", async () => {
    await withFunctionsProject(
      { functionsConfig: { runtime: "nodejs22" } },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("refuses a codebase configured with a prefix", async () => {
    // A `prefix` rewrites deployed ids to `<prefix>-<name>`, so an inventory of
    // the artifact's own export ids no longer describes what a selector matches.
    await withFunctionsProject({ functionsConfig: { prefix: "daily" } }, async (configPath) => {
      expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
        ALL_INVOKERS_CONSERVATIVE,
      );
    });
  });

  it("refuses a kit codebase, whose endpoints come from somewhere unbuildable", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-kit-"));
    try {
      await writeUnder(
        fixture,
        "firebase.json",
        JSON.stringify({ functions: { kit: "some-kit", instances: { daily: {} } } }),
      );
      const result = await classify(
        ["--only", "functions:daily"],
        resolve(fixture, "firebase.json"),
      );
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ["an absolute source path", "/tmp/functions"],
    ["a source path outside the project", "../functions"],
  ])("refuses %s, which cannot be staged for a build", async (_label, source) => {
    await withFunctionsProject({ functionsConfig: { source } }, async (configPath) => {
      expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
        ALL_INVOKERS_CONSERVATIVE,
      );
    });
  });

  it("refuses a predeploy hook containing a backslash", async () => {
    // firebase-tools wraps a hook by escaping only `"`, which a backslash can
    // defeat. Rather than quote it some other way — and so run a command the
    // deploy will not — such a hook is refused.
    await withFunctionsProject(
      { functionsConfig: { predeploy: ['npm --prefix "$RESOURCE_DIR" run build \\'] } },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it.each([["./functions"], ["functions/"]])(
    "accepts the equivalent source spelling %s",
    async (source) => {
      // `./functions`, `functions/` and `functions` are one directory. The
      // staged copy has to land at the same project-relative path either way.
      await withFunctionsProject({ functionsConfig: { source } }, async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      });
    },
  );
});
