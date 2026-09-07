#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const commander = require("commander");
const ts = require("typescript");
const {
  command: firebaseDeployCommand,
} = require("firebase-tools/lib/commands/deploy");
const {
  checkValidTargetFilters,
} = require("firebase-tools/lib/checkValidTargetFilters");
const { Config } = require("firebase-tools/lib/config");
const { VALID_DEPLOY_TARGETS } = require("firebase-tools/lib/deploy");
const { filterTargets } = require("firebase-tools/lib/filterTargets");
const {
  extract,
  filterExcept,
  filterOnly,
} = require("firebase-tools/lib/hosting/config");
const functionsEnv = require("firebase-tools/lib/functions/env");

// Deploy-command options come directly from the pinned firebase-tools module.
// This small global subset covers options that change destination or whose
// value can look like another flag, without loading the full Firebase CLI for
// every local preflight.
const FIREBASE_GLOBAL_OPTIONS = Object.freeze([
  ["-P, --project <alias_or_project_id>", "the Firebase project to use"],
  ["--account <email>", "the Google account to use"],
  ["--token <token>", "the Firebase authorization token"],
  ["-c, --config <path>", "path to firebase.json"],
  ["-j, --json", "output JSON"],
  ["--non-interactive", "disable interactive prompts"],
  ["-i, --interactive", "force interactive prompts"],
  ["--debug", "enable debug logging"],
]);

export function assertNoNamedDestinationOverride(args) {
  const projectOverride = args.some(
    (argument) =>
      argument === "-P" ||
      argument.startsWith("-P") ||
      argument === "--project" ||
      argument.startsWith("--project="),
  );
  if (projectOverride) {
    throw new Error(
      "A named deploy target cannot override the pinned Firebase project with -P/--project. " +
        "Nothing has been built or published.",
    );
  }

  const configOverride = args.some(
    (argument) =>
      argument === "-c" ||
      argument.startsWith("-c") ||
      argument === "--config" ||
      argument.startsWith("--config="),
  );
  if (configOverride) {
    throw new Error(
      "A named deploy target cannot override the pinned Firebase config with -c/--config. " +
        "Nothing has been built or published.",
    );
  }
}

function hasNamedDestinationOverride(args) {
  try {
    assertNoNamedDestinationOverride(args);
    return false;
  } catch {
    return true;
  }
}

function normalizeAttachedDestinationOptions(args) {
  return args.flatMap((argument) => {
    if (/^-P.+/.test(argument)) return ["-P", argument.slice(2)];
    if (/^-c.+/.test(argument)) return ["-c", argument.slice(2)];
    return [argument];
  });
}

function parseFirebaseOptions(args) {
  const parser = new commander.Command("deploy");
  parser.unknownOption = (flag) => {
    throw new Error(`unknown option '${flag}'`);
  };
  parser.optionMissingArgument = (option) => {
    throw new Error(`option '${option.flags}' requires a value`);
  };
  for (const option of FIREBASE_GLOBAL_OPTIONS) parser.option(...option);
  for (const option of firebaseDeployCommand.options) parser.option(...option);

  const parsed = parser.parseOptions(
    parser.normalize(normalizeAttachedDestinationOptions(args)),
  );
  if (parsed.unknown.length > 0) parser.unknownOption(parsed.unknown[0]);
  return { operands: parsed.args, options: parser.opts() };
}

function normalizedFilter(value) {
  // firebase-tools splits filter lists on commas only. Whitespace remains part
  // of the selector and must reach its pinned validators unchanged.
  return value || undefined;
}

const EVENT_INVITATION_EXPORTS = Object.freeze([
  ["mintEventInvitation", "mint"],
  ["redeemEventInvitation", "redeem"],
  ["revokeEventInvitation", "revoke"],
]);

function eventInvitationServicesFromSource(source) {
  const exportedNames = new Set();
  let hasRuntimeExportStar = false;
  const sourceFile = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exportedNames.add(declaration.name.text);
      }
      continue;
    }
    if (
      exported &&
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      exportedNames.add(statement.name.text);
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (!statement.exportClause) {
      // Resolving an export-star requires traversing the module graph. Treat it
      // as possibly exporting every protected callable instead of silently
      // skipping invoker repair for a service Firebase may discover.
      hasRuntimeExportStar = true;
      continue;
    }
    if (ts.isNamedExports(statement.exportClause)) {
      for (const specifier of statement.exportClause.elements) {
        if (!specifier.isTypeOnly) exportedNames.add(specifier.name.text);
      }
    }
  }
  if (hasRuntimeExportStar) {
    for (const [exportName] of EVENT_INVITATION_EXPORTS) exportedNames.add(exportName);
  }
  return EVENT_INVITATION_EXPORTS.filter(([exportName]) =>
    exportedNames.has(exportName),
  ).map(([, service]) => service);
}

