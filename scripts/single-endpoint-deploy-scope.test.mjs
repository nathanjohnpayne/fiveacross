// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LiveCheckoutDriftError,
  RepositoryMetadataDriftError,
  WRITE_CONTAINMENT_REFUSAL,
  classifyFirebaseDeployRequest,
  pinnedRewriteWidening,
  targetCodebases,
  classifyInvokerScope,
  firstUnprovableCodebase,
  gitAnswerFingerprint,
  probeWriteContainment,
} from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// What this machine can prove, asked once, before a single case is collected
// ---------------------------------------------------------------------------

/**
 * WHAT THIS MACHINE CAN PROVE, from the classifier's own machinery.
 *
 * Nearly everything below asserts what a PREDEPLOY HOOK did — the artifact it
 * built, the write it was denied, the drift the fingerprints caught while it
 * ran — and no hook runs anywhere unless `establishWriteContainment` first
 * proved a mechanism that can hold its writes. On a machine that can prove
 * none, the classifier refuses before staging anything, and every one of those
 * cases is then asserting the exemption path against a machine that has no
 * exemption path. That is not a finding about this classifier; it is a fact
 * about the machine, and this asks the machine directly.
 *
 * `ubuntu-latest` — where `app-ci` runs — is exactly such a machine: `bwrap` is
 * not installed, and Ubuntu 24.04 refuses an unprivileged user namespace
 * (`write failed /proc/self/uid_map: Operation not permitted`), so all three
 * Linux candidates fail and the refusal is correct production behaviour. The
 * runner-side fix belongs to the runner; what belongs here is a suite that
 * says so instead of failing 78 cases.
 *
 * NOT `process.platform`. A Linux box WITH `bwrap` runs every case exactly as
 * this repository's development Mac does, and a Mac whose `sandbox-exec` was
 * finally removed would go on claiming it could. `probeWriteContainment` runs
 * the real candidates against a scratch root and stages nothing.
 */
const WRITE_CONTAINMENT = await probeWriteContainment();

/**
 * ABSENCE, not breakage — the only reason a case here may be skipped.
 *
 * A probe that comes back with NO_MECHANISM or UNPROVED found nothing to run:
 * `bwrap` is not on the PATH, the kernel refuses the namespace, the platform
 * offers no candidate at all. Nothing was contained because nothing could be.
 *
 * A probe that comes back with the CHECKOUT canary or an ESCAPED root found the
 * opposite: a mechanism ran and its containment LEAKED. That is the failure
 * this whole apparatus exists to catch, and skipping on it would retire the
 * guard exactly when it fires — so it is deliberately not a skip, on CI or
 * anywhere else. The cases run, and they fail, which is the point.
 */
const NO_CONTAINMENT_MECHANISM =
  !WRITE_CONTAINMENT.ok &&
  (WRITE_CONTAINMENT.reason.includes(WRITE_CONTAINMENT_REFUSAL.NO_MECHANISM) ||
    (WRITE_CONTAINMENT.reason.includes(WRITE_CONTAINMENT_REFUSAL.UNPROVED) &&
      !WRITE_CONTAINMENT.reason.includes(WRITE_CONTAINMENT_REFUSAL.CHECKOUT_CANARY) &&
      !WRITE_CONTAINMENT.reason.includes(WRITE_CONTAINMENT_REFUSAL.ESCAPED_ROOT)));

/**
 * `it`, for a case that needs a hook to have RUN inside a proved containment.
 *
 * Every case marked with this is skipped on a machine that can prove none, and
 * runs unchanged everywhere else. What replaces them there is not nothing: the
 * two cases at the end of "write containment holds a rehearsal's writes inside
 * the scratch root" assert the fail-closed contract itself, and they run on
 * every machine.
 */
const itContained = it.skipIf(NO_CONTAINMENT_MECHANISM);

if (NO_CONTAINMENT_MECHANISM) {
  // Printed once, and naming the refusal, because a run whose skips are silent
  // reads as a run that proved what it did not.
  console.warn(
    [
      "",
      "single-endpoint-deploy-scope: this machine can prove no write containment, so every",
      "case that needs a predeploy hook to run inside one is SKIPPED. The refusal was:",
      `  ${WRITE_CONTAINMENT.reason}`,
      "What still runs here is the fail-closed contract itself — the classifier refuses every",
      "selector, names the candidates it could not prove, stages nothing and executes no hook.",
      "",
    ].join("\n"),
  );
}

/** The conventional Firebase predeploy hook. */
const PREDEPLOY = ['npm --prefix "$RESOURCE_DIR" run build'];

/**
 * A stand-in for the ADC document a wrapper establishes, shared by every case
 * that is not about the credential itself.
 *
 * The classifier refuses EVERY exemption when no established deploy credential
 * is named — a synthetic substitute is exactly what the round-26 finding ruled
 * out — so a suite that named none would prove nothing but that refusal. The
 * cases about the credential pass their own document, or `null` to be the
 * standalone caller that has none.
 *
 * The document is the shape the wrapper's documented default path produces: the
 * target service account handed over directly, so `type` is `service_account`
 * and `client_email` is the real deployer. Nothing in the classifier reads it;
 * the fixtures' own hooks do.
 */
const ESTABLISHED_CREDENTIAL_DOCUMENT = {
  type: "service_account",
  project_id: "fiveacross",
  client_email: "firebase-deployer@fiveacross.iam.gserviceaccount.com",
};

let establishedCredentialDir = null;
let establishedCredential = null;

