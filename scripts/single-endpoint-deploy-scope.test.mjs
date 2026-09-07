// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LiveCheckoutDriftError,
  RepositoryMetadataDriftError,
  classifyFirebaseDeployRequest,
  pinnedRewriteWidening,
  targetCodebases,
  classifyInvokerScope,
} from "./validate-firebase-deploy-filters.mjs";

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
// asking that codebase's own SDK what it deploys, so a fixture is a real (tiny)
// Functions package: this repository's `functions/node_modules` symlinked in
// (the real SDK, its discovery binary, and `tsc`), and whatever package.json /
// tsconfig / predeploy shape the case is about. Nothing reaches the network.
// ---------------------------------------------------------------------------

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

const SHARED_MODULES = join(repoRoot, "functions", "node_modules");

/**
 * Make sure the tree the fixtures borrow exists.
 *
 * `npm test` can run before anything has installed the Functions
 * dependencies — on a clean runner `app-ci` installs them later, for
 * `test:functions`, which begins with this very command. Doing it here is the
 * same install a few minutes earlier, and a no-op once it has happened, rather
 * than a reason to skip the suite that proves the classifier's central claim.
 */
async function ensureFunctionsDependencies() {
  if (existsSync(SHARED_MODULES)) return;
  await new Promise((settle, fail) => {
    const install = spawn(
      "npm",
      ["--prefix", "functions", "install", "--no-audit", "--no-fund", "--prefer-offline"],
      { cwd: repoRoot, stdio: "ignore" },
    );
    install.on("error", fail);
    install.on("exit", (code) =>
      code === 0 ? settle() : fail(new Error(`npm --prefix functions install exited ${code}`)),
    );
  });
}

/**
 * A `node_modules` for one fixture codebase: every entry of this repository's
 * own `functions/node_modules`, symlinked.
 *
 * That is the REAL Firebase Functions SDK — its `.bin/firebase-functions`
 * discovery binary, its `v2` provider subpaths, its `onInit`, its types — plus
 * `tsc` and `@types/node`. Fixtures used to ship a hand-written stub SDK, which
 * meant the tests exercised a mock of the very thing under test; the classifier
 * now drives the SDK's own discovery program, so the fixtures must too.
 *
 * Symlinks, not copies: 209 entries per fixture is a few milliseconds, where
 * copying the tree would be minutes.
 */