/**
 * The exported names a Functions source DECLARES as builder calls — a fast
 * pre-check, not a proof.
 *
 * `--only functions:X` is ambiguous at the string level: Firebase's grammar
 * gives a group the same bare shape as an endpoint
 * (`exports.metrics = require('./metrics')` deploys as `--only
 * functions:metrics`, https://firebase.google.com/docs/functions/organize-functions),
 * so the selector alone cannot say whether it releases one endpoint or a
 * module's whole surface. The ANSWER comes from the built artifact
 * (`artifactEndpointInventory`), because the artifact is what Firebase loads.
 *
 * This parse exists only to decide whether that build is worth running. A name
 * it does not list is refused without building; a name it lists is then put to
 * the artifact, which may still refuse it. So the set is deliberately
 * PERMISSIVE: it does not try to model CommonJS mutation, `export *`, or
 * reassignment — the artifact walk sees the consequences of all of them
 * directly. It can only ever cost an exemption, never grant one.
 */
function sourceEndpointCandidates(source) {
  const candidates = new Set();
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(
      "index.ts",
      source,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );
  } catch {
    return candidates;
  }

  const builders = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    // EXACT package boundary, and only the SDK's endpoint-builder modules:
    // `firebase-functions`, `/v1`, `/v2` and their provider subpaths. A prefix
    // test would trust `firebase-functions-wrapper`; `firebase-functions/params`
    // and `/logger` export helpers that are not endpoint constructors.
    if (!/^firebase-functions(?:\/v[12](?:\/[a-z]+)*)?$/.test(specifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (/^on[A-Z]/.test(imported)) builders.add(element.name.text);
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      if (!initializer || !ts.isCallExpression(initializer)) continue;
      if (!ts.isIdentifier(initializer.expression)) continue;
      if (!builders.has(initializer.expression.text)) continue;
      candidates.add(declaration.name.text);
    }
  }
  return candidates;
}

/**
 * The configured `source` as a project-relative directory this classifier can
 * reproduce in a scratch tree, or `null`.
 *
 * `./functions`, `functions/` and `functions` all name one directory, and the
 * scratch copy must land at the same project-relative path so that a hook
 * spelled `npm --prefix functions run build` finds it. An absolute path or one
 * that climbs out of the project directory cannot be mirrored, so it is refused
 * rather than approximated (Codex P2, round 9).
 */
function normalizedSourcePath(source) {
  if (typeof source !== "string" || !source) return null;
  if (isAbsolute(source)) return null;
  const normalized = source.replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === "..") return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/** Hooks are given a generous ceiling; a real `tsc` build is seconds, not minutes. */
const PREDEPLOY_HOOK_TIMEOUT_MS = 300_000;
/** Loading the artifact is a require and a walk; anything slower is a hang. */
const ARTIFACT_WALK_TIMEOUT_MS = 20_000;

const ARTIFACT_WALKER = fileURLToPath(
  new URL("./firebase-artifact-endpoints.cjs", import.meta.url),
);

/**
 * `cross-env-shell`, resolved the way `firebase-tools` resolves it, so hooks run
 * through the same wrapper the deploy uses (`lifecycleHooks.js` `runCommand`).
 */
function crossEnvShellPath() {
  const crossEnv = require.resolve("cross-env", {
    paths: [dirname(require.resolve("firebase-tools/package.json")), process.cwd()],
  });
  return resolve(dirname(crossEnv), "bin", "cross-env-shell.js");
}

function runCapturedProcess(command, args, options) {
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      settle({ ok: false, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    // Captured, never inherited: this classifier's own stdout is the
    // machine-readable classification `deploy.sh` parses.
    let output = "";
    const collect = (chunk) => {
      if (output.length < 8192) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => settle({ ok: false, output: `${output}${error.message}` }));
    child.on("close", (code, signal) => {
      if (signal) settle({ ok: false, output: `${output}terminated with signal ${signal}` });
      else settle({ ok: code === 0, output, code });
    });
  });
}

/**
 * Run one `predeploy` entry exactly as `firebase-tools` does
 * (`lib/deploy/lifecycleHooks.js`): the whole value is handed to
 * `cross-env-shell` under a shell, with the PROJECT directory as cwd and the
 * codebase source directory exposed only through `$RESOURCE_DIR`.
 */
function runPredeployHook(command, { projectDir, resourceDir, project }) {
  // firebase-tools escapes only `"` when it wraps the hook. That is incomplete
  // for a command containing a BACKSLASH, which could close its own quote — so
  // such a command is REFUSED before it gets here rather than quoted some other
  // way, because running a different command from the one the deploy will run
  // is the one thing this classifier must not do. Backslashes are escaped too
  // so the transformation is total; over the accepted input it is byte-for-byte
  // what `runCommand` produces.
  const quoted = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const translated = `"${process.execPath}" "${crossEnvShellPath()}" "${quoted}"`;
  return runCapturedProcess(translated, [], {
    cwd: projectDir,
    shell: true,
    timeout: PREDEPLOY_HOOK_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      GCLOUD_PROJECT: project || "",
      PROJECT_DIR: projectDir,
      RESOURCE_DIR: resourceDir,
    },
  });
}