/** One ADC document on disk, outside every fixture, for one case to name. */
async function withEstablishedCredential(document, run) {
  const dir = await mkdtemp(join(tmpdir(), "established-credential-"));
  try {
    const path = join(dir, "application_default_credentials.json");
    await writeFile(path, JSON.stringify(document), "utf8");
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function classify(args, configPath = resolve(repoRoot, "firebase.json"), options = {}) {
  return classifyFirebaseDeployRequest(["fiveacross", ...args], {
    defaultConfigPath: configPath,
    establishedCredentialPath: establishedCredential,
    ...options,
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
 * Where a fixture that has to be OUTSIDE the system temp dir is staged.
 *
 * NOT because the containment would otherwise miss it. Since round 28 the live
 * checkout is denied to every contained process wherever it lies, including
 * under the temp dir the staging keeps writable — that is the nested read-only
 * override `establishWriteContainment` describes, and the reason every fixture
 * here could stay in the temp dir where it already was. What this root gives is
 * the OTHER arrangement: a checkout that needs no override at all, because it is
 * outside every writable root, so a case can show the two layouts answering
 * identically rather than only ever exercising the nested one.
 *
 * `node_modules` is ignored by version control, exists by the time any of this
 * runs, and lies outside every writable root.
 */
const LIVE_FIXTURE_ROOT = join(repoRoot, "node_modules");

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
 *   projectSubdir?: string,     // put the whole project under this subdirectory
 *   fixtureRoot?: string,       // stage the fixture here instead of the temp dir
 * }} spec
 */
async function withFunctionsProject(spec, run) {
  const fixture = await mkdtemp(join(spec.fixtureRoot ?? tmpdir(), "single-endpoint-scope-"));
  try {
    // `projectSubdir` puts `firebase.json` and its codebases BELOW the fixture
    // root, which is where `initFixtureRepository` puts `.git` — the nested
    // config layout `-c deploy/firebase.json` produces. Everything else in a
    // spec stays project-relative, so a case reads the same either way.
    const project = spec.projectSubdir ? resolve(fixture, spec.projectSubdir) : fixture;
    await mkdir(project, { recursive: true });
    const functionsDir = resolve(project, "functions");
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
      await writeUnder(project, file, contents);
    }
    for (const [link, target] of Object.entries(spec.links ?? {})) {
      const at = resolve(project, link);
      await mkdir(dirname(at), { recursive: true });
      await symlink(target, at);
    }
    await writeUnder(
      project,
      "firebase.json",
      JSON.stringify({
        functions: { source: "functions", predeploy: PREDEPLOY, ...spec.functionsConfig },
        ...spec.config,
      }),
    );
    if (spec.branch) await initFixtureRepository(fixture, spec.branch);
    await run(resolve(project, "firebase.json"));
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
  const git = (args) => gitIn(dir, args);
  await git(["init", "--quiet", "-b", branch]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
}

/** One `git` command in a fixture repository. */
function gitIn(dir, args) {
  return new Promise((settle, fail) => {
    const child = spawn("git", args, { cwd: dir, stdio: "ignore" });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? settle() : fail(new Error(`git ${args.join(" ")} exited ${code}`)),
    );
  });
}

/**
 * A temp project with several configured codebases. `sources` maps a codebase
 * name to its `src/index.ts`, or to `{ source, config }` when the case is about
 * a setting on that codebase's own Firebase config; the key "default" writes a
 * config with no explicit `codebase` key, which is how Firebase spells the
 * default.
 */
async function withCodebases(sources, run) {
  const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-codebases-"));
  try {
    const functions = [];
    for (const [codebase, spec] of Object.entries(sources)) {
      const { source, config = {} } = typeof spec === "string" ? { source: spec } : spec;
      const dir = `functions-${codebase}`;
      await mkdir(resolve(fixture, dir, "src"), { recursive: true });
      await installToolchain(resolve(fixture, dir));
      await writeUnder(resolve(fixture, dir), "package.json", JSON.stringify(DEFAULT_PACKAGE));
      await writeUnder(resolve(fixture, dir), "tsconfig.json", JSON.stringify(DEFAULT_TSCONFIG));
      await writeUnder(resolve(fixture, dir), "src/index.ts", source);
      functions.push(
        codebase === "default"
          ? { source: dir, predeploy: PREDEPLOY, ...config }
          : { source: dir, codebase, predeploy: PREDEPLOY, ...config },
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

/**
 * Run `body` with the classifier's own debug reporting on, and hand back every
 * refusal reason it printed.
 *
 * A refusal reaches stdout only as a conservative CLASSIFICATION, which several
 * different causes share. `FIREBASE_DEPLOY_CLASSIFIER_DEBUG` is the classifier's
 * own channel for the cause, so a case that has to distinguish two refusals can
 * assert on the one it means.
 */
async function withRefusalReasons(body) {
  const reasons = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...parts) => {
    reasons.push(parts.map(String).join(" "));
  });
  try {
    const result = await withEnv({ FIREBASE_DEPLOY_CLASSIFIER_DEBUG: "1" }, body);
    return { result, reasons: reasons.join("\n") };
  } finally {
    spy.mockRestore();
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
 * A predeploy hook that STOPS in the middle of its run, and the handles a test
 * needs to write into the checkout while it is stopped there.
 *
 * WHY A TEST NEEDS THIS AT ALL. Since round 28 the write containment denies the
 * live checkout to every process this classifier starts, whether the checkout
 * lies under the system temp dir or anywhere else, so a HOOK can no longer
 * produce the drift the guards below it exist to catch. The writer those guards
 * are still for is an UNCONTAINED one — the parent process, something in another
 * window, a worker that was already running — and in this suite the test process
 * is that writer. `onStaged` is the seam for the window before the hooks; this
 * gate is for the window DURING them, which no seam reaches and which the
 * exit-ordering and post-hook cases are specifically about.
 *
 * The two sentinels live in a temp directory of their own, OUTSIDE the fixture:
 * writable inside the containment, because saying where it got to is not writing
 * a deployment input. `sleep 0.05` rather than a spin, so a hook that is waiting
 * costs nothing; `PREDEPLOY_HOOK_TIMEOUT_MS` is five minutes, and every wait
 * here is milliseconds.
 */
async function openHookGate() {
  const dir = await mkdtemp(join(tmpdir(), "hook-gate-"));
  const ready = join(dir, "ready");
  const go = join(dir, "go");
  return {
    /** The shell fragment to put in a `predeploy` array. */
    command: `printf ready > '${ready}'; while [ ! -e '${go}' ]; do sleep 0.05; done`,
    /**
     * The same gate for module-scope code inside a built artifact, which is
     * loaded synchronously and so cannot await anything. `Atomics.wait` is the
     * synchronous sleep that leaves no descendant behind — a child process would
     * be one more thing the discovery guards have to forgive.
     */
    javascript: [
      'const gateFs = require("node:fs");',
      `gateFs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
      `while (!gateFs.existsSync(${JSON.stringify(go)})) {`,
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
      "}",
    ].join("\n"),
    /** Resolves once the hook has reached the gate. */
    async reached(timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("the gated hook never reached its gate");
        await new Promise((wake) => setTimeout(wake, 25));
      }
    },
    /** Lets the hook finish. */
    release: () => writeFile(go, ""),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Run `classifying` while `write` happens with the gated hook held mid-run, and
 * answer with whatever the classification threw (or `null` if it returned).
 *
 * The gate is released in a `finally` so a failing `write` cannot leave a hook
 * waiting out its five-minute ceiling.
 */
async function whileAHookWaits(gate, classifying, write) {
  const outcome = classifying().then(
    () => null,
    (error) => error,
  );
  try {
    await gate.reached();
    await write();
  } finally {
    await gate.release();
  }
  return outcome;
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
        '$FIREBASE_DEPLOY_REJECT_OVERRIDES$FIREBASE_DEPLOY_CLASSIFIER_FORMAT' +
        // The wrapper names the established ADC document to the classifier and
        // to nothing else: `firebase deploy` reads that document through
        // GOOGLE_APPLICATION_CREDENTIALS and never sees this name.
        '$FIREBASE_DEPLOY_ESTABLISHED_CREDENTIAL" ' +
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

/**
 * The environment `deploy.sh` builds for the classifier and for nothing else.
 *
 * The established deploy credential is part of it: the wrapper forwards
 * whatever named the ADC document, and without one the classifier refuses every
 * exemption, so a wrapper case that omitted it could not tell a refusal about
 * the credential apart from the one it means to prove.
 */
const DEPLOY_SH_CLASSIFIER_ENV = (configPath) => ({
  FIREBASE_DEPLOY_DEFAULT_PROJECT: "fiveacross",
  FIREBASE_DEPLOY_DEFAULT_CONFIG: configPath,
  FIREBASE_DEPLOY_REJECT_OVERRIDES: "true",
  FIREBASE_DEPLOY_ESTABLISHED_CREDENTIAL: establishedCredential,
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

// The established deploy credential every case inherits. See
// ESTABLISHED_CREDENTIAL_DOCUMENT for why a suite without one proves nothing.
beforeAll(async () => {
  establishedCredentialDir = await mkdtemp(join(tmpdir(), "established-credential-"));
  establishedCredential = join(
    establishedCredentialDir,
    "application_default_credentials.json",
  );
  await writeFile(
    establishedCredential,
    JSON.stringify(ESTABLISHED_CREDENTIAL_DOCUMENT),
    "utf8",
  );
});

afterAll(async () => {
  if (establishedCredentialDir) {
    await rm(establishedCredentialDir, { recursive: true, force: true });
  }
});

describe("exact single-endpoint scopes against the real Functions index", RUNS_A_BUILD, () => {
  itContained("does not select any invoker for endpoints the artifact deploys alone", async () => {
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

  itContained("normalizes whitespace in the filter list exactly as the CLI does", async () => {
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

  itContained("accepts the codebase-qualified form of the same endpoint", async () => {
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
  itContained("exempts a single endpoint that survives the real build", async () => {
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

  itContained("exempts a builder from a nested SDK provider subpath", async () => {
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

  itContained("exempts a source that binds `module` as an ordinary local name", async () => {
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

  itContained("exempts a reassignable binding that is never reassigned", async () => {
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

  itContained("exempts an unbuilt codebase whose artifact really is one endpoint", async () => {
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

  itContained("exempts a prefix-sharing export that is not an endpoint at all", async () => {
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

  itContained("skips a real extension descriptor without recursing into it", async () => {
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
      // an authenticated lookup a local preflight must not make, so any way of
      // asking about a field this classifier could not supply means the real
      // value might have selected a different surface. Membership, descriptor
      // and enumeration discriminate just as well as a read (Codex P2, round
      // 11). Each of these branches also separates the two probes, which is what
      // caught them before the preload watched the variable at all.
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

  it("refuses an artifact that parses FIREBASE_CONFIG even for the project id", async () => {
    // Phase 4b P1 on #1107. This used to be the exempt case, on the ground that
    // `projectId` is a field this classifier CAN supply — but the preload sees
    // the variable, not what the artifact then took out of the object it parsed.
    // A branch that reads `projectId` and `storageBucket` from the same parse is
    // indistinguishable here from one that reads only the first, and the
    // differential probe does not close the gap: a branch can depend on a field
    // neither probe supplies and still be FALSE in both of them
    // (`storageBucket?.startsWith(projectId + ".")` is true only for the real
    // project, whose bucket is named after it). So the variable is
    // all-or-nothing, like the legacy runtime config beside it.
    await withPrewrittenArtifact(
      [
        'const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}");',
        "exports.daily = endpoint();",
        "exports.daily.__endpoint.project = config.projectId;",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  itContained("exempts an artifact that reads the project id from GCLOUD_PROJECT", async () => {
    // The discrimination the case above used to carry, drawn where it belongs:
    // on whether this classifier can REPRODUCE the value. `discoveryEnvironment`
    // sets `GCLOUD_PROJECT` to the pinned project in both probes, which is the
    // id the deploy will pass, so a branch on it is rehearsed rather than
    // guessed at. This repository's own Functions index does exactly this, in
    // `visionGate.ts`'s `resolveProjectId`, to build its runtime service
    // account — watching the project id would make every `--only
    // functions:<endpoint>` deploy of this repo conservative and prove nothing.
    await withPrewrittenArtifact(
      [
        "exports.daily = endpoint();",
        "exports.daily.__endpoint.project = process.env.GCLOUD_PROJECT;",
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

  it("refuses a dependency that reads the legacy runtime config as it loads", async () => {
    // Barrier round on #1107: the loader-frame exemption waved through EVERY
    // read reached through a module load, on the reasoning that only the SDK's
    // own v1 `config.js` reads the value that way. Any dependency can do the
    // same — read it as it initialises and export what it found — and the
    // entrypoint then branches on a value this classifier cannot reproduce,
    // with a `require` frame standing between them. The exemption is the SDK's
    // alone; this read counts as a consultation.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/node_modules/config-reading-package/package.json": JSON.stringify({
            name: "config-reading-package",
            version: "0.0.0",
            main: "index.js",
          }),
          "functions/node_modules/config-reading-package/index.js":
            'exports.runtime = JSON.parse(process.env.CLOUD_RUNTIME_CONFIG || "{}");\n',
          "functions/lib/index.js": artifact(
            [
              'const dep = require("config-reading-package");',
              "exports.daily = dep.runtime.someLegacyNamespace",
              "  ? { submitBugReport: endpoint() }",
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

  itContained("exempts the SDK's own load-time read of the legacy runtime config", async () => {
    // The control for the rule above, and the reason it is not simply "every
    // load-time read is a consultation": `firebase-functions` reads
    // `CLOUD_RUNTIME_CONFIG` as it initialises, beneath the codebase's
    // top-level `require`, and refusing that would refuse every codebase that
    // imports the SDK.
    //
    // The reading package is installed at `functions/lib/node_modules`, which
    // Node resolves before `functions/node_modules`, so the read comes from a
    // file inside a `node_modules/firebase-functions` directory — the property
    // the exemption is keyed on — while the real SDK the discovery binary runs
    // from is left exactly where it is. (The pinned SDK no longer reads the
    // variable at all, so its own initialisation cannot stand in for itself.)
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/lib/node_modules/firebase-functions/package.json": JSON.stringify({
            name: "firebase-functions",
            version: "0.0.0",
            main: "index.js",
          }),
          "functions/lib/node_modules/firebase-functions/index.js":
            'exports.runtime = JSON.parse(process.env.CLOUD_RUNTIME_CONFIG || "{}");\n',
          "functions/lib/index.js": artifact(
            [
              'const sdk = require("firebase-functions");',
              "exports.daily = sdk.runtime.someLegacyNamespace",
              "  ? { submitBugReport: endpoint() }",
              "  : endpoint();",
            ].join("\n"),
          ),
        },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
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

  it("refuses a branch on FIREBASE_CONFIG that is false under BOTH probes", async () => {
    // Phase 4b P1 on #1107, and the case that motivates watching the variable
    // rather than trusting the differential probe with it. Agreement between the
    // probes is not independence from the configuration: the real bucket is
    // named after the project, so `storageBucket.startsWith(projectId + ".")` is
    // TRUE for every real project and FALSE both with no bucket at all and with
    // `firebase-deploy-scope-probe.appspot.com`. Both probes therefore report
    // the single endpoint, agree, and exempt a group.
    await withPrewrittenArtifact(
      [
        'const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}");',
        "const grouped = Boolean(",
        '  config.storageBucket && config.storageBucket.indexOf(config.projectId + ".") === 0,',
        ");",
        "exports.daily = grouped ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses the same branch taken through a firebase-admin app's options", async () => {
    // The same dependence, reached without touching `process.env` at all:
    // `initializeApp()` reads `FIREBASE_CONFIG` itself and hands the values back
    // as `app.options`, so the environment watch sees only firebase-admin's own
    // frame and waves it through. The options object is therefore wrapped in a
    // recording view of its own, and a read of one of the fields this classifier
    // could not supply is the same consultation as reading the variable.
    await withPrewrittenArtifact(
      [
        'const admin = require("firebase-admin");',
        "admin.initializeApp();",
        "const options = admin.app().options;",
        "const grouped = Boolean(",
        '  options.storageBucket && options.storageBucket.indexOf(options.projectId + ".") === 0,',
        ");",
        "exports.daily = grouped ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses a branch on a firebase-admin app's locationId", async () => {
    // Codex P1, round 26 on #1107. `adminSdkConfig` carries `locationId`, and
    // it was the one field the watched set forgot — which makes it the exact
    // shape the differential probe cannot settle on its own: the minimal probe
    // supplies none and the populated probe invents `us-central1`, so a
    // condition that matches the REAL project passes under neither. Both probes
    // report the single endpoint, agree, and exempt a group the deploy exports.
    // Reading a value this classifier cannot supply is the consultation; the
    // agreement is not evidence.
    await withPrewrittenArtifact(
      [
        'const admin = require("firebase-admin");',
        "admin.initializeApp();",
        "const options = admin.app().options;",
        'const grouped = options.locationId === "nam5";',
        "exports.daily = grouped ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses the same branch taken through the BACKING options object", async () => {
    // Codex P1, round 27 on #1107. `get options()` is `deepCopy(this.options_)`,
    // so the pinned firebase-admin keeps the real configuration in `options_` —
    // an own property of the app, reachable from the artifact. Watching only the
    // accessor left that alias unwatched, so the condition below matched the
    // real project while both synthetic probes read `undefined`, agreed on the
    // single endpoint, and exempted a scope whose deploy exports the group.
    await withPrewrittenArtifact(
      [
        'const admin = require("firebase-admin");',
        "admin.initializeApp();",
        'const grouped = admin.app().options_.locationId === "nam5";',
        "exports.daily = grouped ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses a branch reached through the accessor the watch shadows", async () => {
    // The second alias, and the reason shadowing is not removing: the own
    // property the watch defines hides `FirebaseApp.prototype`'s `options`
    // getter from `app.options`, and leaves it reachable through its
    // descriptor. Called against the app it answers with the same values,
    // uninstrumented, so the holder is guarded too.
    await withPrewrittenArtifact(
      [
        'const admin = require("firebase-admin");',
        "admin.initializeApp();",
        "const app = admin.app();",
        'const shadowed = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(app), "options");',
        'const grouped = shadowed.get.call(app).locationId === "nam5";',
        "exports.daily = grouped ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  it("refuses a branch on the credential firebase-admin holds a second time", async () => {
    // The third alias. `FirebaseApp`'s constructor hands `options_.credential`
    // to `FirebaseAppInternals`, which keeps it as `credential_` — so
    // `app.INTERNAL.credential_` is the ADC document this classifier gets from
    // the wrapper or not at all, read without touching `options` at all.
    await withPrewrittenArtifact(
      [
        'const admin = require("firebase-admin");',
        "admin.initializeApp();",
        "const held = admin.app().INTERNAL.credential_;",
        'const grouped = Boolean(held && held.projectId === "gaycruisebingo");',
        "exports.daily = grouped ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  itContained("still exempts a branch on the project id read through the backing object", async () => {
    // The control for the three cases above: the aliases are guarded per KEY,
    // exactly as `app.options` is, rather than refused wholesale. `projectId` is
    // deliberately outside `ADMIN_OPTION_KEYS` — it is the pinned project, the
    // same value in both probes and in the deploy — so a branch on it is
    // reproduced rather than guessed at, whichever alias it is read through.
    await withPrewrittenArtifact(
      [
        'const admin = require("firebase-admin");',
        "admin.initializeApp();",
        'const grouped = admin.app().options_.projectId === "not-this-project";',
        "exports.daily = grouped ? { submitBugReport: endpoint() } : endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      },
    );
  });

  it("reads an artifact's mutated options snapshot the way the real SDK does", async () => {
    // Codex P1, round 25 on #1107. `FirebaseApp`'s own `get options()` returns
    // `deepCopy(this.options_)`, so a write to one result is invisible to the
    // next read. The watch used to hand out ONE recording view over ONE
    // snapshot, which made a write to it persist — and the difference ran the
    // wrong way: the artifact below sees its `marker` in both rehearsal probes,
    // takes the single-endpoint branch in both, and is exempted, while
    // Firebase's uninstrumented discovery reads a fresh copy, finds no marker,
    // and exports the protected `daily-submitBugReport` group the exemption
    // just switched the invoker reconciliation off for.
    //
    // Neither `marker` nor the branch is a watched key, so nothing here is
    // recorded as a consultation: what is under test is that the REHEARSAL
    // agrees with an uninstrumented run, and the conservative answer below is
    // the surface Firebase itself would load.
    await withPrewrittenArtifact(
      [
        'const admin = require("firebase-admin");',
        "admin.initializeApp();",
        "const snapshot = admin.app().options;",
        "snapshot.marker = true;",
        "exports.daily = admin.app().options.marker",
        "  ? endpoint()",
        "  : { submitBugReport: endpoint() };",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(
          ALL_INVOKERS_CONSERVATIVE,
        );
      },
    );
  });

  itContained("exempts an artifact that only initialises firebase-admin", async () => {
    // The control for both cases above, and the reason the admin watch is on the
    // OPTIONS rather than on `initializeApp` itself: this repository's own
    // Functions index calls it and reads nothing back, and `initializeApp`'s own
    // read of `FIREBASE_CONFIG` is the SDK configuring itself. Without this, the
    // refusals above would pass for a fixture that could never have been exempt.
    await withPrewrittenArtifact(
      [
        'const admin = require("firebase-admin");',
        "admin.initializeApp();",
        "exports.daily = endpoint();",
      ].join("\n"),
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
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

  itContained("exempts a codebase-qualified endpoint proven in that same codebase", async () => {
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

  itContained("does not load a codebase this deploy will not discover", async () => {
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

  itContained("exempts when the neighbouring codebase's hook leaves the artifact alone", async () => {
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

  itContained("does not let another codebase veto an unqualified default-codebase proof", async () => {
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

  itContained("does not let one codebase's unreadable source poison a qualified proof in another", async () => {
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

  itContained("allows a hyphenated CODEBASE while still refusing a hyphenated endpoint id", async () => {
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

  itContained("accepts an explicitly declared Node runtime", async () => {
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
          {
            defaultConfigPath: configPath,
            establishedCredentialPath: establishedCredential,
            predeployTimeoutMs: 250,
          },
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

  itContained("exempts the same codebase when its configDir carries no such flag", async () => {
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

  itContained("leaves the live firebase.json alone when a hook overwrites it", async () => {
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
          {
            defaultConfigPath: configPath,
            establishedCredentialPath: establishedCredential,
          },
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

  itContained("hides its own preload from the codebase", async () => {
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

  itContained("leaves no trace of its discovery preload in the module system", async () => {
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

  itContained("ABORTS when a write through the overlay reaches the checkout", async () => {
    // Only the Functions sources are copied; every other project directory is a
    // symlink to the live tree, so a write through the overlay — here a toggle
    // whose second run differs from its first — mutates the real checkout AFTER
    // the dirty-tree guard has passed (Codex P2, round 17).
    //
    // Answering that with a conservative classification was still wrong: the
    // classification SUCCEEDS, so the build and the publish below it go ahead
    // and ship whatever was just written into tracked source (Codex P1, round
    // 18). Detected mutation is fatal, and it names the path.
    //
    // The writer is the PARENT process, through the `onStaged` seam, and it used
    // to be a predeploy hook. Round 28's containment denies the live checkout to
    // every process this classifier starts — including on a fixture under the
    // system temp dir, which is where this one is — so a hook can no longer
    // reach this route at all, and the case that proves the hook is stopped is
    // "denies a hook's write into a checkout under the system temp dir" below.
    // What is left for the fingerprint is the uncontained writer: the parent,
    // another window, a worker that was already running. The route and the
    // assertion are unchanged; only who takes it is.
    await withFunctionsProject(
      { functionsConfig: { predeploy: PREDEPLOY }, files: { "shared/toggle": "" } },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ scratchProject }) =>
            appendFile(join(scratchProject, "shared", "toggle"), "x"),
        }).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("shared/toggle");
        expect(failure.message).toContain("Nothing has been restored");
      },
    );
  });

  itContained("exits with the live-checkout-drift status through the production wrapper", async () => {
    // The status `deploy.sh` reads. It is distinct from the invalid-request
    // status precisely because the request was valid: it is the TREE that is no
    // longer the one the clean-tree guard approved.
    //
    // `main()` is the production entry point and it passes no seam — that is
    // the point of `onStaged` being an argument — so the drift here is produced
    // the way a real one now has to be: by a process the classifier did not
    // start. The hook stops at a gate, this test writes into the checkout while
    // it is stopped there, and the post-hook fingerprint finds it. Before round
    // 28 the hook wrote it itself; the containment denies that now (see
    // `openHookGate`), and the status this asserts is unchanged.
    const gate = await openHookGate();
    try {
      await withFunctionsProject(
        {
          functionsConfig: { predeploy: [...PREDEPLOY, gate.command] },
          files: { "shared/toggle": "" },
        },
        async (configPath) => {
          const checkout = dirname(configPath);
          const run = await whileAHookWaits(
            gate,
            () =>
              runClassifierWrapper(
                configPath,
                ["--only", "functions:daily"],
                DEPLOY_SH_CLASSIFIER_ENV(configPath),
              ).then((finished) => {
                // `whileAHookWaits` reads a REJECTION as the outcome; the
                // wrapper answers with an exit status instead, so hand it back
                // through the same channel.
                throw finished;
              }),
            () => appendFile(join(checkout, "shared", "toggle"), "x"),
          );
          expect(run.code).toBe(3);
          expect(run.output).toContain("mutated the live checkout");
          expect(run.output).toContain("shared/toggle");
          expect(run.output).toContain("NOTHING HAS BEEN BUILT OR PUBLISHED");
          // And no classification reached stdout for `deploy.sh` to parse.
          expect(run.output).not.toContain("FUNCTIONS_ATTEMPTED=");
        },
      );
    } finally {
      await gate.close();
    }
  });

  itContained("still exempts when that same write lands inside the staged source dir", async () => {
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

  itContained("ABORTS when the checkout changes while the artifact is LOADING", async () => {
    // The live tree is checked AGAIN once every codebase has been discovered,
    // because discovery runs after the hooks have been cleared and the post-hook
    // check can no longer speak for it. That check is fatal for the same reason
    // the post-hook one is.
    //
    // The write used to come from the artifact's own module scope, which reached
    // the overlay's symlinks the way a hook does. Round 28's containment denies
    // the checkout to the discovery process too, so the artifact now only STOPS
    // there — at the same gate a hook uses — and the uncontained writer is this
    // test. That keeps the window exactly where the case needs it: after the
    // hooks, inside discovery, where only the post-discovery check is left.
    const gate = await openHookGate();
    try {
      await withFunctionsProject(
        {
          functionsConfig: { predeploy: [] },
          files: {
            "shared/toggle": "",
            "functions/lib/index.js": artifact(
              [gate.javascript, "exports.daily = endpoint();"].join("\n"),
            ),
          },
        },
        async (configPath) => {
          const checkout = dirname(configPath);
          const failure = await whileAHookWaits(
            gate,
            () => classify(["--only", "functions:daily"], configPath),
            () => appendFile(join(checkout, "shared", "toggle"), "x"),
          );
          expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
          expect(failure.message).toContain("shared/toggle");
        },
      );
    } finally {
      await gate.close();
    }
  });

  itContained("keeps its own environment out of the predeploy hooks it runs", async () => {
    // `deploy.sh` passes the pinned project, config path, override policy and
    // output format to the classifier and to NOTHING else, so a hook run from
    // here would see variables its real run cannot (Codex P2, round 17).
    await withFunctionsProject(ENV_SNIFFING_FIXTURE, async (configPath) => {
      await withEnv(DEPLOY_SH_CLASSIFIER_ENV(configPath), async () => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
      });
    });
  });

  itContained("keeps it out of the hooks the production wrapper runs too", async () => {
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

  itContained("keeps its own environment out of the discovery processes", async () => {
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

  itContained.each([["./functions"], ["functions/"]])(
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
  itContained("keeps a relative source symlink pointing inside the staged copy", async () => {
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

  itContained("runs an IMPORTED target config's predeploy hooks too", async () => {
    // Barrier round on #1107: `firebase.json` may externalise a target —
    // `"firestore": "firestore.config.json"` — and the pinned CLI materialises
    // that file in `Config`'s constructor (`MATERIALIZE_TARGETS`) long before
    // `lifecycleHooks` reads `options.config.get(target)`. Planning from the
    // RAW source handed the planner a string, whose `predeploy` is `undefined`,
    // so the imported hooks were left out of the rehearsal entirely and ran for
    // real. The assertion is therefore that the imported hook RAN.
    //
    // It used to prove that by writing through the overlay into the live
    // checkout, whose drift is fatal. Round 28's containment denies the checkout
    // to every hook, so the proof is now the direct one: the hook leaves a mark
    // in a temp directory of its own — outside the checkout, and therefore
    // inside what the containment still allows a hook to write — and this
    // asserts the mark. That says the same thing about the planner one step
    // sooner, without borrowing the drift guard to say it.
    const evidence = await mkdtemp(join(tmpdir(), "imported-hook-ran-"));
    try {
      const mark = join(evidence, "ran");
      await withFunctionsProject(
        {
          functionsConfig: { predeploy: [] },
          config: { firestore: "firestore.config.json" },
          files: {
            "firestore.config.json": JSON.stringify({
              rules: "firestore.rules",
              predeploy: [`printf ran > '${mark}'`],
            }),
            "firestore.rules": "rules_version = '2';\n",
            "functions/lib/index.js": artifact("exports.daily = endpoint();"),
          },
        },
        async (configPath) => {
          expect(await classify(["--only", "functions:daily,firestore"], configPath)).toMatchObject(
            EXEMPT,
          );
          expect(existsSync(mark)).toBe(true);
        },
      );
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });

  itContained("still proves the endpoint when an imported target config carries no hooks", async () => {
    // The control: materialising the imported file is not itself a reason to
    // forfeit. Same externalised Firestore target, no `predeploy` in it.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        config: { firestore: "firestore.config.json" },
        files: {
          "firestore.config.json": JSON.stringify({ rules: "firestore.rules" }),
          "firestore.rules": "rules_version = '2';\n",
          "functions/lib/index.js": artifact("exports.daily = endpoint();"),
        },
      },
      async (configPath) => {
        expect(
          await classify(["--only", "functions:daily,firestore"], configPath),
        ).toMatchObject(EXEMPT);
      },
    );
  });

  // `-p, --public <path>` overrides the Hosting public directory, and
  // `deploy/hosting/prepare.js`'s `handlePublicDirectoryFlag` writes that
  // override into `options.config` from `hasPinnedFunctions`, which
  // `deploy/index.js` calls BEFORE it chains a single predeploy hook. So the
  // Hosting hook's `$RESOURCE_DIR` — `config.path(config.public ?? config.source)`
  // — is the overridden directory during the real deploy. Planning the hook
  // from `firebase.json` alone let this one read one directory in the
  // rehearsal and the other in the deploy (Codex P1, round 23 on #1107).
  const publicOverrideFixture = {
    functionsConfig: { predeploy: [] },
    config: {
      hosting: {
        public: "public",
        // Which directory the hook READ decides which artifact it leaves, so
        // the classification below is an assertion about `$RESOURCE_DIR`.
        // Written without nested quotes: `runCommand` escapes only `"`, so a
        // `"` inside a `$(…)` reaches the hook as a literal character — the
        // pinned CLI's own quoting, mirrored byte for byte.
        predeploy: [
          'grep -q override "$RESOURCE_DIR/which" ' +
            "&& cp functions/group.js functions/lib/index.js " +
            "|| cp functions/single.js functions/lib/index.js",
        ],
      },
    },
    files: {
      "public/which": "configured",
      "other/which": "override",
      "functions/lib/index.js": artifact("exports.placeholder = 1;"),
      "functions/group.js": artifact("exports.daily = { grouped: endpoint() };"),
      "functions/single.js": artifact("exports.daily = endpoint();"),
    },
  };

  it("runs the Hosting hook against the directory --public overrides to", async () => {
    await withFunctionsProject(publicOverrideFixture, async (configPath) => {
      expect(
        await classify(
          ["--only", "functions:daily,hosting", "--public", "other"],
          configPath,
        ),
      ).toMatchObject({ hostingAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
    });
  });

  it("accepts every spelling of --public the pinned CLI accepts", async () => {
    // The pinned CLI parses on commander 5, where `--public=other` and the
    // attached short form `-pother` are both that path. This classifier parses
    // on the root commander, which splits an attached short flag into single
    // letters unless it is normalized first — the same normalization `-P` and
    // `-c` already get.
    for (const spelling of [["--public=other"], ["-p", "other"], ["-pother"]]) {
      await withFunctionsProject(publicOverrideFixture, async (configPath) => {
        expect(
          await classify(["--only", "functions:daily,hosting", ...spelling], configPath),
        ).toMatchObject({ hostingAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
      });
    }
  });

  itContained("leaves the configured public directory alone when no --public is given", async () => {
    // The control: the same fixture, the same selector, and the hook reading
    // `firebase.json`'s own `public` — which is what makes the case above an
    // assertion about the override rather than about the hook running at all.
    await withFunctionsProject(publicOverrideFixture, async (configPath) => {
      expect(
        await classify(["--only", "functions:daily,hosting"], configPath),
      ).toMatchObject({ hostingAttempted: true, ...EXEMPT });
    });
  });

  itContained("refuses --public against a multi-site Hosting configuration, as the CLI does", async () => {
    // `handlePublicDirectoryFlag` throws for an ARRAY `hosting` — there is no
    // one site to override — so the deploy never starts. Mirrored as a refusal
    // rather than modelled: a request the pinned CLI rejects must not be built
    // for. The second half is the CLI's own scoping: the flag is only ever read
    // when Hosting is one of the deployed targets, so it is inert here.
    const multiSite = {
      config: {
        hosting: [
          { target: "app", public: "public" },
          { target: "docs", public: "docs" },
        ],
      },
      functionsConfig: { predeploy: [] },
      files: {
        "public/index.html": "",
        "docs/index.html": "",
        "other/index.html": "",
        "functions/lib/index.js": artifact("exports.daily = endpoint();"),
      },
    };
    await withFunctionsProject(multiSite, async (configPath) => {
      await expect(
        classify(["--only", "functions:daily,hosting", "--public", "other"], configPath),
      ).rejects.toThrow("Cannot specify --public option with multi-site configuration");
      expect(
        await classify(["--only", "functions:daily", "--public", "other"], configPath),
      ).toMatchObject({ hostingAttempted: false, ...EXEMPT });
    });
  });

  // A Hosting config written with `source` rather than `public` is a WEB
  // FRAMEWORK deploy, and `deploy/index.js` handles it at the very top of the
  // deploy: `prepareFrameworks("deploy", …)` runs ahead of `hasPinnedFunctions`,
  // ahead of the `--public` override above, and ahead of the first predeploy
  // hook. It runs the app's own framework build, sets `hosting.public` to the
  // generated directory and, for an SSR framework, appends a Functions codebase
  // to the deploy's config. So the hooks rehearsed here are not the hooks the
  // deploy runs, the `$RESOURCE_DIR` a Hosting hook would get is not the one it
  // will get, and a Functions artifact can have been rewritten before any of it
  // starts. None of that is reproducible, so the whole project is refused
  // (Codex P1, round 26 on #1107).
  const webFrameworkFixture = (hosting) => ({
    functionsConfig: { predeploy: [] },
    config: { hosting },
    files: {
      "web/package.json": JSON.stringify({ name: "web", private: true }),
      "public/index.html": "",
      "functions/lib/index.js": artifact("exports.daily = endpoint();"),
    },
  });

  it("refuses the whole project when a selected Hosting config builds from source", async () => {
    await withFunctionsProject(webFrameworkFixture({ source: "web" }), async (configPath) => {
      const { result, reasons } = await withRefusalReasons(() =>
        classify(["--only", "functions:daily,hosting"], configPath),
      );
      expect(result).toMatchObject({ hostingAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
      expect(reasons).toContain("prepareFrameworks");
    });
  });

  itContained("leaves a plain public Hosting config exempt", async () => {
    // The control, and the reason the refusal above is attributable to the
    // framework shape: the same fixture and the same selector with a `public`
    // directory instead runs no framework build, so nothing about the hooks
    // moves and the single endpoint is still provable.
    await withFunctionsProject(webFrameworkFixture({ public: "public" }), async (configPath) => {
      expect(
        await classify(["--only", "functions:daily,hosting"], configPath),
      ).toMatchObject({ hostingAttempted: true, ...EXEMPT });
    });
  });

  itContained("ignores a framework Hosting config this request does not deploy", async () => {
    // The CLI's own scoping, mirrored: `isDeployingWebFramework` is consulted
    // only behind `targetNames.includes("hosting")`, so a Functions-only scope
    // never reaches `prepareFrameworks` and must not be refused for a config it
    // will not touch.
    await withFunctionsProject(webFrameworkFixture({ source: "web" }), async (configPath) => {
      expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject({
        hostingAttempted: false,
        ...EXEMPT,
      });
    });
  });

  // THE DEPLOY CREDENTIAL. `lifecycleHooks.getChildEnvironment` hands a hook the
  // wrapper's own `process.env`, in which `GOOGLE_APPLICATION_CREDENTIALS`
  // points at the ADC document `op-firebase-deploy` has just established. The
  // rehearsal used to write a SYNTHETIC document of the same shape instead — an
  // `impersonated_service_account` for an obviously fake account — while the
  // documented path gives that wrapper the target service account directly and
  // so establishes a `service_account` carrying the real `client_email`. A hook
  // that merely inspects the JSON therefore took one branch here and the other
  // for real, with nothing failing and nothing drifting to say so (Codex P1,
  // round 26 on #1107). The hooks now run against the document a wrapper NAMES,
  // or the exemption is refused.
  const credentialSniffingFixture = {
    functionsConfig: {
      predeploy: [
        'grep -q impersonated_service_account "$GOOGLE_APPLICATION_CREDENTIALS" ' +
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

  itContained("runs a hook that reads the ADC document against the document a wrapper named", async () => {
    // The wrapper's documented default: the source credential IS the target
    // service account, so `op-firebase-deploy` writes that document straight
    // through and the hook sees `service_account`.
    await withFunctionsProject(credentialSniffingFixture, async (configPath) => {
      await withEstablishedCredential(ESTABLISHED_CREDENTIAL_DOCUMENT, async (path) => {
        expect(
          await classify(["--only", "functions:daily"], configPath, {
            establishedCredentialPath: path,
          }),
        ).toMatchObject(EXEMPT);
      });
    });
  });

  it("takes the other branch when the wrapper established an impersonated document", async () => {
    // The same hook and the same fixture against the wrapper's OTHER documented
    // output — the impersonation wrapper it writes when the source credential is
    // not the target service account. Together with the case above this is the
    // whole claim: the branch follows the supplied document, so no synthetic
    // stand-in is deciding it.
    await withFunctionsProject(credentialSniffingFixture, async (configPath) => {
      await withEstablishedCredential(
        {
          type: "impersonated_service_account",
          service_account_impersonation_url:
            "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
            "firebase-deployer@fiveacross.iam.gserviceaccount.com:generateAccessToken",
          source_credentials: { type: "authorized_user" },
        },
        async (path) => {
          expect(
            await classify(["--only", "functions:daily"], configPath, {
              establishedCredentialPath: path,
            }),
          ).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
        },
      );
    });
  });

  it("refuses every exemption when no wrapper established a deploy credential", async () => {
    // The standalone caller, a dry run, and this repository's own
    // deployment-safety harness all land here, and so does `deploy.sh`: that
    // wrapper cannot name the document, because `op-firebase-deploy` mints it
    // inside its own process immediately before `firebase deploy` and deletes
    // it in its own EXIT trap. Conservative is the answer, never a synthetic
    // substitute.
    await withFunctionsProject({}, async (configPath) => {
      const { result, reasons } = await withRefusalReasons(() =>
        classify(["--only", "functions:daily"], configPath, {
          establishedCredentialPath: null,
        }),
      );
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      expect(reasons).toContain("no established deploy credential");
    });
  });

  it("refuses when the named deploy credential is not there to read", async () => {
    // Naming a document is an assertion that the deploy's hooks will read it.
    // One that cannot be read is not that assertion, and guessing which way it
    // would have gone is the mistake the synthetic document made.
    await withFunctionsProject({}, async (configPath) => {
      const { result, reasons } = await withRefusalReasons(() =>
        classify(["--only", "functions:daily"], configPath, {
          establishedCredentialPath: join(tmpdir(), "no-such-adc-document.json"),
        }),
      );
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      expect(reasons).toContain("could not be read");
    });
  });

  itContained("answers a git branch lookup the way the deployment will", async () => {
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

  it("refuses a firebase.json below the checkout root before its first hook runs", async () => {
    // Phase 4b P1 on #1107. Every guard here starts from the CONFIGURED project
    // directory: `stageProjectOverlay` stages that directory, and
    // `liveTreeFingerprint` watches exactly what the staging exposed. With `-c
    // deploy/firebase.json` the deploy's inputs are the whole checkout while the
    // watched set is only `deploy/`, so a hook that reaches the checkout root
    // through an inherited `$INIT_CWD` rewrites application source outside every
    // watched directory and outside everything `git` answers — no fingerprint
    // moves, classification succeeds, and `deploy.sh` carries on into a build
    // that packages a file written after its clean-tree guard passed.
    //
    // So the LAYOUT is the refusal, and it has to be reached before anything
    // runs: a conservative answer produced after the hook is an answer produced
    // after the write. The hook below writes a sentinel into the checkout root,
    // which must never appear, and the refusal reason must name the layout
    // rather than anything the hook did.
    await withFunctionsProject(
      {
        projectSubdir: "deploy",
        branch: "release",
        functionsConfig: {
          predeploy: [...PREDEPLOY, 'printf ran > "$INIT_CWD/hook-ran"'],
        },
        files: { "functions/lib/index.js": artifact("exports.placeholder = 1;") },
      },
      async (configPath) => {
        const checkout = resolve(dirname(configPath), "..");
        const previous = process.env.INIT_CWD;
        process.env.INIT_CWD = checkout;
        try {
          const { result, reasons } = await withRefusalReasons(() =>
            classify(["--only", "functions:daily"], configPath),
          );
          expect(result).toMatchObject({
            functionsAttempted: true,
            ...ALL_INVOKERS_CONSERVATIVE,
          });
          expect(reasons).toContain("sits below the repository root");
          expect(existsSync(join(checkout, "hook-ran"))).toBe(false);
        } finally {
          if (previous === undefined) delete process.env.INIT_CWD;
          else process.env.INIT_CWD = previous;
        }
      },
    );
  });

  itContained("leaves a checkout-ROOTED project at the repository root it already had", async () => {
    // The control for the case above: a `firebase.json` AT the checkout root
    // has `.git` as an entry of its own project directory, the staged set is
    // the whole repository, and the exemption stands. Written through both
    // `--show-prefix` and `--show-toplevel` so that refusing the nested layout
    // cannot be mistaken for refusing every repository.
    await withFunctionsProject(
      {
        branch: "release",
        functionsConfig: {
          predeploy: [
            'test "$(git rev-parse --show-prefix)" = "" ' +
              '&& test -f "$(git rev-parse --show-toplevel)/firebase.json" ' +
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

  itContained("ABORTS when something changes what the repository answers", async () => {
    // The other half of exposing `.git`: the view is live, so a write through it
    // changes what the repository answers. The guard is on what `git` ANSWERS
    // rather than on the files under `.git`, because that is the property a
    // build can observe — and because a file-level watch reports drift for a
    // background fetch's FETCH_HEAD, which no build has ever branched on.
    //
    // Fatal, not conservative (Phase 4b P1, round 19): `vite.config.ts` stamps
    // the bundle from `git rev-parse HEAD` during BUILD_CMD, so metadata that
    // moved after the approved-checkout guards is a deployment input that
    // changed, and the deploy must stop the same way tree drift stops it.
    //
    // Through `onStaged` rather than a predeploy hook since round 28: `.git` is
    // exposed as a symlink INTO the checkout, so the containment denies it to
    // every hook, whether the checkout lies under the system temp dir (as this
    // fixture does) or anywhere else. The writer the guard is still for is the
    // uncontained one — here a `git` this test runs, which is exactly the
    // background checkout or fetch the guard was written for.
    await withFunctionsProject(
      { branch: "release", functionsConfig: { predeploy: PREDEPLOY } },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ projectDir }) => gitIn(projectDir, ["checkout", "-q", "-b", "rewritten"]),
        }).then(
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

  itContained("ABORTS when a write lands THROUGH a symlink inside a linked directory", async () => {
    // A linked project directory can hold a symlink back to a ROOT deployment
    // input — a file the overlay copies rather than links, so the live copy
    // sits under no walked directory. Fingerprinting only the link's own inode
    // would let a write pass through it — replacing firebase.json, say — with
    // no watched path changing (Phase 4b / Codex P1, round 20). The target is
    // fingerprinted under the link, so the write reads as drift on the link
    // that reached it, and the message names that link.
    //
    // The write comes through `onStaged` rather than from a predeploy hook since
    // round 28: this route resolves INTO the checkout, and the containment
    // canonicalises the path before it matches, so a contained hook is refused
    // whichever link it goes through. The route being fingerprinted is what this
    // case is about, and the parent takes the identical one.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: PREDEPLOY },
        files: { "toggle.txt": "", "tools/.keep": "" },
        links: { "tools/config-link": "../toggle.txt" },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ scratchProject }) =>
            appendFile(join(scratchProject, "tools", "config-link"), "x"),
        }).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("tools/config-link");
        expect(failure.message).toContain("Nothing has been restored");
      },
    );
  });

  itContained("ABORTS when a file is overwritten THROUGH a directory-valued symlink", async () => {
    // Codex P1, round 13: overwriting an EXISTING file through a link whose
    // target is a directory moves neither the link nor the directory's mtime,
    // so the target's metadata alone would let the write through. The target
    // directory is walked under the link, so the file it reaches is drift.
    //
    // Through `onStaged` for the reason the case above it states: the route ends
    // in the checkout, which round 28's containment denies to every hook, so the
    // writer that is left for this guard is an uncontained one.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: PREDEPLOY },
        files: { "config/app.txt": "x", "tools/.keep": "" },
        links: { "tools/config-link": "../config" },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ scratchProject }) =>
            writeFile(join(scratchProject, "tools", "config-link", "app.txt"), "y"),
        }).then(
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

  it("refuses a hook's descendant that detached into a session of its own, and ends it", async () => {
    // Phase 4b, run 6 on #1107: `spawn(..., { detached: true, stdio: "ignore" })`
    // calls `setsid`, so the child sits in a session no group signal reaches.
    // The group probe found nothing, the hook looked clean, and the escapee ran
    // on into the build that follows — where the live-tree fingerprint is no
    // longer watching. Every process a rehearsal starts now carries a marker,
    // and the sweep at the end of each rehearsal finds it by that.
    //
    // The escapee would write into the live checkout through the overlay's
    // `shared` symlink two and a half seconds later, so the file below is the
    // proof that it was actually ended and not merely noticed.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [...PREDEPLOY, "node escapee.js"] },
        files: {
          "shared/toggle": "",
          "escapee.js": [
            'const { spawn } = require("node:child_process");',
            'const marker = require("node:path").join(__dirname, "shared", "toggle");',
            "spawn(",
            "  process.execPath,",
            "  [",
            '    "-e",',
            "    \"setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'x'), 2500)\",",
            "    marker,",
            "  ],",
            '  { detached: true, stdio: "ignore" },',
            ").unref();",
          ].join("\n"),
        },
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
        await new Promise((settle) => setTimeout(settle, 4_000));
        await expect(
          readFile(join(dirname(configPath), "shared", "toggle"), "utf8"),
        ).resolves.toBe("");
      },
    );
  });

  it("ends a detached writer left by a hook that then FAILS", async () => {
    // Codex P1, round 20 on #1107. The sweep ran at the END of a clean
    // rehearsal step, and a hook that FAILS returns before it: the failure
    // branch answered conservatively and left the escapee alive. The failure
    // does not have to be about the escapee at all — a hook that authenticates
    // against the synthetic ADC fails for a reason the real deploy will not
    // have — so `deploy.sh` accepts the conservative classification and carries
    // on, while the detached writer alters a deployment input two and a half
    // seconds later, after the clean-tree guard and after the last fingerprint
    // that was watching.
    //
    // The hook below detaches the writer into its own session and THEN exits
    // nonzero. The file is the proof: unwritten, the escapee was ended rather
    // than merely noticed.
    //
    // The writer resolves its target to the LIVE absolute path before it is
    // detached, which is the shape the finding describes and the only shape
    // that proves anything here: a path spelled through the scratch project's
    // own symlink dies with the scratch directory, so a deferred write through
    // one fails whether or not the escapee was ended.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [...PREDEPLOY, "node escapee-then-fail.js"] },
        files: {
          "shared/toggle": "",
          "escapee-then-fail.js": [
            'const { spawn } = require("node:child_process");',
            'const { join } = require("node:path");',
            // The overlay's `shared` symlink points into the live checkout, so
            // one `realpath` buys an absolute path that outlives the rehearsal
            // — as an inherited `$INIT_CWD` does for a hook launched by npm.
            'const live = require("node:fs").realpathSync(join(__dirname, "shared"));',
            'const marker = join(live, "toggle");',
            "spawn(",
            "  process.execPath,",
            "  [",
            '    "-e",',
            "    \"setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'x'), 2500)\",",
            "    marker,",
            "  ],",
            '  { detached: true, stdio: "ignore" },',
            ").unref();",
            // The hook's own failure, unrelated to what it just detached.
            "process.exit(1);",
          ].join("\n"),
        },
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
        await new Promise((settle) => setTimeout(settle, 4_000));
        await expect(
          readFile(join(dirname(configPath), "shared", "toggle"), "utf8"),
        ).resolves.toBe("");
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

  // Codex P1, round 26 on #1107: `fs.cp`'s `preserveTimestamps` covers FILES.
  // Under this repository's Node every DIRECTORY the copy creates carries the
  // moment the copy created it, so a hook that makes its incremental decision
  // from a directory's mtime — the directory-level form of the file comparisons
  // rounds 17 and 19 already fixed — saw a past-dated `$RESOURCE_DIR` during the
  // deploy and a freshly stamped one here. The staging restores every copied
  // directory's timestamps from its live original, deepest-first.
  //
  // The hook is the whole predeploy, with a prewritten artifact and no build, so
  // nothing writes into `$RESOURCE_DIR` between the restore and the comparison.
  const directoryMtimeFixture = {
    functionsConfig: {
      predeploy: [
        'if [ "$RESOURCE_DIR" -ot "$PROJECT_DIR/stamp" ]; then cp "$RESOURCE_DIR/group.js" "$RESOURCE_DIR/lib/index.js"; fi',
      ],
    },
    files: {
      stamp: "",
      "functions/lib/index.js": artifact("exports.daily = endpoint();"),
      "functions/group.js": artifact("exports.daily = { submitBugReport: endpoint() };"),
    },
  };

  it("rehearses a directory-mtime incremental hook against the live timestamps", async () => {
    await withFunctionsProject(directoryMtimeFixture, async (configPath) => {
      const { utimes } = await import("node:fs/promises");
      const past = new Date(Date.now() - 3_600_000);
      await utimes(join(dirname(configPath), "functions"), past, past);
      expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject({
        functionsAttempted: true,
        bugReportInvokerSelected: true,
      });
    });
  });

  itContained("still exempts that hook when the live directory is the newer one", async () => {
    // The control, and the reason the case above is attributable to the
    // restored directory mtime rather than to the hook always grouping: the
    // same fixture with the STAMP past-dated instead leaves `$RESOURCE_DIR`
    // newer, the copy never happens, and the single endpoint stays provable.
    await withFunctionsProject(directoryMtimeFixture, async (configPath) => {
      const { utimes } = await import("node:fs/promises");
      const past = new Date(Date.now() - 3_600_000);
      await utimes(join(dirname(configPath), "stamp"), past, past);
      expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
    });
  });

  itContained.each([
    ["the copied Functions source", "functions/src/index.ts"],
    ["a copied project-root file", "firebase.json"],
  ])("ABORTS when %s is written through an absolute live path", async (_label, target) => {
    // Codex P1, round 15: the overlay COPIES the Functions source and the
    // project-root files, so no relative path from the scratch project reaches
    // their live originals — but an absolute path does, and a hook launched
    // through npm inherits `INIT_CWD` pointing at the live repository. The
    // copied inputs' live originals are fingerprinted too, so the write is
    // drift.
    //
    // The absolute route is now closed to a hook: round 28's containment denies
    // the checkout by resolved path, so `$INIT_CWD/...` is refused as flatly as
    // a relative one, and "denies a hook's write into a checkout under the
    // system temp dir" is where that is pinned. What this still has to pin is
    // that the COPIED inputs' live originals are watched at all, which is a
    // property of the fingerprint and not of who wrote — so the write comes from
    // the parent through `onStaged`, at the same absolute path.
    await withFunctionsProject(
      { functionsConfig: { predeploy: PREDEPLOY } },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ projectDir }) => appendFile(join(projectDir, target), "x"),
        }).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain(target.split("/").pop());
        expect(failure.message).toContain("Nothing has been restored");
      },
    );
  });

  itContained("ABORTS when a Functions source is edited while the staging is copying", async () => {
    // Codex P1, round 25 on #1107. The post-staging baseline is what every
    // later drift check compares against, so an edit landing between the copy
    // reading a file and that baseline being taken was accepted AS the
    // unchanged starting state — while the scratch project still held the
    // pre-edit bytes. Every later fingerprint then matched, nothing looked like
    // drift, and the inventory could prove a selector exact for a checkout that
    // is no longer the tree `deploy.sh`'s clean-tree guard approved. The
    // staging is therefore bracketed: the watched tree is fingerprinted before
    // the copy as well as after, and the two must be identical.
    //
    // `onStaged` is that window, reached the way `writeContainment` is — an
    // argument `main()` never passes, so no shell can be the writer here — and
    // it can only ever make this classifier answer more conservatively.
    await withFunctionsProject({}, async (configPath) => {
      const { dirname: dir, join: under } = await import("node:path");
      const { appendFile } = await import("node:fs/promises");
      const failure = await classify(["--only", "functions:daily"], configPath, {
        onStaged: () =>
          appendFile(under(dir(configPath), "functions", "src", "index.ts"), "\n// edited\n"),
      }).then(
        () => null,
        (error) => error,
      );
      expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
      expect(failure.message).toContain("index.ts");
      expect(failure.message).toContain("Nothing has been restored");
    });
  });

  itContained("proves the same scope when nothing writes while the staging is copying", async () => {
    // The control for the case above, and for the bracket generally: a checkout
    // that simply holds still must still be provable, and the `onStaged` seam
    // itself must change nothing when it writes nothing. Without this, the
    // refusal above would pass for a bracket that refused every deploy.
    await withFunctionsProject({}, async (configPath) => {
      expect(
        await classify(["--only", "functions:daily"], configPath, { onStaged: () => {} }),
      ).toMatchObject(EXEMPT);
    });
  });

  itContained("ABORTS when a remote-tracking ref moves before the staging even starts", async () => {
    // Codex P1, round 26 on #1107. The first Git-answer baseline used to be
    // taken after the write containment had been proved and after the whole
    // staging copy — seconds of this classifier's own setup during which a
    // background fetch can advance `origin/main`. That fetch BECAME the
    // baseline, every later metadata check compared against it and passed, and
    // the exemption was granted although `deploy.sh`'s `HEAD == origin/main`
    // guard no longer held. The answers are read first now, and compared once
    // the staging is done.
    //
    // `afterContainment` is that window, reached the way `onStaged` reaches the
    // staging one: an argument `main()` never passes, so no shell can be the
    // writer here, and everything it can do is something a guard is there to
    // catch.
    await withFunctionsProject({ branch: "release" }, async (configPath) => {
      const failure = await classify(["--only", "functions:daily"], configPath, {
        afterContainment: () =>
          gitIn(dirname(configPath), ["update-ref", "refs/remotes/origin/main", "HEAD"]),
      }).then(
        () => null,
        (error) => error,
      );
      expect(failure).toBeInstanceOf(RepositoryMetadataDriftError);
      expect(failure.message).toContain("refs/remotes/origin/main");
    });
  });

  itContained("proves the same scope when nothing moves in that window", async () => {
    // The control for the bracket above and for the seam itself: a repository
    // that holds still must still be provable, or the refusal would pass for a
    // bracket that refused every deploy.
    await withFunctionsProject({ branch: "release" }, async (configPath) => {
      expect(
        await classify(["--only", "functions:daily"], configPath, { afterContainment: () => {} }),
      ).toMatchObject(EXEMPT);
    });
  });

  itContained("ABORTS when a hook writes THROUGH a copied root file that is a symlink", async () => {
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

  itContained("ABORTS when a remote-tracking ref moves during the rehearsal", async () => {
    // Codex P1, round 18: a `git fetch` advances refs/remotes/origin/main
    // without touching HEAD, the branch or the nearest tag, and the wrapper's
    // approved-checkout guard asked whether HEAD equals origin/main BEFORE the
    // rehearsal. Every remote-tracking ref is part of what git answers now.
    //
    // The mover is the parent through `onStaged` rather than a predeploy hook:
    // round 28's containment denies `.git`, which the overlay exposes as a
    // symlink into the checkout, so the fetch this guard was always written for
    // is the background one — and that one is uncontained by definition.
    await withFunctionsProject(
      { branch: "release", functionsConfig: { predeploy: PREDEPLOY } },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ projectDir }) =>
            gitIn(projectDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]),
        }).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(RepositoryMetadataDriftError);
        expect(failure.message).toContain("refs/remotes/origin/main");
      },
    );
  });

  itContained("ABORTS when a new project-root entry appears through an absolute live path", async () => {
    // Codex P1, round 18: the roots and copied files are the entries that
    // existed when staging ran, so a marker a non-idempotent hook creates at
    // the live root was in neither snapshot. The root's entry set is part of
    // the fingerprint now.
    //
    // Written from `onStaged` since round 28, for the reason the absolute-path
    // cases above give: the containment denies the checkout to every hook by
    // resolved path, so what is left to pin here is that the root's ENTRY SET is
    // fingerprinted, which the parent's identical write exercises.
    await withFunctionsProject(
      { functionsConfig: { predeploy: PREDEPLOY } },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ projectDir }) => writeFile(join(projectDir, ".deploy-mode"), "x"),
        }).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("root entries");
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

  itContained("ABORTS when a hook leaves descendants running and a remote-tracking ref has moved", async () => {
    // Codex P1, round 19: the background-hook refusal checked the live tree
    // but not what git answers, and returned BEFORE the post-hook metadata
    // check — so a hook that left a child running while origin/main moved was
    // refused conservatively while the wrapper's checkout guard no longer
    // held. The refusal now asks git first and aborts on the moved ref.
    //
    // The ORDER is the whole case, so the ref has to move inside the window the
    // background-hook refusal covers — after the baseline, during the hooks —
    // which `onStaged` is too early for. The hook therefore stops at a gate and
    // this test moves the ref while it is stopped there; round 28's containment
    // is why the hook cannot move it itself (`.git` is a symlink into the
    // checkout). The hook still leaves the descendant that produces the refusal
    // this case is about.
    const gate = await openHookGate();
    try {
      await withFunctionsProject(
        {
          branch: "release",
          functionsConfig: { predeploy: [...PREDEPLOY, `sleep 3 & ${gate.command}`] },
        },
        async (configPath) => {
          const checkout = dirname(configPath);
          const failure = await whileAHookWaits(
            gate,
            () => classify(["--only", "functions:daily"], configPath),
            () => gitIn(checkout, ["update-ref", "refs/remotes/origin/main", "HEAD"]),
          );
          expect(failure).toBeInstanceOf(RepositoryMetadataDriftError);
          expect(failure.message).toContain("refs/remotes/origin/main");
        },
      );
    } finally {
      await gate.close();
    }
  });

  itContained("ABORTS when an entry appears in an intermediate overlay directory", async () => {
    // Phase 4b P1, run 4: with the source at `packages/functions`, the overlay
    // traverses `packages` to place it and registered only its existing
    // children, so `packages/generated.ts` at the live root was in neither
    // snapshot. Every traversed directory's entry set is watched now.
    //
    // From `onStaged` since round 28: the write lands in the checkout, which
    // the containment denies to every hook, and the property under test is
    // which directories the overlay's walk REGISTERS — the same either way.
    await withFunctionsProject(
      {
        functionsConfig: { source: "packages/functions", predeploy: PREDEPLOY },
        files: { "packages/functions/.keep": "" },
      },
      async (configPath) => {
        const { cp: copy } = await import("node:fs/promises");
        // The fixture installs its toolchain under `functions/`; move it.
        const checkout = dirname(configPath);
        await copy(join(checkout, "functions"), join(checkout, "packages", "functions"), {
          recursive: true,
          verbatimSymlinks: true,
        });
        await rm(join(checkout, "functions"), { recursive: true, force: true });
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ projectDir }) => writeFile(join(projectDir, "packages", "generated.ts"), "x"),
        }).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("packages");
        expect(failure.message).toContain("entries");
      },
    );
  });

  itContained("ABORTS when a marker is left at the root of a linked node_modules", async () => {
    // Codex P1, round 22: the dependency tree is linked into the overlay and
    // was excluded from both fingerprints, so a marker left there for the
    // deploy's second run was invisible. Each node_modules is watched one level
    // deep now.
    //
    // From `onStaged` since round 28. The overlay reaches the LIVE dependency
    // tree through an absolute link, so the route ends in the checkout and the
    // containment refuses it to a hook; what still has to be pinned is that the
    // linked tree is fingerprinted one level deep at all.
    await withFunctionsProject(
      { functionsConfig: { predeploy: PREDEPLOY } },
      async (configPath) => {
        const marker = join(dirname(configPath), "functions", "node_modules", ".deploy-marker");
        try {
          const failure = await classify(["--only", "functions:daily"], configPath, {
            onStaged: () => writeFile(marker, "x"),
          }).then(
            () => null,
            (error) => error,
          );
          expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
          expect(failure.message).toContain("node_modules");
        } finally {
          await rm(marker, { force: true });
        }
      },
    );
  });

  it("refuses the inventory when discovery leaves work running in the background", async () => {
    // Phase 4b P1, run 5: an artifact can leave an unref'd generator running
    // with ignored stdio; Firebase's teardown waits only for the SDK process,
    // so the generator finishes during the real deploy and can rewrite a later
    // codebase's artifact. Both rehearsals end it, so the inventory is refused
    // the way a background predeploy hook is.
    await withFunctionsProject(
      {
        source:
          'import { spawn } from "node:child_process";\n' +
          'spawn("sleep", ["3"], { stdio: "ignore" }).unref();\n' +
          endpoint("daily"),
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
      },
    );
  });

  it("refuses the inventory when a discovery descendant holds the SDK's pipes", async () => {
    // Phase 4b, runs 6 and 7 on #1107. The same generator as above, but with
    // the SDK's own stdio INHERITED rather than ignored — the ordinary shape,
    // since a child gets its parent's descriptors unless told otherwise. The
    // runner settled on `close`, which waits for those PIPES rather than for
    // the process, so the deadline is what ended the wait: it killed the group
    // first, and the run was then reported with no descendants left and the
    // SDK's own exit status. The group was inventoried as exact — twenty
    // seconds late. Settling on `exit` asks the question while the answer is
    // still true.
    await withFunctionsProject(
      {
        source:
          'import { spawn } from "node:child_process";\n' +
          // Long enough that it is unambiguously still running when the SDK
          // process exits; the group kill at settle is what ends it.
          'spawn("/bin/sleep", ["30"], {\n' +
          '  stdio: ["ignore", "inherit", "inherit"],\n' +
          // An explicit environment, so the spawn does not COPY `process.env`:
          // enumerating it reads `CLOUD_RUNTIME_CONFIG`, which would refuse
          // this fixture for the watcher's reason rather than for the
          // descendant's.
          "  env: {},\n" +
          "}).unref();\n" +
          endpoint("daily"),
      },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
      },
    );
  });

  itContained("refuses the inventory when discovery outlives its own deadline", async () => {
    // The other half of the same fix: a codebase that leaves a live handle
    // behind keeps the discovery process running after `quitquitquit` closes
    // the server, so the deadline — not the program — is what ends it. The
    // manifest it had already served used to be inventoried anyway, because a
    // timeout was indistinguishable from an ordinary exit once the group had
    // been killed. A run the deadline ended is a run that did not finish.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: [] },
        files: {
          "functions/lib/index.js": artifact(
            ["setInterval(() => {}, 1000);", "exports.daily = endpoint();"].join("\n"),
          ),
        },
      },
      async (configPath) => {
        // The REASON is the assertion here, not only the verdict: killing the
        // group at the deadline leaves the immediate child briefly unreaped,
        // so `descendantsLeft` could refuse this by accident. Only a refusal
        // that names the deadline proves the timeout itself is visible.
        const { result, reasons } = await withRefusalReasons(() =>
          classifyFirebaseDeployRequest(["fiveacross", "--only", "functions:daily"], {
            defaultConfigPath: configPath,
            establishedCredentialPath: establishedCredential,
            discoveryTimeoutMs: 5_000,
          }),
        );
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
        expect(reasons).toContain("discovery did not end before the deadline");
      },
    );
  });

  it("fingerprints every remote-tracking ref, past the diagnostic capture cap", async () => {
    // Phase 4b P2, run 5: the runner keeps 8 KiB of a child's output as a
    // diagnostic; the git-answer fingerprint is the ANSWER, so it is captured
    // whole — a moved ref in the discarded suffix would otherwise be invisible.
    await withFunctionsProject({ branch: "release" }, async (configPath) => {
      const { dirname: dir } = await import("node:path");
      const { execFileSync } = await import("node:child_process");
      const repo = dir(configPath);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
      for (let i = 0; i < 400; i += 1) {
        execFileSync("git", ["update-ref", `refs/remotes/origin/padding-ref-${String(i).padStart(4, "0")}`, head], { cwd: repo });
      }
      const before = await gitAnswerFingerprint(repo);
      expect(before.length).toBeGreaterThan(8192);
      expect(before).toContain("refs/remotes/origin/padding-ref-0399");
      execFileSync("git", ["update-ref", "refs/remotes/origin/padding-ref-0399", `${head}`], { cwd: repo });
      execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "moved"], { cwd: repo });
      execFileSync("git", ["update-ref", "refs/remotes/origin/padding-ref-0399", "HEAD"], { cwd: repo });
      const after = await gitAnswerFingerprint(repo);
      expect(after).not.toBe(before);
    });
  });

  itContained("ABORTS on a change to a watched directory's own permissions", async () => {
    // Codex P1, round 25: the walk recorded only a root's children, so flipping
    // a linked directory's mode through the scratch symlink moved nothing the
    // fingerprint compared. Each watched directory's own signature is part of
    // the fingerprint now.
    //
    // Through `onStaged`, and through the SAME scratch symlink, since round 28:
    // the link resolves into the checkout, which the containment denies to
    // every hook. What is under test is the fingerprint's coverage of a
    // directory's own signature.
    await withFunctionsProject(
      { functionsConfig: { predeploy: PREDEPLOY }, files: { "shared/.keep": "" } },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ scratchProject }) => chmod(join(scratchProject, "shared"), 0o700),
        }).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("shared");
      },
    );
  });

  itContained("ABORTS on a mode change a file named like the synthetic key used to mask", async () => {
    // Barrier round on #1107: the fingerprint keyed a watched directory's own
    // signature under the filesystem-looking string `<dir> (self)`, so a
    // repository holding a real file of that exact name produced the SAME key
    // — and the copied root files are recorded AFTER the directory walks, so
    // the file's unchanged signature overwrote the directory's and hid the
    // `chmod` from both snapshots. Structured keys give the two entries
    // separate namespaces.
    //
    // The mode change has to reach the LIVE `functions` directory: the source
    // dir is a COPY in the scratch project, so a `chmod` inside the copy would
    // move nothing the guard watches. A hook used to get there through
    // `shared/..` — a symlinked project directory the kernel resolves before
    // `..`, landing back in the checkout — and round 28's containment now
    // refuses exactly that, canonicalised path and all. `onStaged` takes the
    // live path directly, which is the same watched entry.
    await withFunctionsProject(
      {
        functionsConfig: { predeploy: PREDEPLOY },
        files: { "shared/.keep": "", "functions (self)": "a real file, not a fingerprint key" },
      },
      async (configPath) => {
        const failure = await classify(["--only", "functions:daily"], configPath, {
          onStaged: ({ projectDir }) => chmod(join(projectDir, "functions"), 0o700),
        }).then(
          () => null,
          (error) => error,
        );
        expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
        expect(failure.message).toContain("functions (self) was modified");
      },
    );
  });

  itContained("ABORTS on a write that lands while a hook is running, and THEN fails", async () => {
    // The write is the fatal condition and the failure is merely conservative;
    // checking them in that order is what keeps the write fatal. Handled the
    // other way round, the refusal returns first and `deploy.sh` walks into
    // BUILD_CMD with a checkout the clean-tree guard never approved (Phase 4b
    // P1, round 19).
    //
    // The ordering only exists in the window the hooks run in, which `onStaged`
    // is too early for — a write from there aborts on the staging bracket before
    // a hook has run at all. So the hook stops at a gate, this test writes into
    // the checkout while it is stopped there, and the hook then exits 7. Round
    // 28's containment is why the hook no longer writes it itself; the exit this
    // asserts is unchanged, and it is still the hook's failure that the drift
    // has to beat.
    const gate = await openHookGate();
    try {
      await withFunctionsProject(
        {
          functionsConfig: { predeploy: [...PREDEPLOY, `${gate.command}; exit 7`] },
          files: { "shared/toggle": "" },
        },
        async (configPath) => {
          const checkout = dirname(configPath);
          const failure = await whileAHookWaits(
            gate,
            () => classify(["--only", "functions:daily"], configPath),
            () => appendFile(join(checkout, "shared", "toggle"), "x"),
          );
          expect(failure).toBeInstanceOf(LiveCheckoutDriftError);
          expect(failure.message).toContain("shared/toggle");
          expect(failure.message).toContain("failing predeploy hook");
        },
      );
    } finally {
      await gate.close();
    }
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

/**
 * A hook that hands a worker to the operating system and walks away.
 *
 * `spawn(..., { detached: true, stdio: "ignore", env: {...} })` is the shape
 * every after-the-fact guard here misses at once: `setsid` puts the worker in a
 * session no group signal reaches, the explicit environment withholds the
 * rehearsal marker so the process-table sweep cannot recognise it either, and on
 * macOS `ps -E` would withhold a SIP-protected binary's environment regardless.
 * The delay puts its write past the fingerprint that was watching.
 *
 * Written to a file rather than inlined in the hook because a predeploy command
 * containing a BACKSLASH is refused before it runs (`runPredeployHook`), and an
 * inline `node -e` cannot escape its own quotes without one.
 */
const DETACHING_HOOK = [
  'const { spawn } = require("node:child_process");',
  "const worker = [",
  "  'const fs = require(\"node:fs\");',",
  "  'setTimeout(() => { try { fs.writeFileSync(process.argv[1], \"landed\"); } catch {} }, 1200);',",
  '].join("");',
  "// An environment of its OWN: no rehearsal marker travels with this worker,",
  "// so nothing in the process table identifies it as this run's.",
  'spawn(process.execPath, ["-e", worker, process.argv[2]], {',
  "  detached: true,",
  '  stdio: "ignore",',
  "  env: { PATH: process.env.PATH },",
  "}).unref();",
  "",
].join("\n");

describe("write containment holds a rehearsal's writes inside the scratch root", RUNS_A_BUILD, () => {
  itContained.each([
    ["under the system temp dir", undefined],
    ["outside every writable root", LIVE_FIXTURE_ROOT],
  ])("stops a writer a hook detached with an environment of its own, %s", async (
    _label,
    fixtureRoot,
  ) => {
    // Phase 4b P1 on #1107. Everything else in this classifier answers AFTER the
    // fact — the group is signalled when a step ends, the marker sweep looks for
    // what escaped it, the fingerprints compare before with after — and an
    // answer does not neutralise a writer that is already running. This worker
    // escapes all three by construction, resolves an ABSOLUTE live path so that
    // the scratch directory's removal cannot spare the tree for the wrong
    // reason, and fires on a clock of its own.
    //
    // The assertion is therefore the filesystem, not the classification: the
    // write must not land, whenever it is attempted. The classification is
    // pinned beside it because nothing about this hook is visible to the
    // classifier — an exact selector stays exact — which is precisely why
    // containment rather than detection is the fix.
    //
    // BOTH LAYOUTS, since round 28. This case only ever ran on a checkout
    // outside the writable set, because the read-only set used to drop a
    // checkout that lay inside one — so this exact worker, on a repository
    // beneath `tmpdir()`, wrote its deployment input while the canary went on
    // passing against `$HOME` (Codex P1, round 28). The nested read-only
    // override is what makes the two arrangements answer identically, and the
    // only way to say so is to run both.
    await withFunctionsProject(
      {
        fixtureRoot,
        // Its own checkout root, because staging it inside this repository's
        // tree would otherwise put `.git` above it and refuse the exemption for
        // the layout instead (`nestedProjectRefusal`) — which would pass this
        // case for the wrong reason.
        branch: "release",
        functionsConfig: {
          predeploy: [...PREDEPLOY, 'node "$INIT_CWD/detach.cjs" "$INIT_CWD/late-write"'],
        },
        files: { "detach.cjs": DETACHING_HOOK },
      },
      async (configPath) => {
        const checkout = dirname(configPath);
        const previous = process.env.INIT_CWD;
        process.env.INIT_CWD = checkout;
        try {
          const result = await classify(["--only", "functions:daily"], configPath);
          // Past the worker's own delay, so absence is containment rather than
          // a race this test happened to win.
          await new Promise((wake) => setTimeout(wake, 2_500));
          expect(existsSync(join(checkout, "late-write"))).toBe(false);
          expect(result).toMatchObject(EXEMPT);
        } finally {
          if (previous === undefined) delete process.env.INIT_CWD;
          else process.env.INIT_CWD = previous;
        }
      },
    );
  });

  // Codex P1, round 28 on #1107. The read-only set used to DROP the live
  // checkout whenever it lay inside a writable root, because the system temp dir
  // has to stay writable for the staging — so a repository checked out beneath
  // `tmpdir()` kept only the home directory in that set, the nonempty-root check
  // passed, the canary proved containment against `$HOME`, and every mechanism
  // handed the rehearsal a WRITABLE checkout while reporting success. The
  // checkout is now expressed as a read-only override INSIDE that writable root
  // (`establishWriteContainment`), and the canary asks about the checkout by
  // name, so the same denial holds for both layouts.
  //
  // Both arrangements are asserted, because the whole finding was one of them
  // answering differently from the other while the guard reported the same
  // thing. The hook is the same in each: an ordinary append into a shared build
  // input, which the containment refuses, and whose failure the classifier then
  // treats as it treats any failing hook — a project-wide refusal. The live file
  // is checked in both, because a refusal that arrived after the write would be
  // no better than the exemption it replaced.
  itContained.each([
    ["under the system temp dir", undefined],
    ["outside every writable root", LIVE_FIXTURE_ROOT],
  ])("denies a hook's write into a checkout %s", async (_label, fixtureRoot) => {
    await withFunctionsProject(
      {
        fixtureRoot,
        // Its own checkout root when staged inside this repository, or `.git`
        // above it would refuse the layout instead (`nestedProjectRefusal`).
        ...(fixtureRoot ? { branch: "release" } : {}),
        functionsConfig: { predeploy: [...PREDEPLOY, "printf x >> shared/toggle"] },
        files: { "shared/toggle": "" },
      },
      async (configPath) => {
        const toggle = join(dirname(configPath), "shared", "toggle");
        const { result, reasons } = await withRefusalReasons(() =>
          classify(["--only", "functions:daily"], configPath),
        );
        expect(result).toMatchObject({ functionsAttempted: true, ...ALL_INVOKERS_CONSERVATIVE });
        expect(reasons).toContain("predeploy hook failed");
        expect(await readFile(toggle, "utf8")).toBe("");
      },
    );
  });

  itContained.each([
    ["under the system temp dir", undefined],
    ["outside every writable root", LIVE_FIXTURE_ROOT],
  ])("still proves the endpoint for a checkout %s whose hook writes nothing", async (
    _label,
    fixtureRoot,
  ) => {
    // The control for the pair above, in both arrangements. Without it, a
    // containment that refused every hook — or one that took the temp-dir
    // checkout's nested override to mean the staging root as well, so no build
    // could run — would pass those cases for the wrong reason.
    await withFunctionsProject(
      {
        fixtureRoot,
        ...(fixtureRoot ? { branch: "release" } : {}),
        functionsConfig: { predeploy: [...PREDEPLOY, 'printf x >> "$RESOURCE_DIR/toggle"'] },
        files: { "functions/toggle": "" },
      },
      async (configPath) => {
        expect(await classify(["--only", "functions:daily"], configPath)).toMatchObject(EXEMPT);
        // The hook wrote into the STAGED copy of its own `$RESOURCE_DIR`, so
        // the live one is untouched — which is also what says the build ran.
        expect(await readFile(join(dirname(configPath), "functions", "toggle"), "utf8")).toBe("");
      },
    );
  });

  it("refuses every selector, and runs no hook, when containment cannot be proved", async () => {
    // The canary's refusal arm. `sandbox-exec` is deprecated, `bwrap` may be
    // absent, and an unprivileged user namespace can be administratively
    // disabled — each of those fails silently in the direction that matters, so
    // the mechanism is proved with a canary write before any hook runs, and a
    // machine that cannot prove one runs no hooks at all.
    //
    // `writeContainment: "unavailable"` is how a test reaches that machine. It
    // only ever narrows — it is the behaviour of a platform with no mechanism —
    // and `main()` never passes it, so no shell can. The hook writes a sentinel
    // into the checkout that must never appear, because a refusal reached after
    // running the hook is a refusal reached after the write.
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, 'printf ran > "$INIT_CWD/hook-ran"'],
        },
        files: { "functions/lib/index.js": artifact("exports.placeholder = 1;") },
      },
      async (configPath) => {
        const checkout = dirname(configPath);
        const previous = process.env.INIT_CWD;
        process.env.INIT_CWD = checkout;
        try {
          const { result, reasons } = await withRefusalReasons(() =>
            classify(["--only", "functions:daily"], configPath, {
              writeContainment: "unavailable",
            }),
          );
          expect(result).toMatchObject({
            functionsAttempted: true,
            ...ALL_INVOKERS_CONSERVATIVE,
          });
          expect(reasons).toContain(WRITE_CONTAINMENT_REFUSAL.DISABLED);
          expect(existsSync(join(checkout, "hook-ran"))).toBe(false);
        } finally {
          if (previous === undefined) delete process.env.INIT_CWD;
          else process.env.INIT_CWD = previous;
        }
      },
    );
  });

  /**
   * The fail-closed contract, asserted the same way twice: once on any machine
   * by forcing the refusal, and once on a machine that reaches it by itself.
   *
   * WHAT IT PINS. The refusal is not a classification detail; it is the whole
   * behaviour of this classifier on a machine that cannot contain a hook. So it
   * is asserted in four parts, and each part is a different way the refusal
   * could be wrong: it must REFUSE every invoker, it must NAME what it could
   * not prove (a caller reading `FIREBASE_DEPLOY_CLASSIFIER_DEBUG=1` has
   * nothing else to go on), it must run NO HOOK, and it must leave the checkout
   * exactly as it found it — the refusal has to arrive before the staging, not
   * after, or it is no better than the exemption it replaces.
   *
   * The hook writes its sentinel through `$INIT_CWD`, which npm points at the
   * live checkout: the same absolute route the round-15 finding used, and the
   * one a refusal reached too late would leave open.
   */
  async function expectFailClosedRefusal(classifyOptions = {}) {
    await withFunctionsProject(
      {
        functionsConfig: {
          predeploy: [...PREDEPLOY, 'printf ran > "$INIT_CWD/hook-ran"'],
        },
        // As the DISABLED case above: an artifact already on disk, so nothing
        // here can refuse for the unrelated reason that `main` points at a file
        // the build was never allowed to produce.
        files: { "functions/lib/index.js": artifact("exports.placeholder = 1;") },
      },
      async (configPath) => {
        const checkout = dirname(configPath);
        const before = (await readdir(checkout)).sort();
        const previous = process.env.INIT_CWD;
        process.env.INIT_CWD = checkout;
        try {
          const { result, reasons } = await withRefusalReasons(() =>
            classify(["--only", "functions:daily"], configPath, classifyOptions),
          );
          expect(result).toMatchObject({
            functionsAttempted: true,
            ...ALL_INVOKERS_CONSERVATIVE,
          });
          // Either arm of "this machine has nothing that works": a platform with
          // no candidate at all, or one whose every candidate failed.
          expect(reasons).toMatch(
            new RegExp(
              `${WRITE_CONTAINMENT_REFUSAL.NO_MECHANISM}|${WRITE_CONTAINMENT_REFUSAL.UNPROVED}`,
            ),
          );
          if (reasons.includes(WRITE_CONTAINMENT_REFUSAL.UNPROVED)) {
            // A candidate list that failed has to say WHICH, or an operator
            // cannot tell an absent `bwrap` from a disabled namespace.
            expect(reasons).toMatch(/sandbox-exec|bwrap|unshare/);
          }
          expect(existsSync(join(checkout, "hook-ran"))).toBe(false);
          expect((await readdir(checkout)).sort()).toEqual(before);
        } finally {
          if (previous === undefined) delete process.env.INIT_CWD;
          else process.env.INIT_CWD = previous;
        }
      },
    );
  }

  it("refuses every selector, names what it could not prove, and stages nothing", async () => {
    // On EVERY machine, including the one that can contain a hook perfectly
    // well: `FIREBASE_DEPLOY_CLASSIFIER_FORCE_NO_CONTAINMENT` is how the
    // development Mac reaches the arm `ubuntu-latest` reaches on its own. It
    // only ever narrows — it refuses before the first candidate is tried — so
    // the answer under it is the answer a machine with no mechanism gives.
    await withEnv({ FIREBASE_DEPLOY_CLASSIFIER_FORCE_NO_CONTAINMENT: "1" }, () =>
      expectFailClosedRefusal(),
    );
  });

  it.runIf(NO_CONTAINMENT_MECHANISM)(
    "takes that same refusal on this machine, with no test switch at all",
    async () => {
      // The case the forced one cannot be: this is the machine, answering for
      // itself. It is what `app-ci` on `ubuntu-latest` proves in place of every
      // case skipped above, and it is why those skips are not a hole — the
      // exemption path is untested here because there is none, and the path
      // that replaces it is tested exactly here.
      await expectFailClosedRefusal();
    },
  );
});

describe("a codebase this classifier refused to build is never discovered", RUNS_A_BUILD, () => {
  // Phase 4b P1 on #1107. `singleEndpointInventory` records an unsupported
  // runtime or an unmirrorable `configDir` against the codebase's SELECTOR
  // entry, which is enough to refuse a selector pointed at that codebase — and
  // `functions:beta:submitBugReport` is never pointed at one: it takes the
  // explicit protected-callable branch, which answers from the selector and
  // reads no inventory at all. `buildAndInventoryProject` meanwhile worked from
  // the configs, where the restriction was invisible: beta was discovered like
  // any other codebase, under an environment that had to be substituted (an
  // absolute `configDir` falls back to the SOURCE dir, so the dotenv files are
  // the wrong ones), and reported an authoritative inventory. Nothing was left
  // for `firstUnprovableCodebase` to find, so alpha's selector was proved exact
  // beside a codebase whose real initialisation was never reproduced — and one
  // of the things an unknown codebase does at module load is rewrite alpha's
  // artifact before alpha is discovered.
  const selector = ["--only", "functions:alpha:daily,functions:beta:submitBugReport"];

  it.each([
    ["an absolute configDir", { configDir: "/etc/firebase-deploy-scope" }],
    ["a non-Node runtime", { runtime: "python311" }],
  ])("refuses the whole project when the SELECTED beta is blocked by %s", async (_label, config) => {
    await withCodebases(
      {
        alpha: endpoint("daily"),
        beta: { source: endpoint("submitBugReport"), config },
      },
      async (configPath) => {
        const result = await classify(selector, configPath);
        // `submitBugReport` still binds its own invoker from the selector — that
        // is a fact about the request, not about an inventory — while alpha's
        // exemption is gone and every invoker it did not name turns
        // conservative.
        expect(result).toMatchObject({
          functionsAttempted: true,
          bugReportInvokerSelected: true,
          bugReportInvokerConservative: false,
          emailUnsubscribeInvokerSelected: true,
          emailUnsubscribeInvokerConservative: true,
          authHandoffInvokerSelected: true,
          authHandoffInvokerConservative: true,
        });
      },
    );
  });

  itContained("proves the same selector when neither codebase is blocked", async () => {
    // The control. Without it the case above would pass for a fixture that was
    // never provable to begin with: the two codebases, the two selectors and
    // the two hooks are identical, and only beta's own config differs.
    await withCodebases(
      { alpha: endpoint("daily"), beta: endpoint("submitBugReport") },
      async (configPath) => {
        const result = await classify(selector, configPath);
        expect(result).toMatchObject({
          functionsAttempted: true,
          bugReportInvokerSelected: true,
          bugReportInvokerConservative: false,
          emailUnsubscribeInvokerSelected: false,
          authHandoffInvokerSelected: false,
          eventInvitationsInvokerSelected: false,
        });
      },
    );
  });
});

describe("uncertainty in one selected codebase is uncertainty in all of them", () => {
  // The decision itself, put directly: no build, no probes, just the rule that
  // a selected codebase without an authoritative inventory forfeits the whole
  // project's (Phase 4b, runs 6 and 7 on #1107).
  const inventories = new Map([
    ["alpha", { authoritative: true, endpoints: ["daily"] }],
    [
      "beta",
      {
        authoritative: false,
        endpoints: [],
        reason: "the codebase consulted CLOUD_RUNTIME_CONFIG",
      },
    ],
  ]);

  it("names the first selected codebase whose inventory was refused", () => {
    expect(firstUnprovableCodebase(["alpha", "beta"], inventories)).toMatchObject({
      codebase: "beta",
      reason: "the codebase consulted CLOUD_RUNTIME_CONFIG",
    });
  });

  it("treats a codebase with no inventory at all as unprovable", () => {
    expect(firstUnprovableCodebase(["gamma"], inventories)).toMatchObject({ codebase: "gamma" });
  });

  it("says nothing about codebases this deploy does not load", () => {
    // `beta` is refused, but a request that does not select it never runs its
    // code, so it cannot rewrite what `alpha` deploys.
    expect(firstUnprovableCodebase(["alpha"], inventories)).toBeNull();
  });
});

describe("a refused codebase forfeits its peers' exemptions", RUNS_A_BUILD, () => {
  it("refuses an exact selector when another SELECTED codebase is unprovable", async () => {
    // Phase 4b, runs 6 and 7 on #1107. `--only functions:beta:submitBugReport,
    // functions:alpha:daily` loads both codebases against ONE project, beta
    // first. Beta consults the legacy runtime config, so what beta does during
    // the real deploy is unknown — and one of the things it does under a
    // namespace neither probe can supply is rewrite alpha's artifact into a
    // group. Beta's own inventory was duly refused, but `submitBugReport` takes
    // the explicit protected-callable branch, which never reads an inventory,
    // so nothing carried beta's uncertainty across and alpha went on being
    // proved exact from two probes in which beta happened to leave it alone.
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-crosstalk-"));
    try {
      for (const [dir, name] of [
        ["functions-beta", "submitBugReport"],
        ["functions-alpha", "daily"],
      ]) {
        const codebaseDir = resolve(fixture, dir);
        await mkdir(resolve(codebaseDir, "src"), { recursive: true });
        await installToolchain(codebaseDir);
        await writeUnder(codebaseDir, "package.json", JSON.stringify(DEFAULT_PACKAGE));
        await writeUnder(codebaseDir, "tsconfig.json", JSON.stringify(DEFAULT_TSCONFIG));
        await writeUnder(codebaseDir, "src/index.ts", endpoint(name));
      }
      await writeUnder(
        fixture,
        "functions-beta/lib/index.js",
        artifact(
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            'const runtime = JSON.parse(process.env.CLOUD_RUNTIME_CONFIG || "{}");',
            "if (runtime.someLegacyNamespace) {",
            "  fs.writeFileSync(",
            '    path.join(__dirname, "..", "..", "functions-alpha", "lib", "index.js"),',
            '    fs.readFileSync(path.join(__dirname, "..", "..", "grouped-alpha.js"), "utf8"),',
            "  );",
            "}",
            "exports.submitBugReport = endpoint();",
          ].join("\n"),
        ),
      );
      await writeUnder(
        fixture,
        "functions-alpha/lib/index.js",
        artifact("exports.daily = endpoint();"),
      );
      await writeUnder(
        fixture,
        "grouped-alpha.js",
        artifact("exports.daily = { submitBugReport: endpoint() };"),
      );
      await writeUnder(
        fixture,
        "firebase.json",
        JSON.stringify({
          functions: [
            { source: "functions-beta", codebase: "beta", predeploy: [] },
            { source: "functions-alpha", codebase: "alpha", predeploy: [] },
          ],
        }),
      );
      expect(
        await classify(
          ["--only", "functions:beta:submitBugReport,functions:alpha:daily"],
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

  itContained("selects the pinned callable's invoker for an otherwise exact selector", async () => {
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

  itContained("classifies a Hosting target written as an import path", async () => {
    // Codex P2, round 27 on #1107. `"hosting": "hosting.config.json"` is a
    // supported spelling — the pinned `Config` materialises it from the named
    // file — but everything that read `firebase.json` directly still saw the
    // STRING. `extract()` writes `site` onto what it is handed, so the final
    // Hosting selection threw `Cannot create property 'site' on string` and
    // EVERY deploy selecting that configuration aborted during classification,
    // whatever else the request was. The materialised config is what is read
    // now, so the request classifies like any other.
    await withFunctionsProject(
      {
        config: { hosting: "hosting.config.json" },
        files: {
          "hosting.config.json": JSON.stringify({ public: "public" }),
          "public/index.html": "",
        },
      },
      async (configPath) => {
        expect(
          await classify(["--only", "functions:daily,hosting"], configPath),
        ).toMatchObject({ hostingAttempted: true, ...EXEMPT });
      },
    );
  });

  itContained("widens the selector for a pinned rewrite inside an imported Hosting config", async () => {
    // The pin widening asked the same question one line earlier and swallowed
    // the same throw, so an imported config's `pinTag` rewrite widened nothing:
    // the CLI would have appended `functions:submitBugReport` to the selector
    // and this classifier would have proved the un-widened one exact, releasing
    // a protected callable with its invoker reconciliation switched off.
    await withFunctionsProject(
      {
        config: { hosting: "hosting.config.json" },
        files: {
          "hosting.config.json": JSON.stringify(pinned().hosting),
          "public/index.html": "",
        },
      },
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

  itContained("does not widen when Hosting is not part of the deploy", async () => {
    await withFunctionsProject(
      { config: pinned(), files: { "public/index.html": "" } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ hostingAttempted: false, ...NO_INVOKER_SELECTED });
      },
    );
  });

  itContained("does not widen for a rewrite that is not pinned", async () => {
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

  itContained("widens a codebase-qualified request to the pinned callable as well", async () => {
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

  itContained("still proves the exact endpoint when the kit carries no hooks", async () => {
    await withFunctionsProject(
      { config: withKit({}) },
      async (configPath) => {
        const result = await classify(["--only", "functions:alpha:daily"], configPath);
        expect(result).toMatchObject({ functionsAttempted: true, ...NO_INVOKER_SELECTED });
      },
    );
  });
});