async function installToolchain(functionsDir) {
  const modules = resolve(functionsDir, "node_modules");
  await mkdir(modules, { recursive: true });
  for (const entry of await readdir(SHARED_MODULES)) {
    await symlink(join(SHARED_MODULES, entry), resolve(modules, entry));
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
    // What `extractStack` looks for, carrying the minimum `stackToWire` needs:
    // a function whose `__endpoint` is an object.
    '  e.__endpoint = { platform: "gcfv2", entryPoint: "handler" };',
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
 *   config?: object,            // merged into firebase.json itself (other targets)
 *   files?: Record<string, string>, // extra files, relative to the fixture root
 *   links?: Record<string, string>, // symlinks (path -> target), fixture-relative
 *   branch?: string,            // make the fixture a git repo on this branch
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
    for (const [link, target] of Object.entries(spec.links ?? {})) {
      const at = resolve(fixture, link);
      await mkdir(dirname(at), { recursive: true });
      await symlink(target, at);
    }
    await writeUnder(
      fixture,
      "firebase.json",
      JSON.stringify({
        functions: { source: "functions", predeploy: PREDEPLOY, ...spec.functionsConfig },
        ...spec.config,
      }),
    );
    if (spec.branch) await initFixtureRepository(fixture, spec.branch);
    await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

/** The shorthand most fail-closed cases need: only `src/index.ts` varies. */
const withFunctionsSource = (source, run) => withFunctionsProject({ source }, run);

/**
 * Make a fixture a real git repository on a named branch.
 *
 * An EMPTY commit, deliberately: `git rev-parse --abbrev-ref HEAD` needs a born
 * branch to answer, and committing the fixture's borrowed `node_modules` links
 * would cost more than everything else the fixture does.
 */
async function initFixtureRepository(dir, branch) {
  const git = (args) =>
    new Promise((settle, fail) => {
      const child = spawn("git", args, { cwd: dir, stdio: "ignore" });
      child.on("error", fail);
      child.on("exit", (code) =>
        code === 0 ? settle() : fail(new Error(`git ${args.join(" ")} exited ${code}`)),
      );
    });
  await git(["init", "--quiet", "-b", branch]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
}

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

/**
 * A project with a default codebase plus one named codebase whose predeploy
 * hook is under the test's control.
 *
 * The point is `getReleventConfigs`: an `--only functions:<endpoint>` scope
 * names no configured codebase, so NO target matches and the CLI reverts to
 * running EVERY Functions config's hooks. The second codebase's hook therefore
 * runs even though the scope never mentions it.
 */
async function withNeighbourCodebase(
  { neighbourPredeploy, neighbourSource, defaultSource, neighbourFirst = false, files = {} },
  run,
) {
  const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-neighbour-"));
  try {
    for (const [dir, source] of [
      ["functions-default", defaultSource ?? endpoint("daily")],
      ["functions-beta", neighbourSource ?? endpoint("betaOnly")],
    ]) {
      const codebaseDir = resolve(fixture, dir);
      await mkdir(resolve(codebaseDir, "src"), { recursive: true });
      await installToolchain(codebaseDir);
      await writeUnder(codebaseDir, "package.json", JSON.stringify(DEFAULT_PACKAGE));
      await writeUnder(codebaseDir, "tsconfig.json", JSON.stringify(DEFAULT_TSCONFIG));
      await writeUnder(codebaseDir, "src/index.ts", source);
    }
    for (const [file, contents] of Object.entries(files)) {
      await writeUnder(fixture, file, contents);
    }
    const configs = [
      { source: "functions-default", predeploy: PREDEPLOY },
      { source: "functions-beta", codebase: "beta", predeploy: neighbourPredeploy },
    ];
    await writeUnder(
      fixture,
      "firebase.json",
      // Config ORDER is load-bearing: hooks and discovery both run in it, so a
      // neighbour that must act BEFORE the selected codebase is read has to be
      // declared first.
      JSON.stringify({ functions: neighbourFirst ? [configs[1], configs[0]] : configs }),
    );
    await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

/** Run `body` with `vars` in this process's environment, then put it back. */
async function withEnv(vars, body) {
  const previous = Object.keys(vars).map((key) => [key, process.env[key]]);
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The classifier as `deploy.sh` actually invokes it: a child process configured
 * entirely through the environment, answering in shell-assignment format.
 *
 * The in-process `classify()` helper cannot see this path at all — `main()`,
 * and the environment it reads, are the production wrapper.
 */
function runClassifierWrapper(configPath, args, extraEnv) {
  return new Promise((settle, fail) => {
    const child = spawn(
      process.execPath,
      [resolve(repoRoot, "scripts", "validate-firebase-deploy-filters.mjs"), "--", ...args],
      { cwd: dirname(configPath), env: { ...process.env, ...extraEnv } },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", fail);
    child.on("exit", (code) => settle({ code, output }));
  });
}

/**
 * A codebase whose predeploy hook publishes a GROUP when it can see any of the
 * variables `deploy.sh` sets for the classifier alone, and the single endpoint
 * otherwise. The exemption is therefore the assertion that the hook saw none of
 * them.
 */
const ENV_SNIFFING_FIXTURE = {
  functionsConfig: {
    predeploy: [
      "test -n " +
        '"$FIREBASE_DEPLOY_DEFAULT_PROJECT$FIREBASE_DEPLOY_DEFAULT_CONFIG' +
        '$FIREBASE_DEPLOY_REJECT_OVERRIDES$FIREBASE_DEPLOY_CLASSIFIER_FORMAT" ' +
        "&& cp functions/group.js functions/lib/index.js " +
        "|| cp functions/single.js functions/lib/index.js",
    ],
  },
  files: {
    "functions/lib/index.js": artifact("exports.placeholder = 1;"),
    "functions/group.js": artifact("exports.daily = { submitBugReport: endpoint() };"),
    "functions/single.js": artifact("exports.daily = endpoint();"),
  },
};

/** The environment `deploy.sh` builds for the classifier and for nothing else. */
const DEPLOY_SH_CLASSIFIER_ENV = (configPath) => ({
  FIREBASE_DEPLOY_DEFAULT_PROJECT: "fiveacross",
  FIREBASE_DEPLOY_DEFAULT_CONFIG: configPath,
  FIREBASE_DEPLOY_REJECT_OVERRIDES: "true",
  FIREBASE_DEPLOY_CLASSIFIER_FORMAT: "shell",
});

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

// Installing the Functions dependencies on a cold runner is the slowest thing
// this file does, and every fixture needs them.
beforeAll(ensureFunctionsDependencies, 600_000);

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

  it("normalizes whitespace in the filter list exactly as the CLI does", async () => {
    // Codex P1, round 22: the pinned CLI splits `--only` on commas AND
    // whitespace, so a protected selector after ", " is released by Firebase;
    // iterating the raw comma chunks let it slip past classification.
    const result = await classify(["--only", "functions:dailyEngagementEmail, functions:submitBugReport"]);
    expect(result).toMatchObject({
      functionsAttempted: true,
      bugReportInvokerSelected: true,
      bugReportInvokerConservative: false,
      authHandoffInvokerSelected: false,
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

  it("refuses an onX SDK export that builds no endpoint", async () => {
    // `onInit(callback): void` matches the `onX` shape the source pre-check
    // admits, but really returns `undefined`, so the fallback below runs and
    // the artifact carries a group. The pre-check is allowed to over-admit
    // precisely because the artifact answers (Codex P2, round 11).
    await withFunctionsSource(
      [
        "import { onInit } from 'firebase-functions';",
        BUILDER_IMPORT,
        "export let daily: any = onInit(() => {});",
        "if (!daily) daily = { submitBugReport: onSchedule('every day 00:00', () => {}) };",
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

  it("refuses a near-extension the loader would recurse into", async () => {
    // The loader treats a value as an extension only when `events` is absent or
    // an array; with a truthy non-array `events` it recurses instead and finds
    // what is inside. Skipping such an object would hide `daily-hidden-…`.
    await withPrewrittenArtifact(
      [
        "exports.daily = endpoint();",
        'exports["daily-hidden"] = {',
        '  instanceId: "looks-like-an-extension",',
        "  params: {},",
        '  FIREBASE_EXTENSION_REFERENCE: "firebase/x@1.0.0",',
        '  events: "not-an-array",',
        "  submitBugReport: endpoint(),",
        "};",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("skips a real extension descriptor without recursing into it", async () => {
    // Discriminates the clause above from "never skip anything": a descriptor
    // whose `events` IS an array is an extension, the loader does not walk it,
    // and its contents are not deployed endpoints.
    await withPrewrittenArtifact(
      [
        "exports.daily = endpoint();",
        'exports["daily-hidden"] = {',
        '  instanceId: "a-real-extension",',
        "  params: {},",
        '  FIREBASE_EXTENSION_REFERENCE: "firebase/x@1.0.0",',
        "  events: [],",
        "  submitBugReport: endpoint(),",
        "};",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("refuses an artifact whose optional dependency is absent", async () => {
    // A missing module must PROPAGATE, not become an inert stub: an entrypoint
    // that catches an absent optional dependency takes its `catch` branch under
    // the real loader, and may export a group from there. Stubbing the import
    // would keep it on the `try` branch and invent a smaller surface.
    await withPrewrittenArtifact(
      [
        "try {",
        '  require("an-optional-dependency-that-is-not-installed");',
        "  exports.daily = endpoint();",
        "} catch {",
        "  exports.daily = { submitBugReport: endpoint() };",
        "}",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it.each([
    ["a direct read", 'exports.daily = config.storageBucket ? { submitBugReport: endpoint() } : endpoint();'],
    ["a membership test", 'exports.daily = "storageBucket" in config ? { submitBugReport: endpoint() } : endpoint();'],
    ["an own-property test", 'exports.daily = Object.hasOwn(config, "storageBucket") ? { submitBugReport: endpoint() } : endpoint();'],
    ["enumeration", 'exports.daily = Object.keys(config).length > 1 ? { submitBugReport: endpoint() } : endpoint();'],
  ])(
    "refuses an artifact that branches on FIREBASE_CONFIG by %s",
    async (_label, branch) => {
      // `prepare.js` hands discovery the project's adminSdkConfig, which needs
      // an authenticated lookup a local preflight must not make. Reading
      // `projectId` is fine — it is known — but any way of asking about a field
      // this classifier could not supply means the real value might have
      // selected a different surface. Membership, descriptor and enumeration
      // discriminate just as well as a read (Codex P2, round 11).
      await withPrewrittenArtifact(
        ['const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}");', branch].join("\n"),
        async (configPath) => {
          expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
            ALL_INVOKERS_CONSERVATIVE,
          );
        },
      );
    },
  );

  it("exempts an artifact that reads only the project id from FIREBASE_CONFIG", async () => {
    // Discriminates the rule above from "any FIREBASE_CONFIG access forfeits",
    // which would refuse this repository's own Functions index.
    await withPrewrittenArtifact(
      [
        'const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}");',
        "exports.daily = endpoint();",
        "exports.daily.__endpoint.project = config.projectId;",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("refuses an artifact that reads the legacy runtime config at all", async () => {
    // The differential probe cannot cover CLOUD_RUNTIME_CONFIG: its
    // `functions.config()` namespaces are user-chosen, so a branch on
    // `runtime.someLegacyNamespace` reads `undefined` under BOTH probes while
    // the real value could be anything. Reading the variable is therefore
    // all-or-nothing — which costs nothing in practice, since its only consumer
    // is the deprecated v1 API.
    await withPrewrittenArtifact(
      [
        'const runtime = JSON.parse(process.env.CLOUD_RUNTIME_CONFIG || "{}");',
        "exports.daily = runtime.someLegacyNamespace ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an artifact that inspects the raw FIREBASE_CONFIG string", async () => {
    // The differential probe covers every ACCESS FORM at once, string
    // inspection included, because the two probes' serialized values differ
    // (Codex P2, round 12). Nothing here parses the value.
    await withPrewrittenArtifact(
      [
        'const raw = process.env.FIREBASE_CONFIG || "";',
        'exports.daily = raw.includes("storageBucket") ? { submitBugReport: endpoint() } : endpoint();',
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an artifact whose branch reads a real dependency's value", async () => {
    // Nothing is stubbed, so a branch on a dependency's actual value behaves as
    // it will at deploy time. A stub that answered `.length` with something
    // truthy would take the other branch and miss the nested callable
    // (Codex P2, round 11).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/node_modules/an-installed-package/package.json": JSON.stringify({
            name: "an-installed-package",
            version: "0.0.0",
            main: "index.js",
          }),
          "functions/node_modules/an-installed-package/index.js": "exports.apps = [];\n",
          "functions/lib/index.js": artifact(
            [
              'const pkg = require("an-installed-package");',
              "exports.daily = pkg.apps.length === 0 ? { submitBugReport: endpoint() } : endpoint();",
            ].join("\n"),
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses even when the artifact tries to erase the evidence", async () => {
    // The verdict used to be a marker FILE whose path had to be in the
    // environment for the preload to find it — which put it within reach of the
    // code being watched. It now travels over a descriptor the parent holds, so
    // there is nothing on disk to unlink and no env var naming one
    // (Codex P2, round 16).
    await withPrewrittenArtifact(
      [
        'const fs = require("node:fs");',
        "for (const [name, value] of Object.entries(process.env)) {",
        '  if (!/MARKER|WATCH/.test(name)) continue;',
        "  try { fs.unlinkSync(value); } catch {}",
        "  delete process.env[name];",
        "}",
        'const runtime = JSON.parse(process.env.CLOUD_RUNTIME_CONFIG || "{}");',
        "exports.daily = runtime.someLegacyNamespace ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an artifact that reads the runtime config through its descriptor", async () => {
    // A descriptor read hands the value over as well as a plain `get` does
    // (Codex P2, round 13), so the env watcher traps that form too.
    await withPrewrittenArtifact(
      [
        'const d = Object.getOwnPropertyDescriptor(process.env, "CLOUD_RUNTIME_CONFIG");',
        'const runtime = JSON.parse((d && d.value) || "{}");',
        "exports.daily = runtime.someLegacyNamespace ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("sees an export mutation queued in a resolved promise", async () => {
    // `loadStack` awaits an async `loadModule` before calling `extractStack`,
    // so a microtask-queued mutation has already run when the deploy walks the
    // exports. Walking synchronously would report the pre-mutation surface
    // (Codex P2, round 13).
    await withPrewrittenArtifact(
      [
        "exports.daily = endpoint();",
        "Promise.resolve().then(() => { exports.daily = { submitBugReport: endpoint() }; });",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an artifact that tries to write its own answer", async () => {
    // An earlier revision walked the exports in a script of its own, whose
    // report the artifact could forge by replacing `fs.writeFileSync` in the
    // process they shared (Codex P2, round 13). The inventory now comes from
    // the SDK's own discovery response, which the artifact has no channel to,
    // so the grouped surface is what gets reported.
    await withPrewrittenArtifact(
      [
        'const fs = require("node:fs");',
        "const real = fs.writeFileSync;",
        'fs.writeFileSync = (file, data) => real.call(fs, file, "ok\\n\\nendpoints\\ndaily\\ngroups\\n");',
        "exports.daily = { submitBugReport: endpoint() };",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an artifact that branches on the discovery PORT", async () => {
    // The default discovery path serves on a PORT (`serveAdmin`), so an
    // environment without one is not the environment Firebase discovers under
    // (Codex P2, round 13).
    await withPrewrittenArtifact(
      "exports.daily = process.env.PORT ? { submitBugReport: endpoint() } : endpoint();",
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
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

  it("refuses when another codebase's hook overwrites the selected artifact", async () => {
    // `getReleventConfigs` matches `--only functions:<x>` against CODEBASE
    // names; `daily` is an endpoint id, so nothing matches and the CLI runs
    // EVERY config's hooks. Running only the selected codebase's would miss
    // this entirely (Codex P2, round 11).
    await withNeighbourCodebase(
      {
        neighbourPredeploy: [
          ...PREDEPLOY,
          "cp functions-beta/group.js functions-default/lib/index.js",
        ],
        files: {
          "functions-beta/group.js": artifact("exports.daily = { submitBugReport: endpoint() };"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("does not load a codebase this deploy will not discover", async () => {
    // `getReleventConfigs` runs every config's HOOKS for an endpoint-named
    // scope, but `loadCodebases` still discovers only the codebases the filters
    // name (`targetCodebases`). Loading one Firebase will not load runs its
    // module-scope code, and here that code rewrites the SELECTED codebase's
    // artifact into a group — so a classifier that loaded it would answer a
    // question the deploy never asks (Codex P2, round 14).
    await withNeighbourCodebase(
      {
        neighbourPredeploy: PREDEPLOY,
        // Declared FIRST, so a load of it would land before the selected
        // codebase is read — which is what makes this fixture discriminating.
        neighbourFirst: true,
        neighbourSource: [
          "import { onSchedule } from 'firebase-functions/v2/scheduler';",
          "import { copyFileSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          "const project = resolve(__dirname, '..', '..');",
          "copyFileSync(",
          "  resolve(project, 'group.js'),",
          "  resolve(project, 'functions-default', 'lib', 'index.js'),",
          ");",
          "export const betaOnly = onSchedule('every day 00:00', () => {});",
        ].join("\n"),
        files: { "group.js": artifact("exports.daily = { submitBugReport: endpoint() };") },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("exempts when the neighbouring codebase's hook leaves the artifact alone", async () => {
    // Discriminates the case above from "any second codebase forfeits": the
    // neighbour's hook still runs, it just does not change the answer.
    await withNeighbourCodebase({ neighbourPredeploy: PREDEPLOY }, async (configPath) => {
      expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
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

  it("kills a timed-out hook's whole process tree instead of waiting on it", async () => {
    // `spawn`'s own `timeout` signals only the immediate shell, and this hook
    // reaches the sleep through cross-env-shell and a second shell — those
    // descendants keep the inherited stdio pipes open, so `close` waits on THEM
    // and the ceiling bounds nothing. Under a 250ms deadline the whole group
    // must die at once, and the classifier must answer conservatively long
    // before the sleep would have ended.
    //
    // The 3s bound discriminates the group kill from the belt-and-braces grace
    // timer behind it: killing only the shell still settles, but not until that
    // fallback fires seconds later.
    await withFunctionsProject(
      { functionsConfig: { predeploy: ["sleep 30"] } },
      async (configPath) => {
        const started = Date.now();
        const result = await classifyFirebaseDeployRequest(
          ["fiveacross", "--only", "functions:daily"],
          { defaultConfigPath: configPath, predeployTimeoutMs: 250 },
        );
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
        expect(Date.now() - started).toBeLessThan(3_000);
      },
    );
  });

  it("reads dotenv files from a configured configDir, not from the source dir", async () => {
    // `resolveConfigDir` is `configDir || source`, so a codebase that sets one
    // keeps its `.env` files there. Scanning the source dir instead would miss
    // a flag that decides the deployed surface (Codex P2, round 12).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [], configDir: "env" },
        files: {
          "env/.env": "GROUP_THE_ENDPOINT=1\n",
          "functions/lib/index.js": artifact(
            "exports.daily = process.env.GROUP_THE_ENDPOINT ? { submitBugReport: endpoint() } : endpoint();",
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("exempts the same codebase when its configDir carries no such flag", async () => {
    // Discriminates the case above from "a configDir forfeits": the directory
    // is read either way, it just says nothing that changes the surface.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [], configDir: "env" },
        files: {
          "env/.env": "SOMETHING_ELSE=1\n",
          "functions/lib/index.js": artifact(
            "exports.daily = process.env.GROUP_THE_ENDPOINT ? { submitBugReport: endpoint() } : endpoint();",
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("relinks a nested node_modules so it does not resolve to the outer one", async () => {
    // The copy skips `node_modules` at every depth; relinking only the source
    // root's would let a nested package resolve an OUTER version of its
    // dependency, and a different version can export a different surface
    // (Codex P2, round 13). Here only the nested copy exports the group.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/node_modules/shared/package.json": JSON.stringify({
            name: "shared",
            version: "1.0.0",
            main: "index.js",
          }),
          "functions/node_modules/shared/index.js": "exports.grouped = false;\n",
          "functions/nested/node_modules/shared/package.json": JSON.stringify({
            name: "shared",
            version: "2.0.0",
            main: "index.js",
          }),
          "functions/nested/node_modules/shared/index.js": "exports.grouped = true;\n",
          "functions/nested/decide.js": 'module.exports = require("shared").grouped;\n',
          "functions/lib/index.js": artifact(
            [
              'const grouped = require("../nested/decide.js");',
              "exports.daily = grouped ? { submitBugReport: endpoint() } : endpoint();",
            ].join("\n"),
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses overlapping Functions source directories", async () => {
    // A nested source would share the outer's `node_modules` in the staged
    // copy and resolve its dependencies from the wrong package. Refuse rather
    // than get it subtly wrong (Codex P2, round 12).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/lib/index.js": artifact("exports.daily = endpoint();"),
          "functions/sub/package.json": JSON.stringify({ name: "nested", main: "index.js" }),
          "functions/sub/index.js": "exports.other = 1;\n",
        },
      },
      async (configPath) => {
        // Re-read the config with a second, nested codebase declared.
        const withNested = JSON.parse(await readFile(configPath, "utf8"));
        withNested.functions = [
          withNested.functions,
          { source: "functions/sub", codebase: "nested", predeploy: [] },
        ];
        await writeFile(configPath, JSON.stringify(withNested), "utf8");
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("inventories the artifact the hook left when its shell exited", async () => {
    // `runCommand` settles on `exit`, so Firebase starts discovery as soon as
    // the immediate shell is done and never waits for a background descendant.
    // Waiting for `close` here would let the classifier see the LATER artifact
    // — a single endpoint — while the deploy discovers the group
    // (Codex P2, round 12).
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [
            "cp functions/group.js functions/lib/index.js && (sleep 5; cp functions/single.js functions/lib/index.js) &",
          ],
        },
        files: {
          "functions/lib/index.js": artifact("exports.placeholder = 1;"),
          "functions/group.js": artifact("exports.daily = { submitBugReport: endpoint() };"),
          "functions/single.js": artifact("exports.daily = endpoint();"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("leaves the live firebase.json alone when a hook overwrites it", async () => {
    // The overlay symlinks project directories but COPIES project files, so a
    // hook that rewrites a deployment input rewrites the scratch copy. A
    // symlinked `firebase.json` would be a route into the live checkout, after
    // the dirty-tree guard has already passed (Codex P2, round 15).
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, "cp swapped.json firebase.json"],
        },
        files: {
          "swapped.json": JSON.stringify({ functions: { source: "elsewhere" } }),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
        // The config the deploy is about to read is untouched.
        const live = JSON.parse(await readFile(configPath, "utf8"));
        expect(live.functions.source).toBe("functions");
      },
    );
  });

  it("refuses when the environment selects a discovery mode it cannot mirror", async () => {
    // `discoverBuild` switches to a one-shot manifest process when this is set,
    // which the pinned SDK binary does not even implement.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        // A perfectly exemptible codebase, so the env var is the ONLY reason
        // this can refuse.
        files: { "functions/lib/index.js": artifact("exports.daily = endpoint();") },
      },
      async (configPath) => {
      const previous = process.env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH;
      process.env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH = "true";
      try {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      } finally {
        if (previous === undefined) delete process.env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH;
        else process.env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH = previous;
      }
    },
    );
  });

  it("resolves a project alias before choosing dotenv files", async () => {
    // `--project <alias_or_project_id>`: an alias resolves through
    // `.firebaserc`, and `prepare.js` then hands `loadUserEnvs` both the real id
    // and the alias, so `.env.<projectId>` counts. Reading the alias as an id
    // would look for the wrong file and miss a flag that decides the surface
    // (Codex P2, round 16).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          ".firebaserc": JSON.stringify({ projects: { prod: "actual-project" } }),
          "functions/.env.actual-project": "GROUP_THE_ENDPOINT=1\n",
          "functions/lib/index.js": artifact(
            "exports.daily = process.env.GROUP_THE_ENDPOINT ? { submitBugReport: endpoint() } : endpoint();",
          ),
        },
      },
      async (configPath) => {
        const result = await classifyFirebaseDeployRequest(
          ["--project", "prod", "--only", "functions:daily"],
          { defaultConfigPath: configPath },
        );
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses an absolute configDir, which the overlay cannot place", async () => {
    // `Config.path` preserves an absolute `configDir`, so the deploy would read
    // dotenv files from a directory the scratch project does not contain.
    // Falling back to the source dir would read the wrong ones.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [], configDir: "/tmp/somewhere-else" },
        // Exemptible but for the configDir, so that is the only thing under
        // test here.
        files: { "functions/lib/index.js": artifact("exports.daily = endpoint();") },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("hides its own preload from the codebase", async () => {
    // The preload is loaded with `--require`, which node keeps out of
    // `process.argv` but leaves in `process.execArgv`. The real discovery
    // process has none, so the trace is removed before any codebase code runs
    // (Codex P2, round 15).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/lib/index.js": artifact(
            "exports.daily = process.execArgv.length ? { submitBugReport: endpoint() } : endpoint();",
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("leaves no trace of its discovery preload in the module system", async () => {
    // `process.execArgv` was only the first of three places `--require` shows
    // up. `require.cache` is one object shared with every module the artifact
    // loads, node keeps the raw preload list in `process._preload_modules`, and
    // the preloaded module is a child of an internal parent module whose
    // `children` array is reachable. An artifact that finds any of them can take
    // a branch the deploy's own unpreloaded discovery never takes (Codex P2,
    // round 17).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/lib/index.js": artifact(
            [
              "const traced =",
              '  Object.keys(require.cache).some((key) => key.includes("firebase-discovery-preload")) ||',
              "  (process._preload_modules || []).length > 0 ||",
              "  process.execArgv.length > 0;",
              "exports.daily = traced ? { submitBugReport: endpoint() } : endpoint();",
            ].join("\n"),
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("ABORTS when a hook writes through the overlay into the checkout", async () => {
    // Only the Functions sources are copied; every other project directory is a
    // symlink to the live tree, so a hook that writes a shared build input —
    // here a toggle whose second run differs from its first — mutates the real
    // checkout AFTER the dirty-tree guard has passed (Codex P2, round 17).
    //
    // Answering that with a conservative classification was still wrong: the
    // classification SUCCEEDS, so the build and the publish below it go ahead
    // and ship whatever the hook just wrote into tracked source (Codex P1,
    // round 18). Detected mutation is fatal, and it names the path.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [...PREDEPLOY, "printf x >> shared/toggle"] },
        files: { "shared/toggle": "" },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("shared/toggle");
        expect(failure.message).toContain("Nothing has been restored");
      },
    );
  });

  it("exits with the live-checkout-drift status through the production wrapper", async () => {
    // The status `deploy.sh` reads. It is distinct from the invalid-request
    // status precisely because the request was valid: it is the TREE that is no
    // longer the one the clean-tree guard approved.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [...PREDEPLOY, "printf x >> shared/toggle"] },
        files: { "shared/toggle": "" },
      },
      async (configPath) => {
        const run = await runClassifierWrapper(
          configPath,
          ["--only", "functions:daily"],
          DEPLOY_SH_CLASSIFIER_ENV(configPath),
        );
        expect(run.code).toBe(3);
        expect(run.output).toContain("mutated the live checkout");
        expect(run.output).toContain("shared/toggle");
        expect(run.output).toContain("NOTHING HAS BEEN BUILT OR PUBLISHED");
        // And no classification reached stdout for `deploy.sh` to parse.
        expect(run.output).not.toContain("FUNCTIONS_ATTEMPTED=");
      },
    );
  });

  it("still exempts when that same write lands inside the staged source dir", async () => {
    // The discriminator for the case above: the guard watches the live
    // boundary, not writing as such. A hook that writes into its own
    // `$RESOURCE_DIR` writes into the scratch copy, which is the whole point of
    // staging one.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [...PREDEPLOY, 'printf x >> "$RESOURCE_DIR/toggle"'] },
        files: { "functions/toggle": "" },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
        // And the live file the hook could have reached is untouched.
        expect(await readFile(resolve(dirname(configPath), "functions", "toggle"), "utf8")).toBe("");
      },
    );
  });

  it("ABORTS when LOADING the artifact writes into the checkout", async () => {
    // Module-scope code reaches the same symlinks a hook does, and it runs
    // after the hooks have already been cleared — so the live tree is checked
    // again once every codebase has been discovered, and that check is fatal
    // for the same reason the post-hook one is.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "shared/toggle": "",
          "functions/lib/index.js": artifact(
            [
              'const fs = require("node:fs");',
              'const path = require("node:path");',
              'fs.appendFileSync(path.join(__dirname, "..", "..", "shared", "toggle"), "x");',
              "exports.daily = endpoint();",
            ].join("\n"),
          ),
        },
      },
      async (configPath) => {
        await expect(classify(["--only", "functions:daily"], configPath)).rejects.toThrow(
          LiveCheckoutDriftError,
        );
      },
    );
  });

  it("keeps its own environment out of the predeploy hooks it runs", async () => {
    // `deploy.sh` passes the pinned project, config path, override policy and
    // output format to the classifier and to NOTHING else, so a hook run from
    // here would see variables its real run cannot (Codex P2, round 17).
    await withFunctionsProject(ENV_SNIFFING_FIXTURE, async (configPath) => {
      await withEnv(DEPLOY_SH_CLASSIFIER_ENV(configPath), async () => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      });
    });
  });

  it("keeps it out of the hooks the production wrapper runs too", async () => {
    // The same claim about the path that actually reads those variables:
    // `main()`, spawned the way `deploy.sh` spawns it.
    await withFunctionsProject(ENV_SNIFFING_FIXTURE, async (configPath) => {
      const run = await runClassifierWrapper(
        configPath,
        ["--only", "functions:daily"],
        DEPLOY_SH_CLASSIFIER_ENV(configPath),
      );
      expect(run.code).toBe(0);
      expect(run.output).toContain("FUNCTIONS_ATTEMPTED=true");
      expect(run.output).toContain("AUTH_HANDOFF_INVOKER_SELECTED=false");
      expect(run.output).toContain("BUG_REPORT_INVOKER_SELECTED=false");
    });
  });

  it("keeps its own environment out of the discovery processes", async () => {
    // Discovery's environment is built from `{}` rather than from
    // `process.env`, so nothing ambient reaches it. That is a property of the
    // code rather than of a list of names, and this pins it.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/lib/index.js": artifact(
            "exports.daily = process.env.FIREBASE_DEPLOY_CLASSIFIER_FORMAT" +
              " ? { submitBugReport: endpoint() }" +
              " : endpoint();",
          ),
        },
      },
      async (configPath) => {
        await withEnv(DEPLOY_SH_CLASSIFIER_ENV(configPath), async () => {
          expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
        });
      },
    );
  });

  it("does not let the two config probes agree with each other", async () => {
    // The probes used to run concurrently against ONE staged source dir, on the
    // reasoning that a load with side effects would make them disagree. But two
    // live peers can agree deliberately: this artifact appends a marker, waits
    // for a second one, and reports a single endpoint only when it finds a
    // peer — so a shared tree makes both probes say "one endpoint" while the
    // deploy's single fresh discovery gets the group (Codex P2, round 17).
    // Sequential probes from private copies leave nobody to wait for.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/lib/index.js": artifact(
            [
              'const fs = require("node:fs");',
              'const path = require("node:path");',
              'const log = path.join(__dirname, "..", "probe-log");',
              'fs.appendFileSync(log, "probe\\n");',
              "const wake = new Int32Array(new SharedArrayBuffer(4));",
              "const deadline = Date.now() + 2500;",
              "let peers = 0;",
              "while (Date.now() < deadline) {",
              '  peers = fs.readFileSync(log, "utf8").split("probe").length - 1;',
              "  if (peers > 1) break;",
              "  Atomics.wait(wake, 0, 0, 25);",
              "}",
              "exports.daily = peers > 1 ? endpoint() : { submitBugReport: endpoint() };",
            ].join("\n"),
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
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

describe("round-18 fresh evidence: the execution the deploy will actually run", RUNS_A_BUILD, () => {
  it("keeps a relative source symlink pointing inside the staged copy", async () => {
    // `fs.cp`'s default `verbatimSymlinks: false` REWRITES a copied link to
    // point at its original target, so this relative link came out of the copy
    // as an absolute link back into the developer's `functions/` — a directory
    // `liveDirs` does not watch, so the write was both real and invisible
    // (Codex P1, round 18). Copied verbatim, it resolves inside the copy.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, 'printf x >> "$RESOURCE_DIR/src/generated.txt"'],
        },
        files: { "functions/generated-target.txt": "" },
        links: { "functions/src/generated.txt": "../generated-target.txt" },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
        // The live file the hook wrote through is untouched.
        expect(
          await readFile(resolve(dirname(configPath), "functions", "generated-target.txt"), "utf8"),
        ).toBe("");
      },
    );
  });

  it("refuses a Functions source that links out of the staged project", async () => {
    // The other half of the same fix. A link the copy cannot reproduce INSIDE
    // the scratch project is a route to somewhere this classifier is not
    // watching, so it is refused rather than staged.
    await withFunctionsProject(
      {
        links: { "functions/src/escape.txt": "../../../escape.txt" },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses an artifact that reads the runtime config through functions.config()", async () => {
    // The watcher's own reason for existing, which it used to miss: the read
    // happens inside `firebase-functions/lib/v1/config.js`, so the nearest
    // stack frame is the SDK's and the codebase's is one line further down.
    // Both probes see `undefined` here and agree on one endpoint, while the
    // deploy's authenticated config can make it a group (Codex P2, round 18).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/lib/index.js": artifact(
            [
              'const functions = require("firebase-functions");',
              "exports.daily = functions.config().feature?.enabled",
              "  ? { grouped: endpoint() }",
              "  : endpoint();",
            ].join("\n"),
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("runs hooks under the production wrapper's own project variables", async () => {
    // `scripts/firebase/op-firebase-deploy` exports GOOGLE_CLOUD_PROJECT and
    // CLOUDSDK_BILLING_QUOTA_PROJECT before `firebase deploy`, and
    // `lifecycleHooks` hands a hook the wrapper's whole environment. Supplying
    // only GCLOUD_PROJECT let this hook build one endpoint here and a group
    // during the deploy (Codex P2, round 18).
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [
            'test "$GOOGLE_CLOUD_PROJECT/$CLOUDSDK_BILLING_QUOTA_PROJECT" = "fiveacross/fiveacross" ' +
              "&& cp functions/group.js functions/lib/index.js " +
              "|| cp functions/single.js functions/lib/index.js",
          ],
        },
        files: {
          "functions/lib/index.js": artifact("exports.placeholder = 1;"),
          "functions/group.js": artifact("exports.daily = { grouped: endpoint() };"),
          "functions/single.js": artifact("exports.daily = endpoint();"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("runs every selected target's predeploy hooks, not only the Functions ones", async () => {
    // `deploy/index.js` chains `lifecycleHooks(<target>, "predeploy")` for EVERY
    // selected target before it chains a single `prepare`, and `firestore`
    // precedes `functions` in VALID_DEPLOY_TARGETS. So a Firestore hook decides
    // the artifact this selector is measured against (Codex P2, round 18).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        config: {
          firestore: {
            rules: "firestore.rules",
            predeploy: ["cp functions/group.js functions/lib/index.js"],
          },
        },
        files: {
          "firestore.rules": "rules_version = '2';\n",
          "functions/lib/index.js": artifact("exports.daily = endpoint();"),
          "functions/group.js": artifact("exports.daily = { grouped: endpoint() };"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily,firestore"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("answers a git branch lookup the way the deployment will", async () => {
    // A build that selects its exports with `git rev-parse --abbrev-ref HEAD`
    // is an ordinary build. Omitting `.git` from the overlay did not withhold
    // authority, it changed the answer: the lookup failed, the fallback ran,
    // and both probes agreed on whatever that produced (Codex P2, round 18).
    //
    // Written so the GIT-VISIBLE branch is the exempt one: a run that could not
    // see the branch — or that forfeited on a metadata write — fails this test
    // rather than passing it for the wrong reason.
    await withFunctionsProject(
      {
        branch: "release",
        functionsConfig: {
          predeploy: [
            'test "$(git rev-parse --abbrev-ref HEAD)" = "release" ' +
              "&& cp functions/single.js functions/lib/index.js " +
              "|| cp functions/group.js functions/lib/index.js",
          ],
        },
        files: {
          "functions/lib/index.js": artifact("exports.placeholder = 1;"),
          "functions/group.js": artifact("exports.daily = { grouped: endpoint() };"),
          "functions/single.js": artifact("exports.daily = endpoint();"),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("ABORTS when a hook changes what the repository answers", async () => {
    // The other half of exposing `.git`: the view is live, so a hook can write
    // through it. The guard is on what `git` ANSWERS rather than on the files
    // under `.git`, because that is the property a build can observe — and
    // because a file-level watch reports drift for a background fetch's
    // FETCH_HEAD, which no build has ever branched on.
    //
    // Fatal, not conservative (Phase 4b P1, round 19): `vite.config.ts` stamps
    // the bundle from `git rev-parse HEAD` during BUILD_CMD, so metadata a hook
    // moved after the approved-checkout guards is a deployment input that
    // changed, and the deploy must stop the same way tree drift stops it.
    await withFunctionsProject(
      {
        branch: "release",
        functionsConfig: { predeploy: [...PREDEPLOY, "git checkout -q -b rewritten"] },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(RepositoryMetadataDriftError);
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("changed what the repository answers");
        expect(failure.message).toContain("Nothing has been restored");
      },
    );
  });

  it("ABORTS when a hook writes THROUGH a symlink inside a linked directory", async () => {
    // A linked project directory can hold a symlink back to a ROOT deployment
    // input — a file the overlay copies rather than links, so the live copy
    // sits under no walked directory. Fingerprinting only the link's own inode
    // would let a hook write through it — replacing firebase.json, say — with
    // no watched path changing (Phase 4b / Codex P1, round 20). The target is
    // fingerprinted under the link, so the write reads as drift on the link
    // that reached it, and the message names that link.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [...PREDEPLOY, "printf x >> tools/config-link"] },
        files: { "toggle.txt": "", "tools/.keep": "" },
        links: { "tools/config-link": "../toggle.txt" },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("tools/config-link");
        expect(failure.message).toContain("Nothing has been restored");
      },
    );
  });

  it("ABORTS when a hook overwrites a file THROUGH a directory-valued symlink", async () => {
    // Codex P1, round 13: overwriting an EXISTING file through a link whose
    // target is a directory moves neither the link nor the directory's mtime,
    // so the target's metadata alone would let the write through. The target
    // directory is walked under the link, so the file it reaches is drift.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, "printf y > tools/config-link/app.txt"],
        },
        files: { "config/app.txt": "x", "tools/.keep": "" },
        links: { "tools/config-link": "../config" },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("app.txt");
        expect(failure.message).toContain("Nothing has been restored");
      },
    );
  });

  it("refuses a directory-valued symlink that leaves the repository", async () => {
    // The walk through a directory target is bounded to the repository: a
    // link out of it names a tree the guard may not read and must not be led
    // to walk. The live checkout therefore cannot be fingerprinted, the
    // inventory is refused BEFORE any hook runs (the hook below would leave a
    // trace it never gets to leave), and the request falls to the conservative
    // arm — every invoker reconciled, exactly as for any other unprovable scope.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [...PREDEPLOY, "printf x >> shared/toggle"] },
        files: { "shared/toggle": "", "tools/.keep": "" },
        links: { "tools/escape-dir": "../.." },
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
        const { readFile: read } = await import("node:fs/promises");
        const { dirname: dir, join: under } = await import("node:path");
        await expect(read(under(dir(configPath), "shared", "toggle"), "utf8")).resolves.toBe("");
      },
    );
  });

  it("refuses a hook that leaves descendants running, and still ends them", async () => {
    // Codex P1, rounds 14 and 17: a hook that backgrounds a process and exits
    // has an outcome Firebase decides on the descendant's own clock (it never
    // kills what a hook left running), which this rehearsal cannot reproduce
    // either way — so the request is refused into the conservative arm. The
    // group is still ended, so the write below never lands in the live tree:
    // not during the run, and not after it either.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, "(cd shared; sleep 3; printf x >> toggle) &"],
        },
        files: { "shared/toggle": "" },
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
        await new Promise((settle) => setTimeout(settle, 4500));
        const { readFile: read } = await import("node:fs/promises");
        const { dirname: dir, join: under } = await import("node:path");
        await expect(read(under(dir(configPath), "shared", "toggle"), "utf8")).resolves.toBe("");
      },
    );
  });

  it("refuses a backgrounded artifact rewrite that a later hook would let finish", async () => {
    // Codex P1, round 17, verbatim: Firebase would let the copy finish before
    // discovery and deploy the group; awaiting or killing it here are both
    // guesses, so the exemption is refused instead.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, '("sleep" 0.2; cp "$RESOURCE_DIR/group.js" "$RESOURCE_DIR/lib/index.js") &', "sleep 1"],
        },
        files: { "functions/group.js": artifact("exports.daily = { submitBugReport: endpoint() };") },
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
      },
    );
  });

  it("rehearses an mtime-based incremental hook against the live timestamps", async () => {
    // Codex P1, round 17: the staging copy used to refresh every source mtime,
    // so a hook that builds the protected group only when `src/index.ts` is
    // older than a linked stamp emitted the plain endpoint here and the group
    // for real. Timestamps now travel with the copy.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [
            ...PREDEPLOY,
            'if [ "$RESOURCE_DIR/src/index.ts" -ot "$PROJECT_DIR/shared/stamp" ]; then cp "$RESOURCE_DIR/group.js" "$RESOURCE_DIR/lib/index.js"; fi',
          ],
        },
        files: {
          "shared/stamp": "",
          "functions/group.js": artifact("exports.daily = { submitBugReport: endpoint() };"),
        },
      },
      async (configPath) => {
        const { utimes } = await import("node:fs/promises");
        const { dirname: dir, join: under } = await import("node:path");
        const past = new Date(Date.now() - 3_600_000);
        await utimes(under(dir(configPath), "functions", "src", "index.ts"), past, past);
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, bugReportInvokerSelected: true });
      },
    );
  });

  it.each([
    ["the copied Functions source", "functions/src/index.ts"],
    ["a copied project-root file", "firebase.json"],
  ])("ABORTS when a hook writes to %s through an absolute live path", async (_label, target) => {
    // Codex P1, round 15: the overlay COPIES the Functions source and the
    // project-root files, so no relative path from the scratch project reaches
    // their live originals — but a hook launched through npm inherits
    // `INIT_CWD` pointing at the live repository, and any absolute path lands
    // on the checkout the deploy will build from. The copied inputs' live
    // originals are fingerprinted too, so the write is drift.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, `printf x >> "$INIT_CWD/${target}"`],
        },
      },
      async (configPath) => {
        const { dirname: dir } = await import("node:path");
        const previous = process.env.INIT_CWD;
        process.env.INIT_CWD = dir(configPath);
        try {
          const failure = await classify(["--only", "functions:daily"], configPath).then(
            () => null,
            (error) => error,
          );
          expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
          expect(failure.message).toContain(target.split("/").pop());
          expect(failure.message).toContain("Nothing has been restored");
        } finally {
          if (previous === undefined) delete process.env.INIT_CWD;
          else process.env.INIT_CWD = previous;
        }
      },
    );
  });

  it("ABORTS when a hook writes THROUGH a copied root file that is a symlink", async () => {
    // Codex P1, round 16: a copied root file can itself be a link — a shared
    // build input outside the repository, say — and fingerprinting only the
    // link inode would let a hook rewrite its target through INIT_CWD. The
    // target is recorded under the link exactly as the walk records it.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, 'printf y > "$INIT_CWD/build-input.txt"'],
        },
        links: { "build-input.txt": "../outside-build-input.txt" },
      },
      async (configPath) => {
        const { dirname: dir, join: under } = await import("node:path");
        const { rm: remove, writeFile: write } = await import("node:fs/promises");
        // The target lives OUTSIDE the fixture (and so outside every watched
        // directory), created before the overlay copies the link through it.
        const outside = under(dir(configPath), "..", "outside-build-input.txt");
        await write(outside, "x");
        const previous = process.env.INIT_CWD;
        process.env.INIT_CWD = dir(configPath);
        try {
          const failure = await classify(["--only", "functions:daily"], configPath).then(
            () => null,
            (error) => error,
          );
          expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
          expect(failure.message).toContain("build-input.txt");
        } finally {
          if (previous === undefined) delete process.env.INIT_CWD;
          else process.env.INIT_CWD = previous;
          await remove(outside, { force: true });
        }
      },
    );
  });

  it("ABORTS when a hook moves a remote-tracking ref", async () => {
    // Codex P1, round 18: a hook's `git fetch` advances refs/remotes/origin/main
    // without touching HEAD, the branch or the nearest tag, and the wrapper's
    // approved-checkout guard asked whether HEAD equals origin/main BEFORE the
    // rehearsal. Every remote-tracking ref is part of what git answers now.
    await withFunctionsProject(
      {
        branch: "release",
        functionsConfig: {
          predeploy: [...PREDEPLOY, "git update-ref refs/remotes/origin/main HEAD"],
        },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(RepositoryMetadataDriftError);
        expect(failure.message).toContain("refs/remotes/origin/main");
      },
    );
  });

  it("ABORTS when a hook creates a new project-root entry through an absolute live path", async () => {
    // Codex P1, round 18: the roots and copied files are the entries that
    // existed when staging ran, so a marker a non-idempotent hook creates at
    // the live root was in neither snapshot. The root's entry set is part of
    // the fingerprint now.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, 'printf x > "$INIT_CWD/.deploy-mode"'],
        },
      },
      async (configPath) => {
        const { dirname: dir } = await import("node:path");
        const previous = process.env.INIT_CWD;
        process.env.INIT_CWD = dir(configPath);
        try {
          const failure = await classify(["--only", "functions:daily"], configPath).then(
            () => null,
            (error) => error,
          );
          expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
          expect(failure.message).toContain("root entries");
        } finally {
          if (previous === undefined) delete process.env.INIT_CWD;
          else process.env.INIT_CWD = previous;
        }
      },
    );
  });

  it("rehearses an mtime-based hook against a project-root stamp with live timestamps", async () => {
    // Codex P1, round 19: the copied root files refreshed their mtimes too,
    // so a hook comparing a source file against `$PROJECT_DIR/stamp` answered
    // differently here than live. The root-file copy preserves timestamps now.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [
            ...PREDEPLOY,
            'if [ "$RESOURCE_DIR/src/index.ts" -ot "$PROJECT_DIR/stamp" ]; then cp "$RESOURCE_DIR/group.js" "$RESOURCE_DIR/lib/index.js"; fi',
          ],
        },
        files: {
          stamp: "",
          "functions/group.js": artifact("exports.daily = { submitBugReport: endpoint() };"),
        },
      },
      async (configPath) => {
        const { utimes } = await import("node:fs/promises");
        const { dirname: dir, join: under } = await import("node:path");
        const past = new Date(Date.now() - 3_600_000);
        await utimes(under(dir(configPath), "functions", "src", "index.ts"), past, past);
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, bugReportInvokerSelected: true });
      },
    );
  });

  it("ABORTS when a hook that leaves descendants running has also moved a remote-tracking ref", async () => {
    // Codex P1, round 19: the background-hook refusal checked the live tree
    // but not what git answers, and returned BEFORE the post-hook metadata
    // check — so a hook that moved origin/main and left a child running was
    // refused conservatively while the wrapper's checkout guard no longer
    // held. The refusal now asks git first and aborts on the moved ref.
    await withFunctionsProject(
      {
        branch: "release",
        functionsConfig: {
          predeploy: [...PREDEPLOY, "git update-ref refs/remotes/origin/main HEAD; sleep 3 &"],
        },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(RepositoryMetadataDriftError);
        expect(failure.message).toContain("refs/remotes/origin/main");
      },
    );
  });

  it("ABORTS when a hook creates an entry in an intermediate overlay directory", async () => {
    // Phase 4b P1, run 4: with the source at `packages/functions`, the overlay
    // traverses `packages` to place it and registered only its existing
    // children, so `$INIT_CWD/packages/generated.ts` was in neither snapshot.
    // Every traversed directory's entry set is watched now.
    await withFunctionsProject(
      {
        functionsConfig: {
          source: "packages/functions",
          predeploy: [...PREDEPLOY, 'printf x > "$INIT_CWD/packages/generated.ts"'],
        },
        files: { "packages/functions/.keep": "" },
      },
      async (configPath) => {
        const { dirname: dir, join: under } = await import("node:path");
        const { cp: copy, rm: remove } = await import("node:fs/promises");
        // The fixture installs its toolchain under `functions/`; move it.
        await copy(under(dir(configPath), "functions"), under(dir(configPath), "packages", "functions"), {
          recursive: true,
          verbatimSymlinks: true,
        });
        await remove(under(dir(configPath), "functions"), { recursive: true, force: true });
        const previous = process.env.INIT_CWD;
        process.env.INIT_CWD = dir(configPath);
        try {
          const failure = await classify(["--only", "functions:daily"], configPath).then(
            () => null,
            (error) => error,
          );
          expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
          expect(failure.message).toContain("packages");
          expect(failure.message).toContain("entries");
        } finally {
          if (previous === undefined) delete process.env.INIT_CWD;
          else process.env.INIT_CWD = previous;
        }
      },
    );
  });

  it("ABORTS when a hook leaves a marker at the root of a linked node_modules", async () => {
    // Codex P1, round 22: the dependency tree is linked into the overlay and
    // was excluded from both fingerprints, so a marker a hook left there for
    // the deploy's second run was invisible. Each node_modules is watched one
    // level deep now.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, 'printf x > "$RESOURCE_DIR/node_modules/.deploy-marker"'],
        },
      },
      async (configPath) => {
        const { dirname: dir, join: under } = await import("node:path");
        const { rm: remove } = await import("node:fs/promises");
        const marker = under(dir(configPath), "functions", "node_modules", ".deploy-marker");
        try {
          const failure = await classify(["--only", "functions:daily"], configPath).then(
            () => null,
            (error) => error,
          );
          expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
          expect(failure.message).toContain("node_modules");
        } finally {
          await remove(marker, { force: true });
        }
      },
    );
  });

  it("ABORTS when a hook writes through the overlay and THEN fails", async () => {
    // The write is the fatal condition and the failure is merely conservative;
    // checking them in that order is what keeps the write fatal. Handled the
    // other way round, the refusal returns first and `deploy.sh` walks into
    // BUILD_CMD with a checkout the clean-tree guard never approved (Phase 4b
    // P1, round 19).
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [...PREDEPLOY, "printf x >> shared/toggle && exit 7"] },
        files: { "shared/toggle": "" },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("shared/toggle");
        expect(failure.message).toContain("failing predeploy hook");
      },
    );
  });

  it("preserves the codebase loading sequence inside one project probe", async () => {
    // `loadCodebases` walks the selected codebases sequentially against ONE
    // project, so the first codebase's module initialization can replace the
    // second's artifact. A fresh copy per codebase threw that write away before
    // the second inventory started, and both probes approved single endpoints
    // while the real second discovery found a group (Codex P2, round 18).
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-sequence-"));
    try {
      for (const [dir, name] of [
        ["functions-default", "daily"],
        ["functions-beta", "betaOnly"],
      ]) {
        const codebaseDir = resolve(fixture, dir);
        await mkdir(resolve(codebaseDir, "src"), { recursive: true });
        await installToolchain(codebaseDir);
        await writeUnder(codebaseDir, "package.json", JSON.stringify(DEFAULT_PACKAGE));
        await writeUnder(codebaseDir, "tsconfig.json", JSON.stringify(DEFAULT_TSCONFIG));
        await writeUnder(codebaseDir, "src/index.ts", endpoint(name));
      }
      // The first codebase to be discovered rewrites the second's artifact,
      // exactly as a shared generator would.
      await writeUnder(
        fixture,
        "functions-default/lib/index.js",
        artifact(
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            "fs.writeFileSync(",
            '  path.join(__dirname, "..", "..", "functions-beta", "lib", "index.js"),',
            "  fs.readFileSync(path.join(__dirname, \"..\", \"..\", \"grouped-beta.js\"), \"utf8\"),",
            ");",
            "exports.daily = endpoint();",
          ].join("\n"),
        ),
      );
      await writeUnder(
        fixture,
        "functions-beta/lib/index.js",
        artifact("exports.betaOnly = endpoint();"),
      );
      await writeUnder(
        fixture,
        "grouped-beta.js",
        artifact("exports.betaOnly = { grouped: endpoint() };"),
      );
      await writeUnder(
        fixture,
        "firebase.json",
        JSON.stringify({
          functions: [
            { source: "functions-default", predeploy: [] },
            { source: "functions-beta", codebase: "beta", predeploy: [] },
          ],
        }),
      );
      expect(
        await classify(
          ["--only", "functions:default:daily,functions:beta:betaOnly"],
          resolve(fixture, "firebase.json"),
        ),
      ).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

describe("pinned Hosting rewrites widen the selector the way the CLI does", RUNS_A_BUILD, () => {
  // Codex P1, round 13 on #1107: `addPinnedFunctionsToOnlyString` runs before
  // any lifecycle hook and appends every `pinTag` rewrite's function to
  // `--only`, so `--only functions:daily,hosting` deploys the pinned callable
  // too. The classifier has to see the same selector the CLI will act on.
  const pinned = (extra = {}) => ({
    hosting: {
      public: "public",
      rewrites: [{ source: "/api/bug", function: { functionId: "submitBugReport", pinTag: true, ...extra } }],
    },
  });

  it("selects the pinned callable's invoker for an otherwise exact selector", async () => {
    await withFunctionsProject(
      { config: pinned(), files: { "public/index.html": "" } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily,hosting"], configPath);
        expect(result).toMatchObject({
          hostingAttempted: true,
          functionsAttempted: true,
          bugReportInvokerSelected: true,
          bugReportInvokerConservative: false,
          authHandoffInvokerSelected: false,
        });
      },
    );
  });

  it("does not widen when Hosting is not part of the deploy", async () => {
    await withFunctionsProject(
      { config: pinned(), files: { "public/index.html": "" } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ hostingAttempted: false, ...NO_INVOKER_SELECTED });
      },
    );
  });

  it("does not widen for a rewrite that is not pinned", async () => {
    const unpinned = { hosting: { public: "public", rewrites: [{ source: "/api/bug", function: { functionId: "submitBugReport" } }] } };
    await withFunctionsProject(
      { config: unpinned, files: { "public/index.html": "" } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily,hosting"], configPath);
        expect(result).toMatchObject({ hostingAttempted: true, ...NO_INVOKER_SELECTED });
      },
    );
  });

  it("reports ownership unknown with more than one codebase, and turns every invoker conservative", async () => {
    // Phase 4b P2, run 4: widening discovery to every codebase is not
    // conservative when module initialisation has side effects, so a pinned
    // function whose codebase cannot be known offline refuses the exemption.
    const two = {
      functions: [
        { source: "alpha", codebase: "alpha" },
        { source: "beta", codebase: "beta" },
      ],
      hosting: { public: "public", rewrites: [{ source: "/api/bug", function: { functionId: "submitBugReport", pinTag: true } }] },
    };
    const one = { ...two, functions: [two.functions[0]] };
    expect(pinnedRewriteWidening({ only: "functions:alpha:daily,hosting", exceptTargets: "", configSource: two, project: "" }).ownershipUnknown).toBe(true);
    expect(pinnedRewriteWidening({ only: "functions:alpha:daily,hosting", exceptTargets: "", configSource: one, project: "" }).ownershipUnknown).toBe(false);
    const scope = await classifyInvokerScope(
      "functions:alpha:daily,hosting,functions:alpha:submitBugReport,functions:beta:submitBugReport",
      "",
      [],
      undefined,
      ["submitBugReport"],
      true,
    );
    expect(scope).toMatchObject({ functionsAttempted: true, hostingAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
  });

  it("counts kit instances as codebases when judging pinned-function ownership", () => {
    // Codex P1, round 21: a kit config has no `codebase`, and collapsing it
    // into `default` left an implicit default codebase looking like the only
    // one — so a Hosting pin owned by a kit instance was rehearsed against the
    // default codebase alone. Kit instance keys are codebases, as the pinned
    // CLI expands them.
    const kitBeside = {
      functions: [{ source: "functions" }, { kit: "@firebase/example-kit", instances: { kitone: {} } }],
      hosting: { public: "public", rewrites: [{ source: "/api/bug", function: { functionId: "submitBugReport", pinTag: true } }] },
    };
    const widened = pinnedRewriteWidening({ only: "functions:daily,hosting", exceptTargets: "", configSource: kitBeside, project: "" });
    expect(widened.ownershipUnknown).toBe(true);
    expect(widened.only.split(",")).toEqual(
      expect.arrayContaining(["functions:default:submitBugReport", "functions:kitone:submitBugReport"]),
    );
  });

  it("widens BEFORE planning, so every codebase's hooks and discovery see the pinned id", () => {
    // Codex P1, round 14: the widening has to reach hook planning and
    // discovery, not just the classification loop. Firebase resolves the
    // pinned function's codebase from the live backend; offline, every
    // configured codebase is widened to, so a mixed request such as
    // `functions:alpha:daily,hosting` whose pinned rewrite lives in `beta`
    // plans beta's predeploy hook in the rehearsal that proves alpha's
    // endpoint — exactly the hook that could rewrite alpha's artifact.
    const configSource = {
      functions: [
        { source: "alpha", codebase: "alpha" },
        { source: "beta", codebase: "beta" },
      ],
      hosting: { public: "public", rewrites: [{ source: "/api/bug", function: { functionId: "submitBugReport", pinTag: true } }] },
    };
    const widened = pinnedRewriteWidening({
      only: "functions:alpha:daily,hosting",
      exceptTargets: "",
      configSource,
      project: "fiveacross",
    });
    expect(widened).toEqual({
      only: "functions:alpha:daily,hosting,functions:alpha:submitBugReport,functions:beta:submitBugReport",
      ids: ["submitBugReport"],
      functionsReAdded: true,
      ownershipUnknown: true,
    });
    const configs = configSource.functions;
    const names = new Set(["alpha", "beta"]);
    expect([...targetCodebases("functions:alpha:daily,hosting", configs, names)]).toEqual(["alpha"]);
    expect([...targetCodebases(widened.only, configs, names)].sort()).toEqual(["alpha", "beta"]);

    // Hosting alone: nothing to widen a selector with, but Functions is re-added.
    expect(pinnedRewriteWidening({ only: "hosting", exceptTargets: "", configSource, project: "" })).toMatchObject({
      only: "hosting,functions:alpha:submitBugReport,functions:beta:submitBugReport",
      functionsReAdded: true,
    });
    // `--except functions` still deploys Functions when Hosting pins one.
    expect(pinnedRewriteWidening({ only: "", exceptTargets: "functions", configSource, project: "" })).toEqual({
      only: "",
      ids: ["submitBugReport"],
      functionsReAdded: true,
      ownershipUnknown: true,
    });
    // No Hosting in the deploy, or no pinned rewrite: the request is untouched.
    expect(pinnedRewriteWidening({ only: "functions:alpha:daily", exceptTargets: "", configSource, project: "" })).toEqual({
      only: "functions:alpha:daily",
      ids: [],
      functionsReAdded: false,
      ownershipUnknown: false,
    });
    expect(pinnedRewriteWidening({ only: "", exceptTargets: "hosting", configSource, project: "" })).toMatchObject({ functionsReAdded: false });
    const unpinned = { ...configSource, hosting: { public: "public", rewrites: [{ source: "/api/bug", function: { functionId: "submitBugReport" } }] } };
    expect(pinnedRewriteWidening({ only: "functions:alpha:daily,hosting", exceptTargets: "", configSource: unpinned, project: "" })).toMatchObject({ only: "functions:alpha:daily,hosting", functionsReAdded: false });
  });

  it("runs no Functions hook for a Hosting-only request whose rewrite is not pinned", async () => {
    const unpinned = { hosting: { public: "public", rewrites: [{ source: "/api/bug", function: { functionId: "submitBugReport" } }] } };
    await withFunctionsProject(
      {
        config: unpinned,
        functionsConfig: { predeploy: [...PREDEPLOY, "printf x >> shared/toggle"] },
        files: { "public/index.html": "", "shared/toggle": "" },
      },
      async (configPath) => {
        const result = await classify(["--only", "hosting"], configPath);
        expect(result).toMatchObject({ hostingAttempted: true, functionsAttempted: false });
      },
    );
  });

  it("widens a codebase-qualified request to the pinned callable as well", async () => {
    await withFunctionsProject(
      { config: pinned(), files: { "public/index.html": "" } },
      async (configPath) => {
        const result = await classify(["--only", "functions:default:daily,hosting"], configPath);
        expect(result).toMatchObject({
          functionsAttempted: true,
          bugReportInvokerSelected: true,
          bugReportInvokerConservative: false,
          authHandoffInvokerSelected: false,
        });
      },
    );
  });

  it("re-adds the whole Functions target when only Hosting was asked for", async () => {
    await withFunctionsProject(
      { config: pinned(), files: { "public/index.html": "" } },
      async (configPath) => {
        const result = await classify(["--except", "functions"], configPath);
        expect(result).toMatchObject({
          hostingAttempted: true,
          functionsAttempted: true,
          bugReportInvokerSelected: true,
          emailUnsubscribeInvokerSelected: true,
          authHandoffInvokerSelected: true,
        });
      },
    );
  });
});

describe("a Functions kit beside an explicit codebase", RUNS_A_BUILD, () => {
  // Codex P1, round 16: a kit config has no `codebase` key, so
  // `getReleventConfigs` runs ITS predeploy hooks on every Functions deploy —
  // `--only functions:alpha:daily` included — and the classifier has no source
  // directory in which to rehearse them. A kit hook could rewrite alpha's
  // artifact for real and never here, so no codebase is proved exact while
  // such hooks exist.
  const withKit = (kitExtra) => ({
    functions: [
      { source: "functions", codebase: "alpha", predeploy: PREDEPLOY },
      { kit: "@firebase/example-kit", instances: { kitone: {} }, ...kitExtra },
    ],
  });

  it("refuses the exemption when the kit carries predeploy hooks", async () => {
    await withFunctionsProject(
      { config: withKit({ predeploy: ["echo kit-hook"] }) },
      async (configPath) => {
        const result = await classify(["--only", "functions:alpha:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
      },
    );
  });

  it("still proves the exact endpoint when the kit carries no hooks", async () => {
    await withFunctionsProject(
      { config: withKit({}) },
      async (configPath) => {
        const result = await classify(["--only", "functions:alpha:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...NO_INVOKER_SELECTED });
      },
    );
  });
});