/**
 * A project directory whose Functions codebase is a WRITABLE COPY and whose
 * every other entry is a symlink to the original.
 *
 * A Functions build is not self-contained — this repository's own
 * `functions/src` imports `../../src/domainTypes`, and a hook may be spelled
 * with a project-relative `--prefix` — so the copy has to sit at the same
 * project-relative path inside a directory that otherwise looks like the whole
 * project. Symlinks give that view for the cost of one `readdir` per path
 * segment, where copying the project would mean copying whatever build output,
 * test artifacts, or nested worktrees happen to live in it.
 *
 * `.git` is deliberately NOT exposed: no Functions build needs it, and a hook
 * that reached through it would be reaching into the real repository.
 *
 * The boundary this draws is therefore exact rather than absolute: everything a
 * Functions build WRITES — the source dir and its artifact — is a copy, while
 * everything it READS outside that dir is the original. A hook that deliberately
 * wrote through one of the symlinks would touch the real tree, but that hook
 * writes to the same place a few steps later when `firebase deploy` runs it for
 * real, and `deploy.sh` builds the app after this point, so nothing it could
 * leave behind survives the deploy it precedes.
 */
async function stageProjectOverlay({ projectDir, scratchProject, sourceRel, links }) {
  const linkTo = async (from, to) => {
    const type = (await lstat(from)).isDirectory() ? "junction" : "file";
    await symlink(from, to, type);
    links.push(to);
  };

  let realDir = projectDir;
  let scratchDir = scratchProject;
  for (const segment of sourceRel.split("/")) {
    await mkdir(scratchDir, { recursive: true });
    for (const entry of await readdir(realDir)) {
      if (entry === segment || entry === ".git") continue;
      await linkTo(join(realDir, entry), join(scratchDir, entry));
    }
    realDir = join(realDir, segment);
    scratchDir = join(scratchDir, segment);
  }

  await cp(realDir, scratchDir, {
    recursive: true,
    dereference: false,
    // `node_modules` is symlinked instead: copying it would cost minutes, and
    // the deploy's own build reads the very same tree.
    filter: (entry) => basename(entry) !== "node_modules",
  });
  const modules = join(realDir, "node_modules");
  if (existsSync(modules)) await linkTo(modules, join(scratchDir, "node_modules"));
}

/**
 * The environment the CLI's own discovery process runs under.
 *
 * This matters because a `.env` value can decide whether an export is an
 * endpoint at all (`export const x = FLAG ? onObjectFinalized(…) : undefined`),
 * so a walk under the ambient shell environment could miss an endpoint the
 * deploy will create. `prepare.js` builds `{…userEnvs, …firebaseEnvs,
 * GOOGLE_CLOUD_QUOTA_PROJECT}` from the codebase's own dotenv files and hands
 * it to the delegate, whose `spawnFunctionsProcess` then passes through only
 * `HOME`, `PATH`, `NODE_ENV` and `FUNCTIONS_CONTROL_API` — deliberately NOT the
 * whole ambient environment. Both halves are mirrored, the dotenv half through
 * firebase-tools' own loader reading the staged copy.
 */
function discoveryEnvironment({ scratchProject, scratchSource, project }) {
  const userEnvs = functionsEnv.loadUserEnvs({
    functionsSource: scratchSource,
    projectId: project,
    projectDir: scratchProject,
  });
  const environment = {
    ...userEnvs,
    ...functionsEnv.loadFirebaseEnvs({ projectId: project }, project),
    GOOGLE_CLOUD_QUOTA_PROJECT: project,
    FUNCTIONS_CONTROL_API: "true",
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
  };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[key];
  }
  return environment;
}

/**
 * Refusing is the safe answer, but a silent refusal is an unexplained deploy
 * slowdown. `FIREBASE_DEPLOY_CLASSIFIER_DEBUG=1` prints the reason on STDERR —
 * never stdout, which carries the classification `deploy.sh` parses.
 */
function refused(reason) {
  if (process.env.FIREBASE_DEPLOY_CLASSIFIER_DEBUG) {
    console.error(`  classifier: artifact inventory refused — ${reason}`);
  }
  return { authoritative: false, reason, endpoints: [], groups: [] };
}

/**
 * Build a codebase the way the deploy will, then inventory the endpoint ids the
 * runtime loader would discover in the result.
 *
 * WHY BUILD. `--only functions:<name>` matches DEPLOYED ids, and those come
 * from `package.json.main` — the artifact — never from `src/index.ts`. Between
 * the two sit the `predeploy` hooks, the npm build script, npm's implicit
 * `pre`/`post` lifecycle scripts, and tsconfig; each is an arbitrary shell
 * program, and eight rounds of review found a new way for one of them to make
 * the artifact disagree with the source (`true || tsc`,
 * `tsc && cp group.js lib/index.js`, a `postbuild` swap, an earlier hook that
 * rewrites `src/index.ts`). Modelling shell semantics statically is unbounded;
 * running the program is exact.
 *
 * WHY THIS IS NOT NEW TRUST. These are the same hooks, from the same config,
 * that `firebase deploy` executes minutes later in the same working tree. The
 * only new thing is WHEN.
 *
 * WHY A SCRATCH PROJECT. Building in place would leave the classifier's own
 * artifact in the developer's tree. Instead `stageProjectOverlay` builds a
 * temporary project directory in which the CODEBASE SOURCE DIR is a real copy
 * (minus `node_modules`, symlinked so `tsc` and the SDK resolve) and every
 * other project entry is a symlink to the original. The copy is where a build
 * writes, so the working tree's Functions source and artifact are untouched;
 * the symlinks are what let a cross-directory import such as
 * `../../src/domainTypes` and a hook spelled `npm --prefix functions run build`
 * resolve exactly as they do in the real project.
 *
 * FAILS CLOSED on every uncertainty: an unmirrorable source path, a staging
 * failure, a non-zero or timed-out hook, a discovery manifest, an artifact that
 * will not load, or a walk that throws.
 */
async function buildAndInventoryArtifact({ projectDir, sourceRel, predeploy, project }) {
  const steps =
    typeof predeploy === "string"
      ? [predeploy]
      : Array.isArray(predeploy)
        ? predeploy
        : predeploy === undefined || predeploy === null
          ? []
          : null;
  if (steps === null || steps.some((step) => typeof step !== "string")) {
    return refused("predeploy is not a string or list of strings");
  }
  // See `runPredeployHook`: the CLI's own quoting does not survive a backslash,
  // so a hook containing one cannot be reproduced exactly and is refused rather
  // than approximated.
  if (steps.some((step) => step.includes("\\"))) {
    return refused("a predeploy hook contains a backslash, whose quoting cannot be mirrored");
  }

  const realSource = resolve(projectDir, sourceRel);
  if (!existsSync(realSource)) return refused(`no Functions source at ${sourceRel}`);

  const scratch = await mkdtemp(join(tmpdir(), "firebase-deploy-scope-"));
  const scratchProject = join(scratch, "project");
  const scratchSource = resolve(scratchProject, sourceRel);
  /** Every symlink this staging created, so cleanup can unlink them by name. */
  const links = [];
  try {
    try {
      await stageProjectOverlay({ projectDir, scratchProject, sourceRel, links });
    } catch (error) {
      return refused(
        `could not stage the Functions source — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const command of steps) {
      const hook = await runPredeployHook(command, {
        projectDir: scratchProject,
        resourceDir: scratchSource,
        project,
      });
      if (!hook.ok) {
        return refused(`predeploy hook failed: ${command} — ${hook.output.trim().slice(-400)}`);
      }
    }

    // The Node delegate tries `functions.yaml` BEFORE running the SDK's
    // discovery, so a manifest — committed, or written by a hook — decides the
    // deployed surface and the artifact no longer does
    // (`runtimes/node/index.js` `discoverBuild`). Refuse rather than parse it.
    const manifests = (await readdir(scratchSource)).filter((name) =>
      /^functions\.ya?ml$/i.test(name),
    );
    if (manifests.length > 0) {
      return refused(`${manifests[0]} supplies discovery instead of the artifact`);
    }

    let walkEnv;
    try {
      walkEnv = discoveryEnvironment({ scratchProject, scratchSource, project });
    } catch (error) {
      return refused(
        `could not load the codebase environment — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const outFile = join(scratch, "endpoints.json");
    const walk = await runCapturedProcess(
      process.execPath,
      [ARTIFACT_WALKER, scratchSource, outFile],
      {
        // cwd and environment both mirror the SDK process the CLI spawns.
        cwd: scratchSource,
        timeout: ARTIFACT_WALK_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: walkEnv,
      },
    );
    let reported;
    try {
      reported = JSON.parse(await readFile(outFile, "utf8"));
    } catch {
      return refused(
        `the artifact walk produced no result — ${walk.output.trim().slice(-400) || "no output"}`,
      );
    }
    if (!reported || reported.authoritative !== true || !Array.isArray(reported.endpoints)) {
      return refused(reported?.reason ?? "the artifact walk was inconclusive");
    }
    const groups = Array.isArray(reported.groups) ? reported.groups : [];
    if (process.env.FIREBASE_DEPLOY_CLASSIFIER_DEBUG) {
      console.error(`  classifier: ${sourceRel} deploys ${reported.endpoints.join(", ")}`);
      // Groups are the ids a `--only functions:<group>` scope expands to. They
      // never grant the exemption — the prefix rule below already refuses a
      // selector any of their endpoints falls inside — but they are what makes
      // such a refusal legible.
      if (groups.length > 0) console.error(`  classifier: ${sourceRel} groups ${groups.join(", ")}`);
    }
    return { authoritative: true, endpoints: reported.endpoints, groups };
  } finally {
    // Unlink the borrowed `node_modules` explicitly before the recursive
    // remove. `fs.rm` already unlinks symlinks rather than descending them,
    // but nothing about deleting a link INTO the repository should rest on
    // that alone.
    for (const link of links) await unlink(link).catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The artifact inventory for one codebase, built at most once per process.
 *
 * Lazy on purpose: a `--only hosting` run, a whole-codebase `--only functions`,
 * and every selector the source pre-check already refuses all classify without
 * building anything.
 *
 * Once per process is also the right lifetime. `deploy.sh` classifies once per
 * deploy, so the inventory describes the tree as it stood a few steps before
 * the release — the same window in which the app build and the deploy's own
 * predeploy run. Editing the codebase inside that window invalidates the
 * classification exactly as it invalidates everything else the deploy computed.
 */
function artifactEndpointInventory(entry) {
  if (!entry.artifactInventory) {
    entry.artifactInventory = buildAndInventoryArtifact(entry.build);
  }
  return entry.artifactInventory;
}

/**
 * Per-codebase inventory, plus the codebase names Firebase treats as selector
 * targets. Mirrors the pinned CLI rather than paraphrasing it.
 *
 * `codebaseNames` mirrors `getCodebasesFromConfig`: the EXPLICIT `codebase`
 * values (and a kit config's instance keys). An implicit default contributes
 * nothing, exactly as `[c.codebase]` contributes `undefined` there. This set is
 * what gives a codebase name precedence over an endpoint id, so it must include
 * codebases this classifier cannot build — a `remoteSource` codebase is still a
 * configured codebase (`projectConfig.js` accepts `source` OR `remoteSource`),
 * and omitting its name would let `functions:<name>` be read as a same-named
 * local endpoint while Firebase deploys that codebase's whole surface.
 *
 * `blocked` is tracked PER CODEBASE. `endpointMatchesFilter` rejects an endpoint
 * whose codebase differs from the filter's, so uncertainty in `beta` cannot
 * widen an explicitly qualified `alpha` deployment.
 */
async function singleEndpointInventory(configSource, configPath, project) {
  const functionsConfigs = Array.isArray(configSource.functions)
    ? configSource.functions
    : [configSource.functions];
  /**
   * @type {Map<string, {
   *   candidates: Set<string>,
   *   blocked: string | null,
   *   build: { projectDir: string, sourceRel: string, predeploy: unknown, project: string } | null,
   *   artifactInventory?: Promise<{ authoritative: boolean, endpoints: string[] }>,
   * }>}
   */
  const byCodebase = new Map();
  const codebaseNames = new Set();
  const projectDir = dirname(configPath);

  const entryFor = (codebase) => {
    let entry = byCodebase.get(codebase);
    if (!entry) {
      entry = { candidates: new Set(), blocked: null, build: null };
      byCodebase.set(codebase, entry);
    }
    return entry;
  };

  for (const functionsConfig of functionsConfigs) {
    if (!functionsConfig || typeof functionsConfig !== "object") continue;

    if ("kit" in functionsConfig) {
      // Kit instance keys are codebase names; their endpoints come from
      // somewhere this classifier does not build.
      for (const instance of Object.keys(functionsConfig.instances ?? {})) {
        codebaseNames.add(instance);
        entryFor(instance).blocked = "kit codebase";
      }
      continue;
    }

    const explicitCodebase =
      typeof functionsConfig.codebase === "string" && functionsConfig.codebase
        ? functionsConfig.codebase
        : "";
    if (explicitCodebase) codebaseNames.add(explicitCodebase);
    const codebase = explicitCodebase || "default";
    const entry = entryFor(codebase);

    const sourceRel = normalizedSourcePath(functionsConfig.source);
    if (!sourceRel) {
      // A remoteSource codebase (or any shape without a mirrorable local
      // source) exists and can be deployed; it simply cannot be built here.
      entry.blocked = "no mirrorable local source";
      continue;
    }

    // The CLI picks its runtime delegate from the configured runtime, so a
    // `python311` codebase's endpoints never come from the Node artifact this
    // classifier builds and walks.
    const runtime = functionsConfig.runtime;
    if (typeof runtime === "string" && !runtime.startsWith("nodejs")) {
      entry.blocked = `non-Node runtime ${runtime}`;
      continue;
    }

    // A configured `prefix` rewrites deployed ids to `<prefix>-<name>`, so an
    // inventory of the artifact's own export ids no longer describes what a
    // selector matches. Refuse rather than model the rewrite.
    if (functionsConfig.prefix) {
      entry.blocked = "configured id prefix";
      continue;
    }

    // Two configs sharing one codebase name would each need their own build;
    // the exemption is not worth the ambiguity.
    if (entry.build) {
      entry.blocked = "several configs share this codebase";
      continue;
    }
    entry.build = {
      projectDir,
      sourceRel,
      predeploy: functionsConfig.predeploy,
      project: project || "",
    };

    // The pre-check reads the conventional TypeScript entrypoint. A codebase
    // written some other way simply offers no candidates and is refused
    // without a build — false conservatism, never a false exemption.
    let source;
    try {
      source = await readFile(resolve(projectDir, sourceRel, "src", "index.ts"), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of sourceEndpointCandidates(source)) entry.candidates.add(name);
  }
  return { byCodebase, codebaseNames };
}

/**
 * Whether `selector` provably releases exactly one endpoint that is not a
 * protected callable. Fails closed on every uncertainty.
 */
async function selectorIsProvableSingleEndpoint(selector, inventory) {
  const tail = selector.slice("functions:".length);
  if (!tail) return false;
  const fragments = tail.split(":");
  if (fragments.length > 2) return false;

  let codebase;
  let name;
  if (fragments.length === 2) {
    // Both branches of parseFunctionSelector that see two fragments yield
    // `{codebase: fragments[0], idChunks: fragments[1]}` — whether or not the
    // first fragment is a CONFIGURED codebase. An unconfigured one simply
    // matches no endpoint, and falls out below as an absent inventory entry.
    codebase = fragments[0];
    name = fragments[1];
  } else if (inventory.codebaseNames.has(fragments[0])) {
    // Codebase precedence with no id fragment: the filter carries no idChunks,
    // so `endpointMatchesFilter` admits that codebase's every endpoint.
    return false;
  } else {
    // `fragments.length < 2` resolves to DEFAULT_CODEBASE, so an unqualified
    // selector never reaches another codebase and must not be vetoed by one.
    codebase = "default";
    name = fragments[0];
  }

  // idChunks split the ID fragment on `-` and `.`, then match
  // `id === prefix || id.startsWith(prefix + "-")`. Either separator makes the
  // selector a prefix/group filter rather than one endpoint. Applied to the ID
  // fragment ONLY: hyphens are valid in codebase names (`validateCodebase`).
  if (name.includes(".") || name.includes("-")) return false;

  const entry = inventory.byCodebase.get(codebase);
  if (!entry || entry.blocked || !entry.build) return false;
  // Fast pre-check: no build for a name the source never declares as a builder
  // call. This can only withhold an exemption, never grant one.
  if (!entry.candidates.has(name)) return false;

  const artifact = await artifactEndpointInventory(entry);
  if (!artifact.authoritative) return false;
  // `endpointMatchesFilter`, applied to the ids the runtime loader would
  // actually discover: the selector is one endpoint only when exactly one
  // deployed id falls inside it, and that id is the name itself.
  const matched = artifact.endpoints.filter(
    (id) => id === name || id.startsWith(`${name}-`),
  );
  return matched.length === 1 && matched[0] === name;
}

/**
 * Codebase precedence, checked BEFORE any endpoint-name branch. The pinned CLI
 * resolves a bare `functions:<name>` whose name is a CONFIGURED codebase to
 * that codebase's entire surface (`functionsDeployHelper.js:43-53`), even when
 * the same string is also the id of a protected endpoint. Such a surface may
 * carry any protected callable, so the caller treats it as an unfamiliar group.
 */
function selectorNamesConfiguredCodebase(selector, inventory) {
  if (!selector.startsWith("functions:")) return false;
  const tail = selector.slice("functions:".length);
  return tail !== "" && !tail.includes(":") && inventory.codebaseNames.has(tail);
}

async function eventInvitationServiceInventory(configSource, configPath) {
  const functionsConfigs = Array.isArray(configSource.functions)
    ? configSource.functions
    : [configSource.functions];
  const services = new Set();
  for (const functionsConfig of functionsConfigs) {
    if (!functionsConfig || typeof functionsConfig.source !== "string") continue;
    const sourcePath = resolve(
      dirname(configPath),
      functionsConfig.source,
      "src",
      "index.ts",
    );
    let source;
    try {
      source = await readFile(sourcePath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    for (const service of eventInvitationServicesFromSource(source))
      services.add(service);
  }
  return EVENT_INVITATION_EXPORTS.map(([, service]) => service).filter(
    (service) => services.has(service),
  );
}

async function classifyInvokerScope(
  only,
  exceptTargets,
  exportedEventInvitationServices,
  singleEndpointExports = { byCodebase: new Map(), codebaseNames: new Set() },
) {
  const exportedInvitationServices = new Set(exportedEventInvitationServices);
  const exportedInvitationCsv = EVENT_INVITATION_EXPORTS.map(
    ([, service]) => service,
  )
    .filter((service) => exportedInvitationServices.has(service))
    .join(",");
  let functionsAttempted = true;
  let hostingAttempted = true;
  let bugReportInvokerSelected = true;
  let emailUnsubscribeInvokerSelected = true;
  let authHandoffInvokerSelected = true;
  let eventInvitationsInvokerSelected = exportedInvitationServices.size > 0;
  let bugReportInvokerConservative = false;
  let emailUnsubscribeInvokerConservative = false;
  let authHandoffInvokerConservative = false;
  let eventInvitationsInvokerConservative = false;
  let authHandoffStrictHalf = "";
  let eventInvitationsStrictServices = exportedInvitationCsv;

  if (only) {
    functionsAttempted = false;
    hostingAttempted = false;
    bugReportInvokerSelected = false;
    emailUnsubscribeInvokerSelected = false;
    authHandoffInvokerSelected = false;
    eventInvitationsInvokerSelected = false;
    let mintNamed = false;
    let exchangeNamed = false;
    let fullEventInvitationScopeNamed = false;
    let unknownFunctionsSelectorNamed = false;
    const namedEventInvitationServices = new Set();
    // An unfamiliar Functions selector may release anything, so every invoker
    // not already selected by an explicit branch turns conservative.
    const selectEveryInvokerConservatively = () => {
      functionsAttempted = true;
      unknownFunctionsSelectorNamed = true;
      if (!bugReportInvokerSelected) bugReportInvokerConservative = true;
      if (!emailUnsubscribeInvokerSelected)
        emailUnsubscribeInvokerConservative = true;
      if (!authHandoffInvokerSelected) authHandoffInvokerConservative = true;
      if (!eventInvitationsInvokerSelected)
        eventInvitationsInvokerConservative = true;
      bugReportInvokerSelected = true;
      emailUnsubscribeInvokerSelected = true;
      authHandoffInvokerSelected = true;
      eventInvitationsInvokerSelected = true;
    };

    for (const selector of only.split(",")) {
      if (selector === "hosting" || selector.startsWith("hosting:")) {
        hostingAttempted = true;
      } else if (selector === "functions" || selector === "functions:default") {
        functionsAttempted = true;
        bugReportInvokerSelected = true;
        emailUnsubscribeInvokerSelected = true;
        authHandoffInvokerSelected = true;
        eventInvitationsInvokerSelected = exportedInvitationServices.size > 0;
        mintNamed = true;
        exchangeNamed = true;
        fullEventInvitationScopeNamed = true;
        bugReportInvokerConservative = false;
        emailUnsubscribeInvokerConservative = false;
        authHandoffInvokerConservative = false;
        eventInvitationsInvokerConservative = false;
      } else if (
        selectorNamesConfiguredCodebase(selector, singleEndpointExports)
      ) {
        // A configured codebase that happens to share a protected endpoint's
        // name deploys its whole surface, not that endpoint: precedence must
        // win before the name branches below can read it as one callable.
        selectEveryInvokerConservatively();
      } else if (/^functions:(?:[^:]+:)?submitBugReport$/.test(selector)) {
        functionsAttempted = true;
        bugReportInvokerSelected = true;
        bugReportInvokerConservative = false;
      } else if (/^functions:(?:[^:]+:)?emailUnsubscribe$/.test(selector)) {
        functionsAttempted = true;
        emailUnsubscribeInvokerSelected = true;
        emailUnsubscribeInvokerConservative = false;
      } else if (/^functions:(?:[^:]+:)?mintAuthHandoff$/.test(selector)) {
        functionsAttempted = true;
        authHandoffInvokerSelected = true;
        mintNamed = true;
      } else if (/^functions:(?:[^:]+:)?exchangeAuthHandoff$/.test(selector)) {
        functionsAttempted = true;
        authHandoffInvokerSelected = true;
        exchangeNamed = true;
      } else if (/^functions:(?:[^:]+:)?mintEventInvitation$/.test(selector)) {
        functionsAttempted = true;
        eventInvitationsInvokerSelected = true;
        namedEventInvitationServices.add("mint");
      } else if (
        /^functions:(?:[^:]+:)?redeemEventInvitation$/.test(selector)
      ) {
        functionsAttempted = true;
        eventInvitationsInvokerSelected = true;
        namedEventInvitationServices.add("redeem");
      } else if (
        /^functions:(?:[^:]+:)?revokeEventInvitation$/.test(selector)
      ) {
        functionsAttempted = true;
        eventInvitationsInvokerSelected = true;
        namedEventInvitationServices.add("revoke");
      } else if (selector.startsWith("functions:")) {
        functionsAttempted = true;
        // `functions:[codebase:]name` — a DOTTED tail is a group path
        // (`--only functions:group1.subgroup1`), never a single endpoint, so it
        // is left to the conservative branch below along with everything the
        // inventory cannot vouch for.
        if (await selectorIsProvableSingleEndpoint(selector, singleEndpointExports)) {
          // A named endpoint that the source proves is a builder call, not a
          // group. It cannot release a protected callable, so it selects no
          // invoker and forces no conservatism. Protected callables never reach
          // here — each has its own branch above.
          continue;
        }
        selectEveryInvokerConservatively();
      }
    }

    if (authHandoffInvokerSelected) {
      if (mintNamed && exchangeNamed) {
        authHandoffInvokerConservative = false;
      } else if (mintNamed) {
        authHandoffInvokerConservative = false;
        authHandoffStrictHalf = "mint";
      } else if (exchangeNamed) {
        authHandoffInvokerConservative = false;
        authHandoffStrictHalf = "exchange";
      }
    }

    if (eventInvitationsInvokerSelected) {
      if (fullEventInvitationScopeNamed) {
        eventInvitationsInvokerConservative = false;
        eventInvitationsStrictServices = exportedInvitationCsv;
      } else if (namedEventInvitationServices.size > 0) {
        // An explicit endpoint name is a fact even when another unfamiliar
        // selector appears in the same request. Keep every explicitly named
        // service strict and tolerate absence only for its unselected peers.
        eventInvitationsInvokerConservative = false;
        eventInvitationsStrictServices = ["mint", "redeem", "revoke"]
          .filter((service) => namedEventInvitationServices.has(service))
          .join(",");
      } else {
        eventInvitationsInvokerConservative = unknownFunctionsSelectorNamed;
        eventInvitationsStrictServices = "";
      }
    } else {
      eventInvitationsStrictServices = "";
    }
  } else if (exceptTargets) {
    for (const selector of exceptTargets.split(",")) {
      if (selector === "hosting") hostingAttempted = false;
      if (selector === "functions") {
        functionsAttempted = false;
        bugReportInvokerSelected = false;
        emailUnsubscribeInvokerSelected = false;
        authHandoffInvokerSelected = false;
        eventInvitationsInvokerSelected = false;
        bugReportInvokerConservative = false;
        emailUnsubscribeInvokerConservative = false;
        authHandoffInvokerConservative = false;
        eventInvitationsInvokerConservative = false;
        eventInvitationsStrictServices = "";
      }
      // firebase-tools subtracts --except selectors from exact top-level
      // target names. Every colon-qualified Functions exclusion is a no-op.
    }
  }

  return {
    functionsAttempted,
    hostingAttempted,
    bugReportInvokerSelected,
    emailUnsubscribeInvokerSelected,
    authHandoffInvokerSelected,
    eventInvitationsInvokerSelected,
    bugReportInvokerConservative,
    emailUnsubscribeInvokerConservative,
    authHandoffInvokerConservative,
    eventInvitationsInvokerConservative,
    authHandoffStrictHalf,
    eventInvitationsStrictServices,
  };
}

export async function classifyFirebaseDeployRequest(
  args,
  {
    defaultProject = "",
    defaultConfigPath = "firebase.json",
    rejectDestinationOverrides = false,
  } = {},
) {
  if (rejectDestinationOverrides && hasNamedDestinationOverride(args)) {
    assertNoNamedDestinationOverride(args);
  }

  const { operands, options } = parseFirebaseOptions(args);
  if (operands.length > 1)
    throw new Error("too many Firebase deploy project arguments");

  const positionalProject = operands[0] ?? "";
  let project = options.project || defaultProject || positionalProject;
  if (!project) {
    try {
      const rc = JSON.parse(await readFile(resolve(".firebaserc"), "utf8"));
      project = rc.projects?.default ?? "";
    } catch {
      // firebase-tools reports the missing project later. Classification stays
      // useful for repos whose local-only deploy checks do not need one.
    }
  }
  const configPath = resolve(options.config ?? defaultConfigPath);
  const only = normalizedFilter(options.only);
  const exceptTargets = normalizedFilter(options.except);
  const configSource = JSON.parse(await readFile(configPath, "utf8"));
  const exportedEventInvitationServices =
    await eventInvitationServiceInventory(configSource, configPath);
  const singleEndpointExports = await singleEndpointInventory(
    configSource,
    configPath,
    project,
  );
  // deploy's before-chain runs this target reduction before
  // checkValidTargetFilters. It is the pinned rejection boundary for an
  // option-looking required value such as `--only --dry-run`: Commander owns
  // `--dry-run` as the --only value, then filterTargets rejects that value as
  // an unknown deploy target before any build can start.
  filterTargets(
    {
      only,
      except: exceptTargets,
      config: new Config(configSource, { projectDir: dirname(configPath) }),
    },
    [...VALID_DEPLOY_TARGETS],
  );
  await checkValidTargetFilters({ only, except: exceptTargets });
  const hostingOptions = {
    config: { src: configSource },
    site: project || undefined,
  };
  let hostingConfigs = extract(hostingOptions);
  hostingConfigs = filterOnly(hostingConfigs, only);
  hostingConfigs = filterExcept(hostingConfigs, exceptTargets);

  // The invoker scope is resolved LAST, because proving an exact
  // single-endpoint selector runs the codebase's own predeploy hooks in a
  // scratch copy. Everything cheap and everything that can reject the request
  // outright has already happened.
  const invokerScope = await classifyInvokerScope(
    only,
    exceptTargets,
    exportedEventInvitationServices,
    singleEndpointExports,
  );

  return {
    project,
    configPath,
    only: only ?? "",
    except: exceptTargets ?? "",
    firebaseDryRun: options.dryRun === true,
    ...invokerScope,
    hostingAttempted: hostingConfigs.length > 0,
  };
}

function printShellClassification(result) {
  const fields = {
    DEPLOY_PROJECT: result.project,
    FUNCTIONS_ATTEMPTED: result.functionsAttempted,
    HOSTING_ATTEMPTED: result.hostingAttempted,
    FIREBASE_DRY_RUN: result.firebaseDryRun,
    BUG_REPORT_INVOKER_SELECTED: result.bugReportInvokerSelected,
    EMAIL_UNSUBSCRIBE_INVOKER_SELECTED: result.emailUnsubscribeInvokerSelected,
    AUTH_HANDOFF_INVOKER_SELECTED: result.authHandoffInvokerSelected,
    EVENT_INVITATIONS_INVOKER_SELECTED: result.eventInvitationsInvokerSelected,
    BUG_REPORT_INVOKER_CONSERVATIVE: result.bugReportInvokerConservative,
    EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE:
      result.emailUnsubscribeInvokerConservative,
    AUTH_HANDOFF_INVOKER_CONSERVATIVE: result.authHandoffInvokerConservative,
    AUTH_HANDOFF_STRICT_HALF: result.authHandoffStrictHalf,
    EVENT_INVITATIONS_INVOKER_CONSERVATIVE:
      result.eventInvitationsInvokerConservative,
    EVENT_INVITATIONS_STRICT_SERVICES: result.eventInvitationsStrictServices,
  };
  for (const [key, value] of Object.entries(fields))
    console.log(`${key}=${value}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  try {
    const result = await classifyFirebaseDeployRequest(args, {
      defaultProject: process.env.FIREBASE_DEPLOY_DEFAULT_PROJECT ?? "",
      defaultConfigPath:
        process.env.FIREBASE_DEPLOY_DEFAULT_CONFIG ?? "firebase.json",
      rejectDestinationOverrides:
        process.env.FIREBASE_DEPLOY_REJECT_OVERRIDES === "true",
    });
    if (process.env.FIREBASE_DEPLOY_CLASSIFIER_FORMAT === "shell")
      printShellClassification(result);
    else console.log(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ Invalid Firebase deploy request: ${message}.`);
    console.error("  NOTHING HAS BEEN BUILT OR PUBLISHED.");
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
