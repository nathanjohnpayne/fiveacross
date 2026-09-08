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
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const {
  VALID_DEPLOY_TARGETS,
  isDeployingWebFramework,
} = require("firebase-tools/lib/deploy");
const { filterTargets } = require("firebase-tools/lib/filterTargets");
const {
  extract,
  filterExcept,
  filterOnly,
} = require("firebase-tools/lib/hosting/config");
const functionsEnv = require("firebase-tools/lib/functions/env");
const portfinder = require("portfinder");

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

/**
 * The attached short-option spellings the pinned CLI accepts, written out so
 * the parser below reads them the same way.
 *
 * The pinned CLI parses on commander 5, which reads `-Pfoo` / `-cfoo` /
 * `-pdist` as a short flag with an attached value. The commander this
 * classifier parses on splits any `-abc` into `-a -b -c`, so `-pdist` becomes
 * `-p -d -i -s -t` — and `-pf` becomes `-p -f`, whose value is then the string
 * `-f` rather than `f`. Every short option that TAKES A VALUE and whose value
 * this classifier reads is therefore split here first: `-P`/`-c` because they
 * redirect the deploy's destination, and `-p` because it moves a Hosting
 * predeploy hook's `$RESOURCE_DIR` — see `applyPublicDirectoryOverride`.
 */
function normalizeAttachedShortOptions(args) {
  return args.flatMap((argument) => {
    if (/^-P.+/.test(argument)) return ["-P", argument.slice(2)];
    if (/^-c.+/.test(argument)) return ["-c", argument.slice(2)];
    if (/^-p.+/.test(argument)) return ["-p", argument.slice(2)];
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
    parser.normalize(normalizeAttachedShortOptions(args)),
  );
  if (parsed.unknown.length > 0) parser.unknownOption(parsed.unknown[0]);
  return { operands: parsed.args, options: parser.opts() };
}

function normalizedFilter(value) {
  // The pinned CLI's option parser splits a filter list on commas AND
  // whitespace (`command.js`: `.split(/[\s,]+/)`), so `--only "functions:daily,
  // functions:submitBugReport"` releases both functions. The same split is
  // applied here before anything is planned or classified from the string
  // (Codex P1, round 22 on #1107); the pieces are rejoined with commas, which
  // is the form every consumer below already expects.
  if (!value) return undefined;
  const pieces = String(value)
    .split(/[\s,]+/)
    .filter((piece) => piece.length > 0);
  return pieces.length > 0 ? pieces.join(",") : undefined;
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
/** Serving the manifest is a load and a walk; anything slower is a hang. */
const DISCOVERY_TIMEOUT_MS = 20_000;

const DISCOVERY_PRELOAD = fileURLToPath(
  new URL("./firebase-discovery-preload.cjs", import.meta.url),
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

/** A timed-out process gets this long to actually die before we stop waiting. */
const KILL_GRACE_MS = 5_000;

/**
 * How long a run that settles on `exit` waits for the verdict descriptor to
 * end before giving up on it.
 *
 * The pipe ends as soon as every writer has let go, which the group kill
 * guarantees, so this is reached only by a holder that would not die.
 */
const CHANNEL_DRAIN_MS = 2_000;

/**
 * Environment variables that exist ONLY because this classifier ran.
 *
 * `deploy.sh` sets each of these on the classifier's own command line — they
 * are how it passes the pinned project, the pinned config path, the override
 * policy and the output format — and it sets NONE of them on the `firebase
 * deploy` that follows. A predeploy hook run from here would therefore see a
 * variable its real run cannot, and a hook that branches on one produces an
 * artifact the deploy will not (Codex P2, round 17). They are deleted from the
 * hook environment for the same reason `process.execArgv` is emptied in the
 * discovery preload: the host this classifier presents must be the host the
 * deploy presents.
 *
 * `FIREBASE_DEPLOY_CLASSIFIER_DEBUG` is deliberately NOT in this list. Nothing
 * sets it per-invocation; a developer exports it into the shell, where the real
 * `firebase deploy` inherits it too. Stripping it would MANUFACTURE the
 * divergence this list exists to remove.
 *
 * The discovery children need no such filter: `discoveryEnvironment` builds
 * their environment from `{}` rather than from `process.env`, so nothing
 * ambient reaches them in the first place (`assert`ed by the deployment-safety
 * suite, because that is a property of the code rather than of a list).
 *
 * `REHEARSAL_MARKER_VAR` runs the other way and is the one deliberate
 * exception: it is ADDED to both the hook and the discovery environments,
 * because it is the only tag that survives a `setsid` and so the only way to
 * find a descendant that escaped the process group. Its own docblock states
 * what that costs.
 */
const CLASSIFIER_PRIVATE_ENV = Object.freeze([
  "FIREBASE_DEPLOY_DEFAULT_PROJECT",
  "FIREBASE_DEPLOY_DEFAULT_CONFIG",
  "FIREBASE_DEPLOY_REJECT_OVERRIDES",
  "FIREBASE_DEPLOY_CLASSIFIER_FORMAT",
  // The wrapper names the established ADC document to THIS classifier, and to
  // nothing else: `firebase deploy` is handed the document through
  // `GOOGLE_APPLICATION_CREDENTIALS` and never sees this name, so a hook that
  // could read it here would be reading a variable its real run cannot.
  "FIREBASE_DEPLOY_ESTABLISHED_CREDENTIAL",
  // Never ambient — the classifier sets it on a discovery child — but a shell
  // that had it set would make the preload's watch look like the codebase's own
  // configuration.
  "FIREBASE_DEPLOY_SCOPE_WATCH_RUNTIME_CONFIG",
]);

function withoutClassifierPrivateEnv(environment) {
  const cleaned = { ...environment };
  for (const key of CLASSIFIER_PRIVATE_ENV) delete cleaned[key];
  return cleaned;
}

/**
 * The environment `scripts/firebase/op-firebase-deploy` establishes before it
 * invokes `firebase deploy`, so a predeploy hook run from here sees what its
 * real run will see.
 *
 * `lifecycleHooks.js` `getChildEnvironment` hands a hook `{...process.env,
 * GCLOUD_PROJECT, PROJECT_DIR, RESOURCE_DIR}` — and `process.env` there is the
 * WRAPPER's, not a developer's bare shell. Supplying only `GCLOUD_PROJECT` left
 * a hook that branches on `GOOGLE_CLOUD_PROJECT` (or on the quota project)
 * building one artifact here and another during the deploy (Codex P2, round
 * 18). Every name below is a pure function of the PINNED project, so it is
 * reproducible exactly; the two per-run temporaries the wrapper also exports
 * are handled by `productionCredentialEnvironment`.
 *
 * Discovery deliberately gets NONE of this. `spawnFunctionsProcess` builds its
 * child's environment as `{...envs, FUNCTIONS_CONTROL_API, HOME, PATH,
 * NODE_ENV, __FIREBASE_FRAMEWORKS_ENTRY__}` — the wrapper's variables never
 * reach it — so adding them to `discoveryEnvironment` would MANUFACTURE the
 * divergence this function exists to remove.
 */
function productionHookEnvironment(project) {
  return {
    GOOGLE_CLOUD_PROJECT: project,
    GCLOUD_PROJECT: project,
    CLOUDSDK_BILLING_QUOTA_PROJECT: project,
    CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "true",
  };
}

/**
 * The ADC document the hooks will run against, or the reason there is none.
 *
 * WHY A SYNTHETIC ONE IS NOT AN OPTION. The wrapper's documented default path
 * hands `op-firebase-deploy` the TARGET service account directly, so the
 * document it establishes is a `service_account` carrying the real
 * `client_email`; the rehearsal used to write an `impersonated_service_account`
 * for an obviously synthetic account instead. A hook that merely INSPECTS that
 * JSON — its `type`, its `client_email` — therefore took one branch here and
 * the other during the deploy, with nothing failing and nothing drifting to
 * say so: an exact endpoint in the rehearsal, a protected group for real, and
 * the invoker reconciliation switched off for it (Codex P1, round 26 on
 * #1107). The same shape is not the same document, and "a hook that only reads
 * the shape behaves the same" was the assumption that was wrong.
 *
 * SO THE INVARIANT IS BYTES, NOT SHAPE: the rehearsal runs the hooks against
 * the very document the deploy will, or it does not claim to have rehearsed
 * them. `FIREBASE_DEPLOY_ESTABLISHED_CREDENTIAL` is the seam a wrapper uses to
 * name that document; supplying it is an assertion that this file is the one
 * `GOOGLE_APPLICATION_CREDENTIALS` will point at during `firebase deploy`, in
 * the same family as the pinned project and config path `deploy.sh` already
 * passes in. Nothing here reads its contents.
 *
 * WITHOUT IT, EVERY EXEMPTION IS REFUSED — a standalone invocation, a dry run,
 * this repository's own deployment-safety harness, and `deploy.sh` itself,
 * which cannot supply one: `op-firebase-deploy` mints that document inside its
 * own process, immediately before `firebase deploy`, and deletes it in its own
 * EXIT trap, and it refuses to run an arbitrary command under the credential it
 * establishes. So there is no point in the wrapper's sequence at which the real
 * document exists and nothing has been published yet. The refusal is the
 * conservative answer to that, and it is the answer this classifier gives for
 * every other input it cannot reproduce.
 */
async function establishedDeployCredential(path) {
  if (!path) {
    return {
      ok: false,
      reason:
        "no established deploy credential was supplied (FIREBASE_DEPLOY_ESTABLISHED_CREDENTIAL), so a " +
        "predeploy hook that reads the ADC document would see a different credential here than the " +
        "deploy will establish for it",
    };
  }
  const resolved = resolve(path);
  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) {
      return {
        ok: false,
        reason: `the established deploy credential at ${resolved} is not a file`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `the established deploy credential at ${resolved} could not be read — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { ok: true, path: resolved };
}

/**
 * The two variables the wrapper points at freshly made TEMPORARIES, reproduced
 * for the rehearsal.
 *
 * `XDG_CONFIG_HOME` is exact: the wrapper's is a `mktemp -d`, an empty
 * directory that exists only for that deploy, and so is this one.
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` is the document `establishedDeployCredential`
 * settled on, passed through by PATH rather than copied, so a hook reads the
 * same bytes the deploy's own hooks will. Running them against it costs one
 * more run with a credential they run with anyway; the write containment is
 * still in force, so what that credential can reach is unchanged from every
 * other program this rehearsal starts. There is no third state: a run with no
 * established document never reaches here, because the whole project has
 * already been refused.
 */
async function productionCredentialEnvironment(scratch, credentialPath) {
  const configHome = join(scratch, "configstore");
  await mkdir(configHome, { recursive: true });
  return { XDG_CONFIG_HOME: configHome, GOOGLE_APPLICATION_CREDENTIALS: credentialPath };
}

const POSIX = process.platform !== "win32";

/**
 * Run a child to completion, capturing its output, under a deadline that
 * bounds the WHOLE process tree.
 *
 * `spawn`'s own `timeout` option is not enough: it signals the immediate child,
 * and a shell's descendants keep the inherited stdio pipes open, so the awaited
 * `close` waits on them and the documented ceiling bounds nothing (Codex P2,
 * round 10, reproduced with `sleep 2` under a 100ms timeout). The child is
 * therefore its own process group and the deadline kills the group, with a
 * grace timer so that even an unkillable descendant cannot hold this open.
 */
function runCapturedProcess(
  command,
  args,
  {
    timeout,
    settleOn = "close",
    inheritStdin = false,
    extraChannel = false,
    // The diagnostic capture is bounded so a chatty hook cannot balloon a
    // classification, but a caller whose OUTPUT is the answer — the git-answer
    // fingerprint (Phase 4b P2, run 5) — passes `Infinity`, because a changed
    // ref past the cap would otherwise fall in a discarded suffix.
    outputLimit = 8192,
    ...options
  },
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        ...options,
        detached: POSIX,
        // stdout and stderr must be pipes — this process's own stdout carries
        // the classification `deploy.sh` parses, and a hook writing to it would
        // corrupt that. stdin is inherited, as `lifecycleHooks` inherits all
        // three, so a hook that tests whether it has one behaves the same here.
        stdio: [
          inheritStdin ? "inherit" : "ignore",
          "pipe",
          "pipe",
          ...(extraChannel ? ["pipe"] : []),
        ],
      });
    } catch (error) {
      resolve({ ok: false, output: error instanceof Error ? error.message : String(error) });
      return;
    }

    // Captured, never inherited: this classifier's own stdout is the
    // machine-readable classification `deploy.sh` parses.
    let output = "";
    // Anything the child wrote on the extra descriptor. A channel the child
    // cannot unlink and the parent alone holds.
    let channel = "";
    let settled = false;
    /**
     * Whether the DEADLINE fired, which a caller has to be able to see.
     * Settling on `exit` reports a killed child as an ordinary termination, so
     * without this a run that blew its ceiling is indistinguishable from one
     * that merely failed (Phase 4b, runs 6 and 7 on #1107).
     */
    let timedOut = false;
    let deadline;
    let grace;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      resolve(result);
    };
    const collect = (chunk) => {
      if (output.length < outputLimit) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.stdio[3]?.on("data", (chunk) => {
      if (channel.length < 1024) channel += chunk.toString("utf8");
    });
    /**
     * Wait for the verdict descriptor to END, then settle.
     *
     * Settling on `exit` is what keeps the deadline honest, but `exit` fires as
     * soon as the child is gone — before the parent has necessarily read what
     * it wrote on descriptor 3, which is the one signal this runner must not
     * lose. The pipe ends once every writer has let go; the group kill in the
     * settle path above is what makes that happen, and the bound is here so
     * that a holder which will not die cannot keep this open either.
     */
    const drainChannel = (done) => {
      const verdict = child.stdio[3];
      if (!verdict || verdict.destroyed || verdict.readableEnded) {
        done();
        return;
      }
      let drained = false;
      const complete = () => {
        if (drained) return;
        drained = true;
        clearTimeout(bound);
        verdict.destroy();
        done();
      };
      const bound = setTimeout(complete, CHANNEL_DRAIN_MS);
      verdict.on("end", complete);
      verdict.on("close", complete);
      verdict.on("error", complete);
    };
    child.on("error", (error) => settle({ ok: false, output: `${output}${error.message}`, channel }));
    child.on(settleOn, (code, signal) => {
      // On `exit` the pipes may still be open (a background descendant holds
      // them). Nothing more will be read, so drop them rather than let them
      // keep this process alive.
      if (settleOn === "exit") {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      // Whether the hook left descendants behind, and then their end (Codex
      // P1, rounds 14 and 17 on #1107). Firebase moves on when the immediate
      // shell exits and never kills what it backgrounded, so a descendant
      // such as `(sleep 0.2; cp group.js lib/index.js) &` finishes on its own
      // clock during the real deploy — before or after discovery, nobody can
      // say. This rehearsal cannot reproduce that race, so the CALLER refuses
      // the exemption when descendants remain (`descendantsLeft`), and the
      // group is still ended here so nothing outlives the rehearsal into the
      // live tree, the final fingerprint or the build. The child is its own
      // process group precisely so both are one signal; libuv has reaped the
      // child itself by the time `exit` fires, so a group that still answers
      // holds only descendants.
      let descendantsLeft = false;
      if (POSIX && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 0);
          descendantsLeft = true;
        } catch {
          // Empty group: nothing was left running.
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      const answer = signal
        ? { ok: false, output: `${output}terminated with signal ${signal}`, descendantsLeft, timedOut }
        : { ok: code === 0, output, code, descendantsLeft, timedOut };
      // `channel` is read when the drain finishes, not now: whatever the child
      // wrote on descriptor 3 may still be in the pipe at `exit`.
      drainChannel(() => settle({ ...answer, channel }));
    });

    deadline = setTimeout(() => {
      timedOut = true;
      try {
        if (POSIX && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone; the grace timer below settles either way.
        }
      }
      grace = setTimeout(
        () => settle({ ok: false, output: `${output}timed out after ${timeout}ms`, channel, timedOut: true }),
        KILL_GRACE_MS,
      );
    }, timeout);
  });
}

/** How long the containment canary gets to write its files and exit. */
const CONTAINMENT_PROBE_TIMEOUT_MS = 30_000;

/** One argument, as a POSIX shell will read it back verbatim. */
function shellQuote(argument) {
  return `'${String(argument).replaceAll("'", `'\\''`)}'`;
}

/** Whether `path` is `root` or sits below it. */
function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** A path as the kernel resolves it, which is the form both mechanisms match on. */
async function resolvedPath(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * The macOS profile: everything a process may normally do, except WRITE outside
 * the writable set.
 *
 * `(allow default)` first, then a blanket `(deny file-write*)`, then the
 * carve-outs — SBPL takes the LAST matching rule, so the order is the policy.
 * `/dev` is the piece node cannot do without: a shell opens its controlling
 * terminal, and `> /dev/null` is in half the hooks anyone writes.
 *
 * Verified on this repository's development Mac (Darwin 25.6.0): a contained
 * `/bin/sh` writes inside the writable set, and its writes outside it are denied
 * BOTH by absolute path and through a symlink that points at them — the sandbox
 * canonicalises the path before it matches, so the overlay's links into the
 * checkout are not a way around this. `npm run build` and the `tsc` it runs
 * finish normally inside it.
 */
function macosSandboxProfile(writable) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writable.map((path) => `(allow file-write* (subpath ${JSON.stringify(path)}))`),
    '(allow file-write* (subpath "/dev"))',
    "",
  ].join("\n");
}

/**
 * The mechanisms that can hold a rehearsal's writes inside the writable set, in
 * the order they are tried on this platform.
 *
 * Each is an argv PREFIX: put in front of a command and its arguments it yields
 * the contained form of that run, which is what lets one mechanism serve both
 * the shelled-out predeploy hooks and the directly spawned discovery process.
 *
 * macOS has one: `sandbox-exec`, deprecated for a decade, still present, and
 * still the only unprivileged path-scoped write policy the platform offers.
 *
 * Linux has three, tried in order. `bwrap` is preferred and is the exact
 * counterpart of the macOS profile — the whole filesystem read-only, the
 * writable set bound back over it — so both platforms deny the same paths.
 * `unshare` is the fallback for a machine without `bwrap`: an unprivileged
 * user+mount namespace in which the roots that must not be written are
 * bind-mounted read-only over themselves. That is the same guarantee stated from
 * the other side, and it is why the canary below is written in terms of those
 * roots rather than of a mechanism. The two `unshare` spellings differ only in
 * how the caller is mapped into the namespace, which older util-linux releases
 * and stricter kernels each refuse in their own way.
 *
 * NOT VERIFIED HERE. The Linux forms were written against the documented
 * behaviour of `bwrap` and `unshare`; this repository's development machine is
 * a Mac, so only the `sandbox-exec` form has been exercised by hand. That is
 * precisely why nothing is trusted without the canary: on a Linux machine where
 * none of the three works, the canary fails, the exemption is refused, and every
 * deploy classifies conservatively rather than silently running hooks loose.
 */
function writeContainmentCandidates({ writable, readOnlyRoots, profilePath }) {
  if (process.platform === "darwin") {
    return [{ label: "sandbox-exec", prefix: ["/usr/bin/sandbox-exec", "-f", profilePath] }];
  }
  if (process.platform === "linux") {
    const bwrap = ["bwrap", "--ro-bind", "/", "/"];
    // Applied after the read-only root, so each replaces what it covered.
    bwrap.push("--proc", "/proc", "--dev-bind", "/dev", "/dev");
    for (const path of writable) bwrap.push("--bind", path, path);
    bwrap.push("--");
    // Bind each read-only root over itself, then remount that bind read-only —
    // two steps, because Linux applies `ro` to a bind mount only on the
    // remount. Anything unmountable fails the whole run rather than leaving a
    // root writable, and the canary would catch it either way.
    const readOnly =
      'for d in "$1" "$2"; do [ -n "$d" ] || continue; ' +
      'mount --bind "$d" "$d" && mount -o remount,bind,ro "$d" "$d" || exit 111; ' +
      'done; shift 2; exec "$@"';
    const unshare = (label, mapping) => ({
      label,
      prefix: [
        "unshare",
        ...mapping,
        "--mount",
        "--",
        "/bin/sh",
        "-c",
        readOnly,
        "sh",
        readOnlyRoots[0] ?? "",
        readOnlyRoots[1] ?? "",
      ],
    });
    return [
      { label: "bwrap", prefix: bwrap },
      // The current user first: a rehearsal running as uid 0 would answer an
      // `id -u` test differently from the deploy, and mapping the caller still
      // carries, inside the new namespace, the capability the bind mounts need.
      unshare("unshare (current user)", ["--user", "--map-current-user"]),
      // The classic `unshare -rm`, for a util-linux without `--map-current-user`.
      // It maps the caller to uid 0 INSIDE the namespace, which is a divergence
      // a hook can see; it is last for that reason, and it is still preferable
      // to running the hook with no containment at all — which is the only other
      // thing left at this point.
      unshare("unshare (root-mapped)", ["--user", "--map-root-user"]),
    ];
  }
  return [];
}

/**
 * WRITE CONTAINMENT: a mechanism under which every process this rehearsal
 * starts is unable to write outside the scratch root and the system temp dir,
 * whatever it does to escape everything else.
 *
 * WHY DETECTION IS NOT ENOUGH. Every other guard here answers AFTER the fact —
 * the process group is signalled when a step ends, the marker sweep scans for
 * what escaped it, the live-tree fingerprint compares before with after. All
 * three are answers, and an answer does not neutralise a writer that is already
 * running. A hook can `spawn(cmd, {detached: true, stdio: "ignore", env:
 * {…explicit}})`: `setsid` puts the worker beyond any group signal, the explicit
 * environment withholds `REHEARSAL_MARKER_VAR` so the sweep cannot find it
 * either, and on macOS `ps -E` would have withheld the environment of a
 * SIP-protected binary regardless. Such a worker sleeps past the fingerprint,
 * outlives the scratch directory it can no longer see, and writes a deployment
 * input through an absolute live path minutes later — after `deploy.sh` accepted
 * the conservative classification and carried on (Phase 4b P1 on #1107).
 *
 * So the containment comes FIRST, and its answer is the same for the escapee as
 * for the hook: the write does not land, whenever it is attempted and whatever
 * the classification said. The group kill, the marker sweep and the fingerprints
 * all stay behind it, as defence in depth for a mechanism that is one kernel bug
 * from being wrong — and because a process that escaped is still one whose
 * effect on the artifact this rehearsal cannot reproduce, which is a refusal
 * even when it wrote nothing.
 *
 * WHAT STAYS WRITABLE, AND WHY THAT IS ENOUGH. The scratch root, which is where
 * the build belongs, and the system temp dir, which is where the toolchain puts
 * everything from `mktemp` to a compiler's spill files — carving it out would
 * mean handing every contained program a temp dir of this classifier's choosing,
 * which is one more way to tell this run from the deploy. Nothing a Firebase
 * deploy publishes is read from the temp dir: the deployment inputs are the
 * checkout, and the checkout is what this denies. The consequence to state
 * plainly is that a project directory placed INSIDE the system temp dir is not
 * contained — no real deploy is, and the fixtures that prove this behaviour are
 * deliberately staged outside it.
 *
 * PROBED, NEVER ASSUMED. Nothing here is trusted until a contained canary has
 * failed to write outside the writable set while succeeding inside it.
 * `sandbox-exec` is deprecated, `bwrap` may be absent, an unprivileged user
 * namespace may be administratively disabled, and each of those failures is
 * silent in the direction that matters. A mechanism that does not pass, and a
 * platform with no mechanism at all, REFUSE — before any hook or probe runs,
 * because preceding them is the whole point.
 */
async function establishWriteContainment({ scratchRoot, projectDir, mode }) {
  if (mode === "unavailable") {
    return {
      ok: false,
      reason: "write containment was disabled for this run, so no hook may be executed",
    };
  }
  // Resolved, because both mechanisms match on the path the kernel resolves:
  // macOS's `/var/folders/…` is `/private/var/folders/…`, and a subpath rule
  // written the other way would match nothing and deny the scratch root along
  // with everything else.
  const root = await resolvedPath(scratchRoot);
  const temp = await resolvedPath(tmpdir());
  const writable = [...new Set([root, temp])];

  /**
   * The roots a contained child must NOT be able to write, and the canary's
   * targets. The live checkout is the one that matters; the home directory is
   * there because the checkout is not always the whole of what a hook can
   * reach, and because it answers the same question when the checkout itself
   * lies inside the writable set — which only a fixture's does.
   */
  const readOnlyRoots = [];
  for (const path of [await resolvedPath(projectDir), await resolvedPath(homedir())]) {
    if (writable.some((allowed) => within(path, allowed))) continue;
    if (!readOnlyRoots.includes(path)) readOnlyRoots.push(path);
  }
  if (readOnlyRoots.length === 0) {
    return {
      ok: false,
      reason:
        "every directory this classifier could prove containment against lies inside the writable set, " +
        "so a hook's writes cannot be shown to stay out of the live checkout",
    };
  }

  const profilePath = join(root, "write-containment.sb");
  if (process.platform === "darwin") {
    try {
      await writeFile(profilePath, macosSandboxProfile(writable), "utf8");
    } catch (error) {
      return {
        ok: false,
        reason: `write containment could not be prepared — ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const candidates = writeContainmentCandidates({ writable, readOnlyRoots, profilePath });
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        `${process.platform} offers no mechanism this classifier can use to keep a rehearsal's writes ` +
        "out of the live checkout, so no predeploy hook is run here",
    };
  }
  const failures = [];
  for (const candidate of candidates) {
    const proof = await proveWriteContainment(candidate, { root, readOnlyRoots });
    if (proof.ok) {
      return {
        ok: true,
        label: candidate.label,
        /** The contained form of a directly spawned command. */
        wrap: (command, args) => ({
          command: candidate.prefix[0],
          args: [...candidate.prefix.slice(1), command, ...args],
        }),
        /** The contained form of a command a shell will parse. */
        wrapShell: (command) => `${candidate.prefix.map(shellQuote).join(" ")} ${command}`,
      };
    }
    failures.push(`${candidate.label}: ${proof.reason}`);
  }
  return {
    ok: false,
    reason:
      "no write containment could be proved on this machine, so a hook could write into the live " +
      `checkout after this classification returned (${failures.join("; ")})`,
  };
}

/**
 * The canary: one contained child, a write it must be denied for every
 * read-only root, one it must be allowed inside the scratch, and the filesystem
 * as the verdict.
 *
 * Both halves are load-bearing — a mechanism that denied everything, or a
 * command that never ran at all, would pass a test that only asked whether the
 * checkout had been written to.
 *
 * Each canary path is uniquely named and removed if it lands, so a broken
 * mechanism leaves the tree as it found it. Its presence is the whole finding in
 * miniature: it is the write this classifier could not otherwise prevent.
 */
async function proveWriteContainment(candidate, { root, readOnlyRoots }) {
  const inside = join(root, `containment-canary-${randomUUID()}`);
  const outside = readOnlyRoots.map((path) =>
    join(path, `.firebase-deploy-scope-canary-${randomUUID()}`),
  );
  const script = [inside, ...outside]
    .map((path) => `printf canary > ${shellQuote(path)}`)
    .concat("exit 0")
    .join("; ");
  const run = await runCapturedProcess(
    candidate.prefix[0],
    [...candidate.prefix.slice(1), "/bin/sh", "-c", script],
    {
      cwd: root,
      timeout: CONTAINMENT_PROBE_TIMEOUT_MS,
      env: withoutClassifierPrivateEnv(process.env),
    },
  );
  const escaped = [];
  for (const path of outside) {
    if (!existsSync(path)) continue;
    escaped.push(path);
    await unlink(path).catch(() => {});
  }
  const contained = existsSync(inside);
  await unlink(inside).catch(() => {});
  if (escaped.length > 0) {
    return { ok: false, reason: `a contained child still wrote ${escaped.join(", ")}` };
  }
  if (!contained) {
    return {
      ok: false,
      reason: `a contained child could not write inside the scratch root — ${
        run.output.trim().slice(-200) || `exit ${run.code ?? "?"}`
      }`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * The environment variable every process this rehearsal starts carries.
 *
 * WHY A MARKER AT ALL. The process GROUP is what bounds a rehearsal's children,
 * and it is not enough: `spawn(..., { detached: true, stdio: "ignore" })` calls
 * `setsid`, which puts the new process in a session no group signal can reach
 * (Phase 4b, run 6 on #1107). Such a descendant outlives the rehearsal and goes
 * on writing — into the live checkout during the BUILD that follows, where the
 * fingerprint is no longer watching anything. Finding one needs a tag that
 * survives both `setsid` and `exec`, and the environment is the only carrier
 * that does: `cwd` is defeated by a `cwd` option, an inherited descriptor by
 * `stdio: "ignore"`, and the process group by `setsid` itself.
 *
 * WHY IT IS NO LONGER THE CONTAINMENT. A hook that spawns with an EXPLICIT
 * `env` withholds this marker as easily as it escapes the group, so the sweep
 * cannot be what stops such a worker — `establishWriteContainment` is, and it
 * stops it by making the write impossible rather than by finding the writer.
 * The marker stays because a process that escaped is still a process whose
 * effect on the artifact this rehearsal cannot reproduce, and because a
 * containment mechanism is one kernel bug from being wrong: it is now the
 * second layer, not the first.
 *
 * WHAT IT COSTS. A hook and an artifact can both READ this variable, and the
 * real deploy does not set it — one more way to tell the rehearsal from the
 * deploy, which is the divergence `CLASSIFIER_PRIVATE_ENV` exists to remove.
 * It is accepted here, and only here, because a program written to detect the
 * rehearsal can already do so from `$PROJECT_DIR` alone (see
 * `liveTreeFingerprint` § WHAT NO REHEARSAL CAN CLOSE): the marker adds no
 * capability that was not already there, while withholding it leaves an
 * escaped process that nobody can find.
 */
const REHEARSAL_MARKER_VAR = "FIREBASE_DEPLOY_SCOPE_REHEARSAL";

/**
 * Every live process still carrying THIS run's marker, and whether the platform
 * could be asked at all.
 *
 * Linux reads `/proc/<pid>/environ`, which answers for every process of the
 * same user. macOS has no `/proc`, so the question goes to `ps -E`, which
 * prints a process's environment after its command — verified on macOS 26,
 * where `ps -A -E -o pid=,stat=,command=` shows a detached `node` child's
 * variables. A zombie state is skipped: a process that has been killed and not
 * yet reaped is not one that can still act.
 *
 * PLATFORM COVERAGE, HONESTLY. On macOS `ps -E` WITHHOLDS the environment of a
 * process whose executable is a SIP-protected platform binary — `/bin/sleep`
 * and `/bin/sh` among them — so a descendant that both detaches and execs one
 * of those carries the marker and hides it. That residual is macOS's alone, it
 * is the same class as the residuals `liveTreeFingerprint` documents, and it is
 * stated rather than papered over. Every other platform, Windows included,
 * reports `scanned: false`, and the caller refuses the exemption rather than
 * reading silence as an all-clear.
 */
async function markedProcesses(marker) {
  /** @type {number[]} */
  const pids = [];
  const wanted = `${REHEARSAL_MARKER_VAR}=${marker}`;
  if (process.platform === "linux") {
    let entries;
    try {
      entries = await readdir("/proc");
    } catch (error) {
      return { scanned: false, pids, reason: `/proc could not be read (${error?.code ?? "?"})` };
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let environ;
      try {
        environ = await readFile(`/proc/${entry}/environ`, "utf8");
      } catch {
        // Gone already, or not ours to read. Either way it is not this run's.
        continue;
      }
      if (environ.split("\u0000").includes(wanted)) pids.push(Number(entry));
    }
    return { scanned: true, pids, reason: null };
  }
  if (process.platform === "darwin") {
    const listing = await runCapturedProcess("ps", ["-A", "-E", "-o", "pid=,stat=,command="], {
      timeout: 10_000,
      // The listing IS the answer, so it is not truncated to the diagnostic cap.
      outputLimit: Infinity,
    });
    if (!listing.ok) {
      return { scanned: false, pids, reason: "ps could not list the process table" };
    }
    for (const line of listing.output.split("\n")) {
      const row = /^\s*(\d+)\s+(\S+)\s+([\s\S]*)$/.exec(line);
      if (!row) continue;
      if (row[2].startsWith("Z")) continue;
      if (!row[3].includes(wanted)) continue;
      pids.push(Number(row[1]));
    }
    return { scanned: true, pids, reason: null };
  }
  return {
    scanned: false,
    pids,
    reason: `${process.platform} cannot be scanned for processes this rehearsal started`,
  };
}

/**
 * End every process this rehearsal started that is still running, and report
 * what was found.
 *
 * Run at the end of EVERY rehearsal — each predeploy hook and each project
 * probe — because a process that escaped one of them is loose for all of them.
 */
async function sweepEscapedProcesses(marker) {
  const found = await markedProcesses(marker);
  for (const pid of found.pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between the scan and the signal. It is still counted: it ran.
    }
  }
  return found;
}

/**
 * Run one `predeploy` entry exactly as `firebase-tools` does
 * (`lib/deploy/lifecycleHooks.js`): the whole value is handed to
 * `cross-env-shell` under a shell, with the PROJECT directory as cwd and the
 * codebase source directory exposed only through `$RESOURCE_DIR`.
 */
function runPredeployHook(
  command,
  { projectDir, resourceDir, project, timeoutMs, deployEnv, rehearsalMarker, containment },
) {
  // firebase-tools escapes only `"` when it wraps the hook. That is incomplete
  // for a command containing a BACKSLASH, which could close its own quote — so
  // such a command is REFUSED before it gets here rather than quoted some other
  // way, because running a different command from the one the deploy will run
  // is the one thing this classifier must not do. Backslashes are escaped too
  // so the transformation is total; over the accepted input it is byte-for-byte
  // what `runCommand` produces.
  const quoted = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const translated = `"${process.execPath}" "${crossEnvShellPath()}" "${quoted}"`;
  // Under the write containment, which the caller established and proved before
  // this hook — or any other program of the config's — was allowed to start.
  // The mechanism is an argv prefix, so the shell parses it and then the hook's
  // own translated command exactly as it would have without one.
  return runCapturedProcess(containment.wrapShell(translated), [], {
    cwd: projectDir,
    shell: true,
    inheritStdin: true,
    // `runCommand` settles on `exit`, so Firebase moves on as soon as the
    // immediate shell is done and never waits for a background descendant.
    // Waiting for `close` here would let this classifier observe a LATER tree
    // than the deploy discovers from (Codex P2, round 12).
    settleOn: "exit",
    timeout: timeoutMs ?? PREDEPLOY_HOOK_TIMEOUT_MS,
    env: {
      ...withoutClassifierPrivateEnv(process.env),
      // The production wrapper's own exports, so the hook's view of the
      // deployment is the one it will have when Firebase runs it.
      ...productionHookEnvironment(project || ""),
      ...deployEnv,
      // This rehearsal's own tag, so a process the hook detaches into its own
      // session can still be found and ended — see `REHEARSAL_MARKER_VAR` for
      // why that is worth one more variable the real deploy does not set.
      [REHEARSAL_MARKER_VAR]: rehearsalMarker,
      // `getChildEnvironment`'s three, applied LAST exactly as it applies them.
      GCLOUD_PROJECT: project || "",
      PROJECT_DIR: projectDir,
      RESOURCE_DIR: resourceDir,
    },
  });
}

/**
 * The nearest `.git` ABOVE `projectDir`, or null when there is none — which is
 * to say: whether the configured Firebase project sits BELOW a repository root.
 *
 * That layout is refused outright (see `nestedProjectRefusal`), so this is a
 * detector rather than something the staging then has to reproduce.
 */
function nearestAncestorGit(projectDir) {
  let dir = dirname(projectDir);
  for (;;) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Where the staged project sits inside its scratch root. */
const STAGED_PROJECT_DIRNAME = "project";

/**
 * Why a `firebase.json` BELOW a repository root can never be proved exact, or
 * null when the configured project directory is the root of its own checkout.
 *
 * WHAT THE GUARDS WATCH. Everything this rehearsal knows about is reached from
 * the configured project directory: `stageProjectOverlay` stages that directory,
 * and `liveTreeFingerprint` watches exactly what the staging exposed — the
 * project's own entries, the directories it symlinked, the files it copied. A
 * checkout-rooted config makes that set the whole repository, which is the
 * property the fingerprint's guarantee rests on.
 *
 * WHAT A NESTED CONFIG BREAKS. With `-c deploy/firebase.json` the deploy's
 * inputs are the whole checkout while the watched set is only `deploy/`. A hook
 * launched through npm inherits `INIT_CWD` pointing at the checkout root, so
 * `printf x > "$INIT_CWD/src/App.tsx"` changes application source the deploy is
 * about to build and publish — outside every watched directory, so no
 * fingerprint moves; outside `.git`'s answers, so the metadata fingerprint has
 * nothing to report either. Classification succeeds, `deploy.sh` carries on, and
 * the build packages a file written after the clean-tree guard approved the tree
 * (Phase 4b P1 on #1107).
 *
 * WHY REFUSING RATHER THAN WATCHING MORE. Widening the watch to the whole
 * ancestor checkout would mean fingerprinting a tree this classifier never
 * staged and cannot bound — on this repository that is build output, coverage,
 * and agent worktrees which are themselves full checkouts. The exemption is
 * worth about ten seconds of invoker reconciliation; it is not worth a guard
 * whose cost is unbounded. So the layout itself is the refusal, and the
 * exemption requires `firebase.json` at the checkout root.
 *
 * BEFORE ANYTHING RUNS. The check is made before the scratch directory exists
 * and before the first predeploy hook or discovery probe is started, because a
 * conservative answer reached after running the hook is an answer reached after
 * the hook already wrote.
 */
function nestedProjectRefusal(projectDir, ancestorGit) {
  if (!ancestorGit) return null;
  return (
    `the Firebase config directory ${projectDir} sits below the repository root ${dirname(ancestorGit)}, ` +
    "so this deploy's inputs include a checkout this rehearsal neither stages nor watches — a hook " +
    "reaching it through an inherited absolute path such as $INIT_CWD would change what the deploy " +
    "publishes without moving any fingerprint. No selector in this project can be proved exact"
  );
}

/**
 * The repository's own metadata, exposed at `to` so a `git` call from a build
 * answers as it does during the deploy, and registered so that a change in what
 * `git` ANSWERS is caught.
 *
 * A worktree or submodule checkout spells `.git` as a FILE holding
 * `gitdir: <path>`; copying it verbatim keeps the pointer working, where a
 * symlink to the file would resolve the same way but leave the scratch
 * project's own `.git` outside the copy. What is RECORDED either way is that a
 * repository is now reachable, which is what makes `gitAnswerFingerprint` run
 * at all.
 */
async function exposeGitMetadata(from, to, links, metadataDirs, plan) {
  if ((await lstat(from)).isDirectory()) {
    if (!plan) {
      await symlink(from, to, "junction");
      links.push(to);
    }
    metadataDirs.push(from);
    return;
  }
  if (!plan) await cp(from, to, { dereference: true, preserveTimestamps: true });
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(from, "utf8"));
  if (!pointer) return;
  const gitDir = resolve(dirname(from), pointer[1]);
  if (existsSync(gitDir)) metadataDirs.push(gitDir);
}

/**
 * Give every COPIED DIRECTORY the timestamps of the one it was copied from.
 *
 * `fs.cp`'s `preserveTimestamps` covers files and nothing else: under this
 * repository's Node every directory the copy creates carries the moment the
 * copy created it. So a hook that makes an incremental decision from a
 * DIRECTORY's mtime — `[ "$RESOURCE_DIR" -ot "$PROJECT_DIR/stamp" ]`, the
 * directory-level form of the file comparison rounds 17 and 19 already fixed —
 * saw a past-dated `$RESOURCE_DIR` during the deploy and a freshly stamped one
 * here, and could emit a direct endpoint in the rehearsal and a protected group
 * for real (Codex P1, round 26 on #1107).
 *
 * DEEPEST-FIRST, because writing into a directory stamps it: restoring a parent
 * before its children would have every child's `utimes` move the parent's mtime
 * forward again. The walk therefore settles a directory's contents first and
 * touches the directory itself last, up to and including the staged project
 * root — which is a `mkdir` rather than a copy and so carries a fresh mtime for
 * the same reason.
 *
 * SYMLINKS ARE SKIPPED, and not merely because a link is not a copy: `utimes`
 * FOLLOWS one, so touching a symlinked project directory would stamp the LIVE
 * directory it points at — a write into the very checkout everything else here
 * exists to keep untouched, and one the fingerprint would then report as drift.
 * `readdir`'s dirents report the entry's own type, so a link to a directory
 * never satisfies `isDirectory()`; the explicit test states the intent.
 *
 * An original that cannot be read leaves the copy's own times alone rather than
 * inventing any. That is the same direction as every other uncertainty here:
 * the rehearsal may answer differently from the deploy, and the fingerprint
 * bracket around the staging is what notices the disappearance.
 */
async function restoreCopiedDirectoryTimes(from, to) {
  let entries;
  try {
    entries = await readdir(to, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    await restoreCopiedDirectoryTimes(join(from, entry.name), join(to, entry.name));
  }
  await copyDirectoryTimes(from, to);
}

/**
 * One directory's `atime`/`mtime`, taken from the directory it was copied from.
 *
 * Separate from the walk above because `copyStagedProject` recurses on its own
 * and restores each level as that level returns, which is the same deepest-first
 * order by construction. See `restoreCopiedDirectoryTimes` for why the order
 * matters and why an unreadable original is left alone.
 */
async function copyDirectoryTimes(from, to) {
  try {
    const original = await stat(from);
    await utimes(to, original.atime, original.mtime);
  } catch {
    // Unreadable or gone: the copy keeps its own times.
  }
}

/**
 * A project directory in which EVERY configured Functions source dir is a
 * writable copy and every other entry is a symlink to the original.
 *
 * A Functions build is not self-contained — this repository's own
 * `functions/src` imports `../../src/domainTypes`, and a hook may be spelled
 * with a project-relative `--prefix` — so each copy has to sit at the same
 * project-relative path inside a directory that otherwise looks like the whole
 * project. Symlinks give that view for the cost of one `readdir` per path
 * segment, where copying the project would mean copying whatever build output,
 * test artifacts, or nested worktrees happen to live in it.
 *
 * ALL source dirs are copied, not just the one being inventoried, because
 * Firebase may run another codebase's hook in the same deploy and that hook can
 * write anywhere (`getReleventConfigs`; see `relevantFunctionsConfigs`).
 *
 * `.git` IS exposed, read-only in effect — as an ENTRY of the project directory,
 * which is the only layout that reaches here: a `firebase.json` BELOW a
 * repository root is refused before any of this runs (see
 * `nestedProjectRefusal`), so there is never an ancestor repository to stand in
 * for. Omitting it did not withhold
 * authority, it changed valid behaviour: a build that selects its exports with
 * `git rev-parse --abbrev-ref HEAD` sees `main` during the deploy and a failed
 * lookup here, and if its fallback happens to be the single endpoint both
 * probes agree and the group is wrongly exempted (Codex P2, round 18). So the
 * repository's metadata is exposed the same way every other project directory
 * is — a symlink — and guarded, by `gitAnswerFingerprint`, on the property that
 * matters: a run that changed what `git` ANSWERS forfeits the exemption. It is
 * registered in `metadataDirs` rather than `liveDirs` because the consequence
 * differs: a write into the working tree changes what the deploy will publish
 * and is fatal, while a change in what `git` says makes the inventory unusable
 * but leaves nothing for the deploy to publish that this run put there.
 *
 * The boundary this draws is therefore exact rather than absolute: everything a
 * Functions build WRITES — a source dir and its artifact — is a copy, while
 * everything it READS outside those dirs is the original. A hook that
 * deliberately writes THROUGH one of those symlinks still reaches the live
 * checkout, so every symlinked directory is registered in `liveDirs` and
 * `liveTreeFingerprint` watches the lot: a write there does not corrupt the
 * answer, it ends the deploy (Codex P2, round 17; made fatal in round 18 — see
 * `LiveCheckoutDriftError`).
 *
 * `plan: true` runs the same walk and CREATES NOTHING: it fills the four live
 * sets and returns, so the caller can fingerprint the watched tree BEFORE the
 * first byte is copied. That is the only way to have a before-snapshot whose
 * keys match the after-snapshot's, because which paths are watched is decided
 * by this walk. It costs one `readdir` per project directory the overlay
 * traverses — the source dirs are not entered at all, since the copy is what
 * would enter them — against a copy that can run for seconds. See
 * `buildAndInventoryProject` for what the bracket catches.
 */
async function stageProjectOverlay({
  projectDir,
  scratchProject,
  sourceRels,
  links,
  liveDirs,
  liveFiles,
  liveEntryDirs,
  metadataDirs,
  plan = false,
}) {
  const linkTo = async (from, to) => {
    if (plan) return;
    const type = (await lstat(from)).isDirectory() ? "junction" : "file";
    await symlink(from, to, type);
    links.push(to);
  };

  /**
   * Every symlink the copy preserved, checked against the scratch project's
   * boundary.
   *
   * `fs.cp`'s default `verbatimSymlinks: false` REWRITES a copied link to point
   * at its original target, so a relative link inside a Functions source came
   * out of the copy as an ABSOLUTE link back into the live checkout — and a
   * hook writing through it mutated the developer's tree, in directories
   * `liveDirs` does not watch (Codex P2, round 18). The copy is therefore
   * verbatim, which lands a relative link inside the copy where it belongs, and
   * anything still pointing OUT of the scratch project — every absolute link,
   * and any relative one that climbs past the project root — is refused rather
   * than reproduced. A link that resolves inside the project but outside the
   * copy (this repository's own `functions/src` reaches `../../src`) is kept:
   * it lands on one of the overlay's watched symlinks, where a write is
   * detected rather than silent.
   */
  const refuseEscapingLinks = async (scratchDir) => {
    for (const entry of await readdir(scratchDir, { withFileTypes: true })) {
      const path = join(scratchDir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = resolve(dirname(path), target);
        const inside = relative(scratchProject, resolved);
        if (isAbsolute(target) || inside.startsWith("..") || isAbsolute(inside)) {
          throw new Error(
            `${relative(scratchProject, path)} is a symlink to ${target}, which leaves the staged project`,
          );
        }
      } else if (entry.isDirectory()) {
        await refuseEscapingLinks(path);
      }
    }
  };

  const copySourceDir = async (realDir, scratchDir) => {
    /** Every `node_modules` the copy skipped, at whatever depth it sat. */
    const skipped = [];
    await cp(realDir, scratchDir, {
      recursive: true,
      dereference: false,
      // Links are copied as they are written, not rewritten to absolute paths
      // into the live tree. See `refuseEscapingLinks`.
      verbatimSymlinks: true,
      // Timestamps travel with the copy (Codex P1, round 17 on #1107): an
      // incremental hook that compares `src/index.ts -ot shared/stamp` must
      // see the same answer here as in the live tree, and a copy that
      // refreshed every mtime would rehearse a build Firebase never runs.
      // FILES only — a copied DIRECTORY still carries the moment the copy made
      // it, which `restoreCopiedDirectoryTimes` puts back once the whole walk
      // has finished writing (Codex P1, round 26).
      preserveTimestamps: true,
      // `node_modules` is symlinked instead: copying it would cost minutes,
      // and the deploy's own build reads the very same tree. EVERY one is
      // relinked, not just the source root's — a nested package resolves its
      // dependencies from its own tree, and dropping it would silently shift
      // resolution to an outer version (Codex P2, round 13).
      filter: (entry) => {
        if (basename(entry) !== "node_modules") return true;
        skipped.push(entry);
        return false;
      },
    });
    // Before the borrowed `node_modules` links are added, which are absolute by
    // construction and are the one exception this walk must not see.
    await refuseEscapingLinks(scratchDir);
    for (const modules of skipped) {
      await linkTo(modules, join(scratchDir, relative(realDir, modules)));
    }
  };

  const overlay = async (realDir, scratchDir, remaining) => {
    if (!plan) await mkdir(scratchDir, { recursive: true });
    // Every directory the overlay traverses to place a nested source
    // (`packages` for `packages/functions`) has its ENTRY SET watched, not just
    // its existing children (Phase 4b P1, run 4): a hook creating
    // `$INIT_CWD/packages/generated.ts` is otherwise in neither snapshot.
    liveEntryDirs.push(realDir);
    const claimed = new Set(remaining.map((segments) => segments[0]));
    for (const entry of await readdir(realDir)) {
      if (claimed.has(entry)) continue;
      const from = join(realDir, entry);
      const to = join(scratchDir, entry);
      if (entry === ".git") {
        await exposeGitMetadata(from, to, links, metadataDirs, plan);
        continue;
      }
      // FILES are copied, directories symlinked. A symlinked `firebase.json`
      // is a hook's route into the live checkout — `cp evil.json firebase.json`
      // would rewrite the very config the deploy is about to read, after the
      // dirty-tree guard has already passed (Codex P2, round 15). Project-root
      // files are small; copying them costs nothing and closes that route for
      // every deployment input at once.
      if ((await lstat(from)).isDirectory()) {
        await linkTo(from, to);
        // A route from a hook into the live checkout, and so exactly what the
        // mutation guard has to watch.
        liveDirs.push(from);
      } else {
        // Timestamps travel with the copy for the same reason they do in the
        // source copy (Codex P1, round 19): an incremental hook comparing a
        // source file against a root stamp must answer here as it does live.
        if (!plan) await cp(from, to, { dereference: true, preserveTimestamps: true });
        // Copied, not linked — and STILL watched (Codex P1, round 15 on
        // #1107). The overlay closes the relative route to this file, but a
        // hook launched through npm inherits `INIT_CWD` pointing at the live
        // repository, and any absolute path reaches the original the copy was
        // taken from. What the deploy will read is the live file, so the live
        // file is fingerprinted.
        liveFiles.push(from);
      }
    }
    for (const segment of claimed) {
      const nextReal = join(realDir, segment);
      const nextScratch = join(scratchDir, segment);
      const deeper = remaining
        .filter((segments) => segments[0] === segment)
        .map((segments) => segments.slice(1));
      // A source dir that also CONTAINS another source dir is copied whole,
      // which places the nested one too.
      if (deeper.some((segments) => segments.length === 0)) {
        if (!plan) await copySourceDir(nextReal, nextScratch);
        // The copied source directory's live original is watched for the same
        // reason the copied root files are: a hook can write through an
        // absolute path into `functions/lib` of the checkout the deploy will
        // actually build from (Codex P1, round 15 on #1107).
        liveDirs.push(nextReal);
      } else {
        await overlay(nextReal, nextScratch, deeper);
      }
    }
  };

  await overlay(
    projectDir,
    scratchProject,
    sourceRels.map((relative) => relative.split("/")),
  );
  // LAST, after every copy and every link this walk makes, because each of them
  // stamps the directory it lands in. See `restoreCopiedDirectoryTimes`: the
  // copy preserves a file's timestamps and a directory's are the copy's own, so
  // a hook that reads a directory mtime would answer differently here than in
  // the deploy until they are put back.
  if (!plan) await restoreCopiedDirectoryTimes(projectDir, scratchProject);
}

/**
 * The byte that separates a fingerprint entry's KIND from its path.
 *
 * NUL is the only byte a POSIX path cannot contain, so a key built from it
 * cannot be produced by any filename, however the file is named.
 */
const FINGERPRINT_KEY_SEPARATOR = "\u0000";

/**
 * One fingerprint entry's key: what is being recorded, and about which path.
 *
 * `kind` is one of `path` (the entry's own `lstat`), `self` (a watched
 * directory's own `lstat`, as distinct from its children's), `entries` (a
 * directory's sorted entry names), `root-entries` (the same for the project
 * root) and `target` (what a symlink reaches).
 */
function fingerprintKey(kind, path) {
  return `${kind}${FINGERPRINT_KEY_SEPARATOR}${path}`;
}

/** A fingerprint key as the drift diagnostics name it — the path always first. */
function describeFingerprintKey(key) {
  const at = key.indexOf(FINGERPRINT_KEY_SEPARATOR);
  if (at === -1) return key;
  const kind = key.slice(0, at);
  const path = key.slice(at + 1);
  if (kind === "self") return `${path} (self)`;
  if (kind === "entries") return `${path} (entries)`;
  if (kind === "root-entries") return `${path} (root entries)`;
  if (kind === "target") return `${path} -> target`;
  return path;
}

/**
 * A signature of everything reachable through the overlay's symlinks, so that a
 * write into the live checkout can be DETECTED even though it cannot be
 * prevented.
 *
 * WHY NOT JUST COPY THE PROJECT. Because the directories at issue are exactly
 * the ones whose size is unbounded — this repository's own checkout carries
 * build output, coverage, and agent worktrees that are themselves full
 * checkouts — and paying that copy on every deploy to guard against a hook
 * nobody has written is the wrong trade. Detection is a metadata walk of about
 * 1,500 entries here, some 15ms, and it is STRICTLY safer than a copy: a copy
 * only relocates writes it anticipated, while this notices any write at all and
 * forfeits the exemption, which is the conservative answer the classifier would
 * have given without building.
 *
 * WHY IT CANNOT BE FORGED. The signature includes `ctimeNs`, the inode change
 * time, which no userspace call can set — `utimensat` restores `mtime` but
 * stamps `ctime` with the current time, so a hook that writes a file and then
 * covers its tracks is MORE visible, not less. Creations, deletions and renames
 * fall out of the path set rather than any timestamp.
 *
 * `node_modules` is watched ONE level deep at every depth it appears: it is
 * relinked deliberately, because the deploy's own build reads and writes that
 * very tree, and walking it would cost more than everything else combined —
 * but a hook can leave a marker at its root for the deploy's second run to
 * find (Codex P1, round 22), so the tree's own signature, its entry set and its
 * top-level entries are recorded. A write buried inside one dependency's own
 * files is the out-of-tree-state residual stated below. Nothing else is
 * excluded.
 *
 * WHAT NO REHEARSAL CAN CLOSE. A hook that inspects the rehearsal itself — the
 * scratch path `$PROJECT_DIR` resolves to, the symlinked project directories
 * (`[ -L shared ]`), the process tree it runs under — can tell this run from
 * the deploy and behave differently in each (Codex P1, round 19 on #1107).
 * Parity against a hook that wants to detect the rehearsal is unattainable by
 * construction: staging real directories would leave the path, and copying
 * the project to the live path is the deploy. This is the same residual the
 * design states for a hook that keeps state in `$HOME`, `/tmp`, `.git` or a
 * lock server — a hook that reads something outside the deployment inputs to
 * decide what to build — and it is answered the same way: the guard closes
 * every route by which a hook changes the inputs the deploy reads, and a hook
 * written to fool the guard is a change to this repository's own hooks, which
 * review catches where classification cannot.
 *
 * KEYS ARE STRUCTURED, NOT SENTENCES. Every entry is keyed by
 * `fingerprintKey(kind, path)` rather than by a filesystem-looking string such
 * as `<dir> (self)` (barrier round on #1107). Those synthetic keys shared one
 * namespace with the real paths beside them, so a repository that happens to
 * contain a file literally named `functions (self)` produced the SAME key as
 * the `functions` directory's own signature — and because the copied root files
 * are recorded after the directory walks, the real file's entry overwrote the
 * directory's, hiding a `chmod` on the watched directory from both snapshots.
 * `fingerprintKey` separates the two with a NUL, the one byte a POSIX path
 * cannot contain, so no file can be named into another entry's key.
 * `describeFingerprintKey` renders the pair back into the sentence
 * `firstLiveTreeDrift` reports, so the diagnostics still name the path.
 */
async function liveTreeFingerprint(liveDirs, projectDir, liveFiles = [], liveEntryDirs = []) {
  /** @type {Map<string, string>} */
  const fingerprint = new Map();
  /** Real paths already walked, so a link cannot make the guard traverse a tree twice or loop. */
  const visited = new Set();
  // The repository as the filesystem names it: a project path handed in
  // through a symlinked ancestor (macOS's `/var` → `/private/var`, say) would
  // otherwise make every resolved target look like it left the repository.
  let projectRoot;
  try {
    projectRoot = await realpath(projectDir);
  } catch {
    projectRoot = projectDir;
  }
  /**
   * What a symlink at `path` reaches, keyed under the link: a file target's
   * stat, or a directory target walked in full. Shared by the directory walk
   * and the copied root files, because a root file that is itself a link
   * (a shared build input, say) is one more path a hook can write THROUGH
   * (Codex P1, round 16 on #1107).
   */
  const recordLinkTarget = async (path) => {
    let target;
    try {
      target = await stat(path, { bigint: true });
      fingerprint.set(
        fingerprintKey("target", path),
        `${target.mode} ${target.ino} ${target.size} ${target.mtimeNs} ${target.ctimeNs}`,
      );
    } catch (error) {
      fingerprint.set(fingerprintKey("target", path), `absent ${error?.code ?? "?"}`);
    }
    if (target?.isDirectory()) {
      const resolved = await realpath(path);
      const inside = relative(projectRoot, resolved);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        throw new Error(
          `${path} is a symlink to a directory outside the repository (${resolved}); the live checkout cannot be fingerprinted, so this deploy is refused`,
        );
      }
      await walk(resolved);
    }
  };
  /**
   * A dependency tree, ONE level deep: the directory's own signature, its entry
   * names, and each entry's own signature (Codex P1, round 22 on #1107). The
   * tree is linked into the overlay, so a hook can leave a marker there that
   * the deploy's second run will find; a full walk would cost more than the
   * rest of the checkout, so the watch covers what such a marker moves — the
   * tree's entry set and its top-level entries — and a write buried inside one
   * dependency's own files is the stated out-of-tree-state residual.
   */
  const shallow = async (dir) => {
    let real;
    try {
      real = await realpath(dir);
    } catch {
      real = dir;
    }
    if (visited.has(`shallow:${real}`)) return;
    visited.add(`shallow:${real}`);
    const signature = async (path) => {
      const stats = await lstat(path, { bigint: true });
      return `${stats.mode} ${stats.ino} ${stats.size} ${stats.mtimeNs} ${stats.ctimeNs}`;
    };
    try {
      fingerprint.set(fingerprintKey("path", dir), await signature(dir));
      const names = (await readdir(dir)).sort();
      fingerprint.set(fingerprintKey("entries", dir), names.join("\n"));
      for (const name of names) {
        const path = join(dir, name);
        try {
          fingerprint.set(fingerprintKey("path", path), await signature(path));
        } catch (error) {
          fingerprint.set(fingerprintKey("path", path), `absent ${error?.code ?? "?"}`);
        }
      }
    } catch (error) {
      fingerprint.set(fingerprintKey("path", dir), `unreadable ${error?.code ?? "?"}`);
    }
  };
  const walk = async (dir) => {
    let real;
    try {
      real = await realpath(dir);
    } catch {
      real = dir;
    }
    if (visited.has(real)) return;
    visited.add(real);
    // The directory's OWN signature as well as its children's (Codex P1,
    // round 25 on #1107): a hook can branch on a linked directory's
    // permission bits and change them through the scratch symlink, which
    // moves nothing beneath it.
    try {
      const own = await lstat(dir, { bigint: true });
      fingerprint.set(
        fingerprintKey("self", dir),
        `${own.mode} ${own.ino} ${own.size} ${own.mtimeNs} ${own.ctimeNs}`,
      );
    } catch (error) {
      fingerprint.set(fingerprintKey("self", dir), `absent ${error?.code ?? "?"}`);
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // An unreadable directory is recorded AS unreadable: becoming readable
      // (or not) between the two walks is itself a change worth refusing on.
      fingerprint.set(fingerprintKey("path", dir), `unreadable ${error?.code ?? "?"}`);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === "node_modules") {
        await shallow(path);
        continue;
      }
      let stats;
      try {
        stats = await lstat(path, { bigint: true });
      } catch (error) {
        fingerprint.set(fingerprintKey("path", path), `absent ${error?.code ?? "?"}`);
        continue;
      }
      fingerprint.set(
        fingerprintKey("path", path),
        `${stats.mode} ${stats.ino} ${stats.size} ${stats.mtimeNs} ${stats.ctimeNs}`,
      );
      // Dirents report the entry's OWN type, so `isDirectory()` below never
      // descends a symlink by accident. A link's TARGET is fingerprinted,
      // though (Phase 4b / Codex P1, round 20): a link such as
      // `tools/config-link -> ../firebase.json` is a path a hook can write
      // THROUGH, and recording only the link's own inode would let the write
      // land on a deployment input outside every watched tree without a single
      // fingerprint changing. The target's stat — including its `ctime` — is
      // keyed under the link path, so a replaced or edited target reads as
      // drift on the link that reached it.
      //
      // A DIRECTORY target is walked as well (Codex P1, round 13 on #1107):
      // overwriting an existing file through `tools/config-link -> ../config`
      // moves neither the link nor the directory's `mtime`, so its metadata
      // alone would let the write through. The walk is bounded two ways — the
      // `visited` set above stops a loop or a second pass over a tree the
      // overlay already exposed, and a target that resolves OUTSIDE the
      // repository is refused outright, because the guard cannot vouch for a
      // deployment input it is not allowed to read and must not be led to walk
      // an arbitrary tree.
      if (entry.isSymbolicLink()) await recordLinkTarget(path);
      if (entry.isDirectory()) await walk(path);
    }
  };
  // The exclusion has to be applied to the roots as well as to what they
  // contain: the project's OWN `node_modules` is one of the directories the
  // overlay symlinks, and walking it would cost more than the rest of the
  // checkout put together.
  // The project root's ENTRY SET, so a creation or removal at the root is
  // drift (Codex P1, round 18 on #1107): the roots below and the copied files
  // further down are the entries that existed when staging ran, and a hook
  // that creates `$INIT_CWD/.deploy-mode` through the inherited live path
  // would otherwise be absent from both snapshots — present for Firebase's
  // second run and never for this one. Names only: the entries themselves
  // are fingerprinted by the walks and the file list.
  for (const dir of new Set([projectDir, ...liveEntryDirs])) {
    const kind = dir === projectDir ? "root-entries" : "entries";
    try {
      const names = await readdir(dir);
      fingerprint.set(fingerprintKey(kind, dir), names.sort().join("\n"));
    } catch (error) {
      fingerprint.set(fingerprintKey(kind, dir), `unreadable ${error?.code ?? "?"}`);
    }
  }
  for (const dir of liveDirs) {
    if (basename(dir) === "node_modules") {
      await shallow(dir);
      continue;
    }
    await walk(dir);
  }
  // The copied root files, by their live paths: the overlay's copy is what a
  // relative write reaches, but the live original is what the deploy reads.
  for (const file of liveFiles) {
    let stats;
    try {
      stats = await lstat(file, { bigint: true });
      fingerprint.set(
        fingerprintKey("path", file),
        `${stats.mode} ${stats.ino} ${stats.size} ${stats.mtimeNs} ${stats.ctimeNs}`,
      );
    } catch (error) {
      fingerprint.set(fingerprintKey("path", file), `absent ${error?.code ?? "?"}`);
    }
    if (stats?.isSymbolicLink()) await recordLinkTarget(file);
  }
  return fingerprint;
}

/**
 * The exit status `main()` uses for a detected live-checkout mutation, so
 * `deploy.sh` can tell it apart from an ordinary invalid request.
 */
export const LIVE_CHECKOUT_DRIFT_EXIT_CODE = 3;

/**
 * A write that reached the developer's working tree while this classifier ran
 * other people's programs.
 *
 * This is FATAL rather than a refusal. Falling back to the conservative
 * classification and returning success was wrong in the one way that matters:
 * the hook has already changed tracked application source AFTER `deploy.sh`'s
 * clean-tree guard passed, so the build that follows would package those
 * changes and the deploy would publish them (Codex P1, round 18). Nothing here
 * tries to put the files back — a classifier that repaired a tree it does not
 * understand would be guessing at which of the writes were the deploy's own —
 * so the fail-closed answer is to stop, name the paths, and leave the tree for
 * a human to inspect.
 */
export class LiveCheckoutDriftError extends Error {
  constructor(drift, when) {
    super(
      `a ${when} wrote into the live checkout (${drift}). The working tree is no longer the ` +
        "tree the clean-tree guard approved, so this deploy is refused rather than continued. " +
        "Nothing has been restored: inspect the tree (git status) and decide what belongs in it.",
    );
    this.name = "LiveCheckoutDriftError";
    this.drift = drift;
  }
}

/**
 * Repository METADATA drift is the same class of failure as tree drift, and it
 * exits the same way. A hook that moves `HEAD`, the branch or a tag has changed
 * a deployment input — `vite.config.ts` stamps the bundle with `git rev-parse
 * HEAD` during `BUILD_CMD` — after the approved-checkout guards ran, so a
 * conservative classification is not enough: the deploy must stop (Phase 4b
 * P1, round 19). Subclassed so every `instanceof LiveCheckoutDriftError` exit
 * path applies unchanged.
 */
export class RepositoryMetadataDriftError extends LiveCheckoutDriftError {
  constructor(drift, when) {
    super(drift, when);
    this.name = "RepositoryMetadataDriftError";
    this.message =
      `a ${when} changed what the repository answers (${drift}). The build stamps the bundle from ` +
      "`git` answers, so a deploy from this checkout would publish metadata the approved-checkout " +
      "guards never saw; it is refused rather than continued. Nothing has been restored: inspect the " +
      "repository (git status, git log -1) and decide what belongs in it.";
  }
}

/**
 * What the repository ANSWERS, for the lookups a build makes of it.
 *
 * The counterpart of `liveTreeFingerprint` for the `.git` view, and deliberately
 * not the same mechanism. A file-level walk of `.git` reports drift for things
 * no build can observe and nothing in this classifier caused — `FETCH_HEAD`
 * after any background fetch, `logs/`, a gc — while the property that actually
 * matters is whether the deploy's `git` call will answer what this run's did.
 * These three cover it: the commit, the branch, and the nearest tag, which is
 * every `git`-derived build input anyone writes.
 *
 * The residual is a hook that uses `.git` as scratch STORAGE — writing a marker
 * there and reading it back on its second run. That is the residual this design
 * documents everywhere else: state that outlives the process and lives outside
 * the project and the scratch dir, exactly like `$HOME`, `/tmp` or a lock
 * server, and no offline classifier closes it. Withholding `.git` did not close
 * it either; it only changed what an ordinary build computes.
 */
export async function gitAnswerFingerprint(projectDir) {
  const answers = [];
  for (const args of [
    ["rev-parse", "HEAD"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
    ["describe", "--tags", "--always"],
    // Every remote-tracking ref as well (Codex P1, round 18 on #1107): a hook
    // that runs `git fetch` moves `refs/remotes/origin/main` without touching
    // HEAD, the branch or the nearest tag, and `deploy.sh`'s approved-checkout
    // guard asked exactly whether HEAD equals origin/main before this ran.
    // Listed by name and object so a fetch that adds, moves or drops one is
    // drift; FETCH_HEAD itself stays out, as the note above explains.
    ["for-each-ref", "refs/remotes", "--format=%(refname) %(objectname)"],
  ]) {
    const run = await runCapturedProcess("git", args, {
      cwd: projectDir,
      timeout: 10_000,
      outputLimit: Infinity,
    });
    answers.push(`git ${args.join(" ")} => ${run.ok ? run.output.trim() : `failed ${run.code ?? "?"}`}`);
  }
  return answers.join("\n");
}

/**
 * The first path whose live-tree signature moved, or null.
 *
 * Reported through `describeFingerprintKey`, so a structured key comes back as
 * the sentence a human can act on — the path first, then what about it moved.
 */
function firstLiveTreeDrift(before, after) {
  for (const [key, signature] of after) {
    const previous = before.get(key);
    if (previous === undefined) return `${describeFingerprintKey(key)} was created`;
    if (previous !== signature) return `${describeFingerprintKey(key)} was modified`;
  }
  for (const key of before.keys()) {
    if (!after.has(key)) return `${describeFingerprintKey(key)} was removed`;
  }
  return null;
}

/**
 * A private copy of the staged project, for one discovery probe.
 *
 * Copies what the staging copied and RELINKS what it linked, so the probe's
 * project is the same view of the world at a different path: the post-hook
 * source dirs are its own, while `node_modules` and the untouched project
 * directories remain the one tree the deploy will read.
 *
 * Written out rather than delegated to `fs.cp`, because the links here point
 * into the developer's checkout and every one of them has to come back in
 * `links` for cleanup to unlink it by name rather than trust a recursive
 * remove's symlink handling — the same care `stageProjectOverlay` takes.
 *
 * Each level's DIRECTORY timestamps are restored as that level returns, for the
 * same reason the staging restores its own: a `mkdir` carries the moment it
 * ran, so a codebase whose module initialization reads a directory mtime would
 * see this copy's clock rather than the checkout's. The recursion is already
 * deepest-first, so the parent is touched only once every child has been.
 */
async function copyStagedProject(from, to, links) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) {
      const pointsAt = await readlink(source);
      const isDirectory = await stat(source)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      await symlink(pointsAt, target, isDirectory ? "junction" : "file");
      links.push(target);
    } else if (entry.isDirectory()) {
      await copyStagedProject(source, target, links);
    } else {
      await cp(source, target, { dereference: false, preserveTimestamps: true });
    }
  }
  await copyDirectoryTimes(from, to);
}

/**
 * The two project-config shapes a walk is run under.
 *
 * `prepare.js` gives discovery the project's `adminSdkConfig` in
 * `FIREBASE_CONFIG` and its legacy runtime config in `CLOUD_RUNTIME_CONFIG`,
 * both from authenticated lookups a local preflight must not make. Only the
 * project id is reproducible.
 *
 * Rather than instrument how the artifact reads them — which only ever covered
 * the access forms someone thought of, and missed `"x" in config`,
 * `Object.hasOwn`, enumeration and plain string inspection in turn (Codex P2,
 * rounds 11 and 12) — the walk is run TWICE: once with the unreproducible
 * fields ABSENT and once with them PRESENT, under obviously synthetic values.
 * Equal endpoint ids from both runs mean the deployed surface does not depend
 * on those fields at all, however the artifact chose to look at them; different
 * ids forfeit. One mechanism, no access-form list, and nothing to keep current.
 *
 * The residual is an artifact that branches on a field's EXACT real value,
 * which takes the same (false) branch under both probes. No offline classifier
 * can close that one: the real value is precisely what it cannot obtain.
 */
const CONFIG_PROBES = Object.freeze([
  Object.freeze({ label: "minimal", extraFirebaseConfig: {}, extraRuntimeConfig: {} }),
  Object.freeze({
    label: "populated",
    extraFirebaseConfig: {
      databaseURL: "https://firebase-deploy-scope-probe.firebaseio.com",
      storageBucket: "firebase-deploy-scope-probe.appspot.com",
      locationId: "us-central1",
    },
    extraRuntimeConfig: { firebaseDeployScopeProbe: { value: "probe" } },
  }),
]);

/**
 * The environment the CLI's own discovery process runs under, for one probe.
 *
 * This matters because a `.env` value can decide whether an export is an
 * endpoint at all (`export const x = FLAG ? onObjectFinalized(…) : undefined`),
 * so a walk under the ambient shell environment could miss an endpoint the
 * deploy will create. `prepare.js` builds `{…userEnvs, …firebaseEnvs,
 * GOOGLE_CLOUD_QUOTA_PROJECT}` and hands it to the delegate, whose
 * `spawnFunctionsProcess` then passes through only `HOME`, `PATH`, `NODE_ENV`
 * and `FUNCTIONS_CONTROL_API` — deliberately NOT the whole ambient environment
 * — plus the serialized runtime config. All of that is mirrored, the dotenv
 * half through firebase-tools' own loader.
 *
 * The dotenv files come from the config's `configDir`, not from its source:
 * `resolveConfigDir` is `configDir || source`, and a codebase that sets one
 * keeps its `.env` files there (Codex P2, round 12).
 */
function discoveryEnvironment({ scratchProject, scratchConfigDir, project, projectAlias, probe }) {
  const userEnvs = functionsEnv.loadUserEnvs({
    functionsSource: scratchConfigDir,
    configDir: scratchConfigDir,
    projectId: project,
    ...(projectAlias ? { projectAlias } : {}),
    projectDir: scratchProject,
  });
  const firebaseConfig = { projectId: project, ...probe.extraFirebaseConfig };
  const environment = {
    ...userEnvs,
    ...functionsEnv.loadFirebaseEnvs(firebaseConfig, project),
    // `spawnFunctionsProcess` serializes the codebase's runtime config here
    // whenever it is non-empty, and `prepare.js` makes it at least
    // `{firebase: firebaseConfig}` — so omitting it entirely would itself be a
    // divergence a `process.env.CLOUD_RUNTIME_CONFIG` branch could see.
    CLOUD_RUNTIME_CONFIG: JSON.stringify({
      firebase: firebaseConfig,
      ...probe.extraRuntimeConfig,
    }),
    GOOGLE_CLOUD_QUOTA_PROJECT: project,
    FUNCTIONS_CONTROL_API: "true",
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    // `spawnFunctionsProcess` sets this from the AMBIENT environment, which
    // overwrites any dotenv value of the same name.
    __FIREBASE_FRAMEWORKS_ENTRY__: process.env.__FIREBASE_FRAMEWORKS_ENTRY__,
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
 * The Functions configs whose `predeploy` hooks THIS deploy will run, in the
 * order `firebase-tools` runs them.
 *
 * Mirrors `lifecycleHooks.js` `getReleventConfigs`, whose fallback is the part
 * that matters: when an `--only functions:<x>` selector does not name a
 * configured codebase — the ordinary case, where `<x>` is an endpoint id — NO
 * target is matched and the CLI reverts to running EVERY Functions config's
 * hooks. So a second codebase's hook runs even for a scope that names only the
 * first, and it can overwrite the first's artifact (Codex P2, round 11).
 */
function relevantFunctionsConfigs(only, configs) {
  if (!only) return configs;
  const targets = only.split(",");
  if (targets.includes("functions")) return configs;
  const functionTargets = targets
    .filter((target) => target.startsWith("functions:"))
    .map((target) => target.replace("functions:", ""));
  const matched = new Map(functionTargets.map((target) => [target, false]));
  const selected = [];
  for (const config of configs) {
    // The RAW field, as `getReleventConfigs` reads it: a config without a
    // `codebase` key takes the unconditional branch, and is NOT the string
    // "default" there even though that is the codebase it deploys as.
    if (!config.rawCodebase) {
      selected.push(config);
      continue;
    }
    const found = functionTargets.find((target) => config.rawCodebase === target.split(":")[0]);
    if (found !== undefined) {
      selected.push(config);
      matched.set(found, true);
    }
  }
  if (![...matched.values()].every(Boolean)) return configs;
  return selected;
}

/**
 * The configs of a NON-Functions target whose `predeploy` hooks this deploy
 * will run, mirroring the else-branch of `getReleventConfigs`.
 *
 * `configSource` here is the MATERIALIZED config, not the raw `firebase.json`.
 * `getReleventConfigs` reads `options.config.get(target)`, and `Config`'s
 * constructor has already run `MATERIALIZE_TARGETS` over every target it
 * recognises — so a target given as an import path (`"firestore":
 * "firestore.config.json"`) is by then the parsed FILE. Reading the raw source
 * handed this function a string, whose `predeploy` is `undefined`, and the
 * imported hooks were silently left out of the plan while the deploy ran them
 * (barrier round on #1107).
 *
 * `deploy/index.js` chains `lifecycleHooks(<target>, "predeploy")` for EVERY
 * selected target before it chains a single `prepare`, so Functions discovery
 * happens only after the last of them has run. A Firestore hook that replaces
 * `functions/lib/index.js` therefore decides the deployed surface of a
 * `--only functions:daily,firestore` request, and inventorying only the
 * Functions hooks granted the exemption to a group (Codex P2, round 18).
 */
function relevantTargetConfigs(target, only, configSource) {
  const raw = configSource[target];
  if (raw === undefined || raw === null) return [];
  const configs = Array.isArray(raw) ? raw : [raw];
  if (!only) return configs;
  const selectors = only.split(",");
  if (selectors.includes(target)) return configs;
  const named = selectors
    .filter((selector) => selector.startsWith(`${target}:`))
    .map((selector) => selector.replace(`${target}:`, ""));
  return configs.filter(
    (config) => config && typeof config === "object" && (!config.target || named.includes(config.target)),
  );
}

/**
 * Write `-p, --public <path>` into the materialised config, exactly where and
 * exactly when the pinned CLI writes it.
 *
 * WHY IT BELONGS HERE AND NOT ONLY IN THE HOSTING RELEASE. The flag reads like
 * a publishing detail — "override the Hosting public directory specified in
 * firebase.json" — but `deploy/hosting/prepare.js`'s `handlePublicDirectoryFlag`
 * does not wait for Hosting's own `prepare`. `deploy/index.js` calls
 * `hasPinnedFunctions(options)` first, which calls it, so `options.config`
 * already carries the override by the time the deploy chains its FIRST
 * predeploy hook. `lifecycleHooks.getChildEnvironment` then resolves a Hosting
 * hook's `$RESOURCE_DIR` as `config.path(config.public ?? config.source)` — the
 * overridden directory. Planning that hook from `firebase.json` alone let it
 * read one directory here and another during the deploy, so a hook that emits a
 * direct endpoint from one and a protected group from the other was rehearsed
 * as exact and released as a group with its invoker unreconciled (Codex P1,
 * round 23 on #1107).
 *
 * WHEN THE CLI READS IT. Only when Hosting is one of the deployed targets:
 * `hasPinnedFunctions` is guarded by `targetNames.includes("hosting")` and
 * Hosting's `prepare` is not chained otherwise, so `--public` beside `--only
 * functions:<name>` never reaches any config and never moves any hook. The same
 * guard is applied here rather than a broader one, because overriding a
 * directory the deploy would not have overridden is its own divergence.
 *
 * MULTIPLE SITES. `handlePublicDirectoryFlag` REFUSES an array `hosting` —
 * there is no single site whose directory the flag could name — and it does so
 * before the first hook, so the deploy never starts. That is mirrored as a
 * refusal rather than modelled: this classifier must not build, rehearse or
 * classify for a request the pinned CLI rejects outright.
 *
 * The mutation itself goes through the pinned `Config`'s own `set`, so what a
 * shape like an EXTERNALISED `"hosting": "hosting.config.json"` ends up with is
 * whatever the CLI ends up with, rather than this classifier's reading of it.
 */
/**
 * Why an exact classification is refused when the pinned CLI would PREPARE A
 * WEB FRAMEWORK, or null when it would not.
 *
 * `deploy/index.js` runs `prepareFrameworks("deploy", …)` at the very top of the
 * deploy — before `hasPinnedFunctions`, before the `--public` override, and
 * before it chains a single `predeploy` hook. That is not a publishing detail:
 * `frameworks/index.js` runs the app's OWN framework build, then sets
 * `config.public` to the generated `.firebase/<site>/hosting` directory and, for
 * an SSR framework, appends a generated Functions codebase to `options.config`.
 * So by the time the first hook runs, the deploy has already built code this
 * rehearsal never ran, moved the `$RESOURCE_DIR` a Hosting hook is handed, and
 * possibly added a Functions artifact to the surface being classified (Codex P1,
 * round 26 on #1107).
 *
 * Modelling that is not on the table — it is an arbitrary framework build with
 * its own toolchain — so the whole project is refused instead, before anything
 * is staged and before any hook runs. The condition is the pinned CLI's OWN
 * `isDeployingWebFramework`, imported rather than paraphrased, under the same
 * `targetNames.includes("hosting")` guard it is called behind: a Hosting config
 * with a `source`, selected by this request. A plain `public` Hosting config is
 * not a framework deploy and is exempt exactly as before.
 *
 * THE EXPERIMENT FLAG IS DELIBERATELY NOT CONSULTED. The CLI does not branch on
 * `webframeworks`; it calls `experiments.assertEnabled`, which THROWS. So the
 * two states behind this condition are "the framework build runs before the
 * hooks" and "the deploy fails before it starts" — and an exact classification
 * is meaningless in both. Reading the flag would only pick which of them to be
 * wrong about, and it lives in a configstore this classifier would then have to
 * resolve the same way the CLI does.
 */
function frameworkPreparationRefusal(deployTargets, deployConfig, only) {
  if (!deployTargets.includes("hosting")) return null;
  if (!isDeployingWebFramework({ config: deployConfig, only })) return null;
  return (
    "a selected Hosting config deploys a web framework from `source`, so the pinned CLI runs " +
    "prepareFrameworks() — the framework's own build, which replaces hosting.public and can write a " +
    "Functions artifact — before the first predeploy hook"
  );
}

function applyPublicDirectoryOverride(config, publicDir, deployTargets) {
  if (!publicDir) return;
  if (!deployTargets.includes("hosting")) return;
  if (Array.isArray(config.get("hosting"))) {
    throw new Error("Cannot specify --public option with multi-site configuration");
  }
  config.set("hosting.public", publicDir);
}

/**
 * `getChildEnvironment`'s `$RESOURCE_DIR` for a non-Functions target, as a
 * PROJECT-RELATIVE path, or null when the config names one the overlay cannot
 * place.
 *
 * Hosting resolves `public ?? source`; every other target resolves the project
 * directory itself, which is the empty relative path. `public` is read off the
 * MATERIALISED config, so a `--public` override is already in it — see
 * `applyPublicDirectoryOverride`. An absolute or climbing path is refused by
 * `normalizedSourcePath` whether it came from the config or the flag: the
 * overlay stages the project directory, so a resource directory outside it is
 * one the rehearsal cannot place, and `Config.path` hands an absolute one
 * straight through to the deploy's own hook.
 */
function targetResourceRel(target, config) {
  if (target !== "hosting") return "";
  const configured = config.public ?? config.source;
  if (configured === undefined || configured === null) return null;
  return normalizedSourcePath(configured);
}

/**
 * The codebases this deploy will actually LOAD, mirroring `targetCodebases`.
 *
 * A different set from the one whose hooks run: `getReleventConfigs` falls back
 * to every config when an `--only functions:<x>` names no codebase, but
 * `loadCodebases` still discovers only the codebases the filters name. Loading
 * one Firebase will not load is not merely wasted work — that codebase's own
 * module-scope code runs, and it can write over another codebase's artifact
 * before this classifier reads it (Codex P2, round 14).
 */
export function targetCodebases(only, configs, codebaseNames) {
  const all = configs.map((config) => config.codebase);
  if (!only) return new Set(all);
  const named = new Set();
  for (const selector of only.split(",")) {
    if (selector === "functions") return new Set(all);
    if (!selector.startsWith("functions:")) continue;
    const fragments = selector.slice("functions:".length).split(":");
    // `parseFunctionSelector`: a leading fragment that IS a configured codebase
    // names it; otherwise two fragments name `fragments[0]` and one resolves to
    // the default codebase.
    if (codebaseNames.has(fragments[0]) || fragments[0] === "default") named.add(fragments[0]);
    else if (fragments.length > 1) named.add(fragments[0]);
    else named.add("default");
  }
  if (named.size === 0) return new Set(all);
  return new Set(all.filter((codebase) => named.has(codebase)));
}

/**
 * What a rehearsal WANTS to answer, before anything has been swept.
 *
 * WHY A PLAN AND NOT AN ANSWER. Every exit from the rehearsal has to end the
 * processes it started before its verdict can be believed, and sweeping at each
 * `return` was the shape that failed: some of them did it, the failing-hook
 * exit did not, and nothing made the omission visible. A hook that detaches a
 * sleeper-then-writer into its own session and THEN exits nonzero — for a
 * reason of the rehearsal's own, such as authenticating against the synthetic
 * ADC — returned a conservative classification, `deploy.sh` accepted it and
 * carried on, and the detached writer altered a deployment input minutes later
 * through an inherited absolute path such as `INIT_CWD` (Codex P1, round 20 on
 * #1107).
 *
 * So the rehearsal cannot produce an answer at all. It returns one of these,
 * and `settleRehearsal` — its only reader, and the only thing that can turn one
 * into an inventory — sweeps first and converts second, so a `return` added
 * inside the rehearsal later inherits the sweep instead of having to remember
 * it. Anything else coming back from the rehearsal is a programming error and
 * is thrown rather than read as a clean run.
 *
 * `what` names the step for the fatal drift messages; `reason` is the
 * conservative refusal, or null when the rehearsal finished with nothing to
 * complain about.
 */
class RehearsalExit {
  constructor(what, reason = null) {
    this.what = what;
    this.reason = reason;
  }
}

/**
 * Build the project the way the deploy will, then inventory the endpoint ids
 * the runtime loader would discover in each codebase's artifact.
 *
 * WHY BUILD. `--only functions:<name>` matches DEPLOYED ids, and those come
 * from `package.json.main` — the artifact — never from `src/index.ts`. Between
 * the two sit the `predeploy` hooks, the npm build script, npm's implicit
 * `pre`/`post` lifecycle scripts, and tsconfig; each is an arbitrary shell
 * program, and successive rounds of review found a new way for one of them to
 * make the artifact disagree with the source (`true || tsc`,
 * `tsc && cp group.js lib/index.js`, a `postbuild` swap, an earlier hook that
 * rewrites `src/index.ts`, another codebase's hook entirely). Modelling shell
 * semantics statically is unbounded; running the program is exact.
 *
 * WHY THIS IS NOT NEW TRUST. These are the same hooks, from the same config,
 * that `firebase deploy` executes minutes later in the same working tree. The
 * only new thing is WHEN.
 *
 * WHY A SCRATCH PROJECT. Building in place would leave the classifier's own
 * artifacts in the developer's tree. `stageProjectOverlay` builds a temporary
 * project in which every Functions source dir is a copy and everything else is
 * a symlink to the original.
 *
 * THE STAGING IS BRACKETED BY FINGERPRINTS. The overlay is planned first
 * (`plan: true`, which creates nothing), the watched tree is fingerprinted, the
 * copy runs, and the post-staging baseline every later check compares against
 * is required to equal that pre-staging one. Taking the baseline only after the
 * copy meant a write that landed WHILE it was copying — another process editing
 * a Functions source between the moment `cp` read it and the moment the
 * fingerprint was taken — was recorded as the unchanged starting state, while
 * the scratch project held the pre-edit bytes. Every later fingerprint then
 * matched, nothing looked like drift, and the inventory could exempt a selector
 * for a checkout that is no longer the tree `deploy.sh`'s clean-tree guard
 * approved (Codex P1, round 25 on #1107).
 *
 * THE REPOSITORY'S ANSWERS ARE BRACKETED THE SAME WAY, and from even earlier:
 * they are read at the very top of this function, before the write containment
 * is established and before the copy starts, rather than beside the tree
 * baseline afterwards. A background fetch advancing `origin/main` during that
 * setup used to BECOME the baseline, every later metadata check then passed,
 * and the exemption was granted although `deploy.sh`'s own `HEAD ==
 * origin/main` guard no longer held (Codex P1, round 26 on #1107). The wrapper
 * re-runs that guard after this returns for the same reason.
 *
 * WHAT THE DEPLOY DOES BEFORE THE FIRST HOOK IS PART OF THE REQUEST. A selected
 * Hosting config with a `source` makes the pinned CLI run the app's own
 * framework build ahead of every lifecycle hook, replacing `hosting.public` and
 * possibly writing a Functions artifact; the whole project is refused rather
 * than rehearsed (`frameworkPreparationRefusal`). And the hooks run against the
 * ADC document the deploy will hand them or not at all — see
 * `establishedDeployCredential`, which refuses every exemption when no wrapper
 * has named one.
 *
 * WHAT THE EXEMPTION REQUIRES OF THE LAYOUT. `firebase.json` at the CHECKOUT
 * ROOT. The staging and the fingerprint both start from the configured project
 * directory, so with the config below a repository root the deploy's inputs are
 * larger than the watched set and a hook can change one without moving a single
 * fingerprint. That layout is refused before anything is staged or started —
 * see `nestedProjectRefusal`.
 *
 * NOTHING RUNS UNCONTAINED. Before the first hook, `establishWriteContainment`
 * puts every program this rehearsal starts under a mechanism that cannot write
 * outside the scratch root, and PROVES it with a canary rather than assuming it.
 * The guards below all answer after the fact, and an answer does not neutralise
 * a writer that is already running: a hook can detach a worker with an
 * environment of its own, past the process group and past the marker sweep, to
 * write a deployment input minutes after this returned. A machine where the
 * containment cannot be proved gets the conservative classification and no
 * hooks at all.
 *
 * FAILS CLOSED on every uncertainty: a config directory below a repository root,
 * a Hosting config the CLI would build as a web framework, a deploy credential
 * no wrapper established, a containment this machine cannot prove,
 * an unmirrorable source path, a staging failure, a
 * symlink out of the staged tree, a non-zero or timed-out hook, a write into
 * the repository metadata, a discovery manifest, an artifact that will not
 * load, or a walk that throws — each of which refuses only what it makes
 * unprovable, except a hook failure, which refuses the whole project because
 * the tree left behind is not the one the deploy will produce.
 *
 * A write that reached the WORKING TREE is the one outcome that is not a
 * refusal at all: it THROWS `LiveCheckoutDriftError`, which aborts the deploy.
 * See that class for why continuing with a conservative classification was
 * wrong. A write that landed during the staging throws the same error for the
 * same reason, though nothing this rehearsal started could have made it.
 *
 * EVERY refusal leaves through one exit. The hooks and the probes run inside
 * `rehearse`, which can only return a `RehearsalExit`; `settleRehearsal` then
 * sweeps this run's escaped processes, repeats the fatal live-tree and metadata
 * checks over whatever they did, and only then turns that exit into an answer.
 * See `RehearsalExit` for the failure that shape exists to make impossible.
 */
async function buildAndInventoryProject({
  projectDir,
  only,
  project,
  projectAlias,
  predeployTimeoutMs,
  discoveryTimeoutMs,
  writeContainment,
  onStaged,
  afterContainment,
  establishedCredentialPath,
  frameworkPreparation,
  configs,
  codebaseNames,
  deployTargets,
  configSource,
}) {
  /** @type {Map<string, { authoritative: boolean, endpoints: string[], groups: string[] }>} */
  const inventories = new Map();
  const refuseAll = (reason) => {
    const answer = refused(reason);
    for (const config of configs) inventories.set(config.codebase, answer);
    return inventories;
  };

  // `discoverBuild` switches to a one-shot manifest process when this is set,
  // which is a different program with a different environment; the pinned SDK
  // binary does not even implement it. Refuse rather than discover the other
  // way round (Codex P2, round 15).
  if (process.env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH) {
    return refuseAll(
      "FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH selects a discovery mode this classifier cannot mirror",
    );
  }

  // A `firebase.json` below a repository root makes the deploy's inputs larger
  // than anything this rehearsal stages or watches, and no hook or probe may run
  // before that is settled — see `nestedProjectRefusal`. First, therefore: ahead
  // of the staging, ahead of the scratch directory, and ahead of every child
  // process.
  const nested = nestedProjectRefusal(
    projectDir,
    existsSync(join(projectDir, ".git")) ? null : nearestAncestorGit(projectDir),
  );
  if (nested) return refuseAll(nested);

  // The framework build the pinned CLI runs BEFORE the first hook is a step
  // this rehearsal cannot reproduce, so the whole project is refused here —
  // ahead of the staging and ahead of every child process, for the same reason
  // the nested-config refusal is. See `frameworkPreparationRefusal`.
  if (frameworkPreparation) return refuseAll(frameworkPreparation);

  // The deploy credential is settled before anything is staged or started, so a
  // request this classifier cannot rehearse faithfully costs nothing to refuse.
  // See `establishedDeployCredential`.
  const credential = await establishedDeployCredential(establishedCredentialPath);
  if (!credential.ok) return refuseAll(credential.reason);

  const relevant = relevantFunctionsConfigs(only, configs);
  const unstageable = relevant.find((config) => !config.sourceRel);
  if (unstageable) {
    // Its hooks run in the real deploy and cannot be reproduced here, so no
    // codebase's artifact in this project can be trusted.
    return refuseAll(
      `codebase ${unstageable.codebase} has no mirrorable local source, so its predeploy hooks cannot be reproduced`,
    );
  }
  for (const config of relevant) {
    if (config.steps === null) return refuseAll(`codebase ${config.codebase} has a malformed predeploy`);
  }

  /**
   * Every predeploy hook this deploy runs before Functions discovery, in
   * Firebase's order: `deploy/index.js` walks the selected targets in
   * `VALID_DEPLOY_TARGETS` order, chaining each target's `predeploy` hooks, and
   * only then chains the `prepare` that discovers Functions.
   */
  const hookPlan = [];
  for (const target of deployTargets ?? ["functions"]) {
    if (target === "functions") {
      for (const config of relevant) {
        for (const command of config.steps) {
          hookPlan.push({ target, command, resourceRel: config.sourceRel, label: `codebase ${config.codebase}` });
        }
      }
      continue;
    }
    for (const config of relevantTargetConfigs(target, only, configSource ?? {})) {
      const steps = predeploySteps(config.predeploy);
      if (steps === null) return refuseAll(`the ${target} config has a malformed predeploy`);
      if (steps.length === 0) continue;
      const resourceRel = targetResourceRel(target, config);
      if (resourceRel === null) {
        return refuseAll(
          `the ${target} config's predeploy resource directory is not a mirrorable project-relative path`,
        );
      }
      for (const command of steps) {
        hookPlan.push({ target, command, resourceRel, label: `the ${target} target` });
      }
    }
  }
  // See `runPredeployHook`: the CLI's own quoting does not survive a backslash,
  // so a hook containing one cannot be reproduced and is refused rather than
  // approximated.
  const unquotable = hookPlan.find((hook) => hook.command.includes("\\"));
  if (unquotable) {
    return refuseAll(
      `a predeploy hook of ${unquotable.label} contains a backslash, whose quoting cannot be mirrored`,
    );
  }

  const staged = configs.filter((config) => config.sourceRel);
  if (staged.length === 0) return refuseAll("no Functions codebase has a mirrorable local source");
  // One source dir inside another would share the outer's `node_modules` in the
  // staged copy, so the nested codebase would resolve its dependencies from the
  // wrong package (Codex P2, round 12). Overlapping Functions sources are not a
  // shape worth modelling; refuse instead of getting them subtly wrong.
  for (const outer of staged) {
    for (const inner of staged) {
      if (inner === outer) continue;
      if (inner.sourceRel === outer.sourceRel || inner.sourceRel.startsWith(`${outer.sourceRel}/`)) {
        return refuseAll(
          `Functions source ${inner.sourceRel} overlaps ${outer.sourceRel}, so their dependencies cannot be staged apart`,
        );
      }
    }
  }
  for (const config of staged) {
    if (!existsSync(resolve(projectDir, config.sourceRel))) {
      return refuseAll(`no Functions source at ${config.sourceRel}`);
    }
  }

  /**
   * The tag every process this rehearsal starts carries, unique to this run so
   * that a concurrent classifier's children are never mistaken for its own.
   */
  const rehearsalMarker = randomUUID();

  const scratch = await mkdtemp(join(tmpdir(), "firebase-deploy-scope-"));
  const scratchProject = join(scratch, STAGED_PROJECT_DIRNAME);
  /** Every symlink this staging created, so cleanup can unlink them by name. */
  const links = [];
  /** The live directories those symlinks point at — the mutation guard's beat. */
  const liveDirs = [];
  /** The live files the overlay COPIED: reachable by absolute path, so watched too. */
  const liveFiles = [];
  /** Every directory the overlay traversed, whose entry set is watched for creations. */
  const liveEntryDirs = [];
  /** The repository metadata the overlay exposed, watched on its own terms. */
  const metadataDirs = [];
  try {
    // WHAT THE REPOSITORY ANSWERS, BEFORE ANY OF THIS CLASSIFIER'S OWN SETUP.
    //
    // The Git baseline used to be taken after the containment was proved and
    // after the whole staging copy — seconds during which this classifier is
    // doing its own work and something else on the machine can move a ref. A
    // background `git fetch` landing in that window became the BASELINE, every
    // later metadata check compared against it and passed, and the exemption
    // was granted for a checkout whose `HEAD == origin/main` no longer held —
    // the very guard `deploy.sh` ran before calling this (Codex P1, round 26 on
    // #1107). Taken first, that window closes: the answers are read before the
    // containment is established and before the first byte is copied, compared
    // once the staging is done, and compared again on every later exit.
    //
    // Read only when the project carries its own `.git`, which is the same
    // condition under which `stageProjectOverlay` registers `metadataDirs` —
    // a config below a repository root is refused above, so there is no third
    // case.
    let preSetupMetadata = null;
    if (existsSync(join(projectDir, ".git"))) {
      try {
        preSetupMetadata = await gitAnswerFingerprint(projectDir);
      } catch (error) {
        return refuseAll(
          `could not read what the repository answers before staging — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Before the staging: the hooks and the probes are other people's programs,
    // and this is the only guard that acts on them rather than reporting on
    // them afterwards. A machine that cannot prove it refuses here, having
    // started nothing.
    const containment = await establishWriteContainment({
      scratchRoot: scratch,
      projectDir,
      mode: writeContainment,
    });
    if (!containment.ok) return refuseAll(containment.reason);

    // A test's window into the interval the Git baseline above now spans, and
    // nothing else: an ARGUMENT, like `onStaged`, `writeContainment` and the two
    // timeouts, so that `main()` never passes it and no shell can reach it. It
    // can only make this classifier answer more conservatively, because
    // everything it can do is something a guard below is there to catch.
    if (afterContainment) await afterContainment({ projectDir, scratch });

    // The watched set as the staging will compute it, without staging anything,
    // so the tree can be fingerprinted BEFORE the copy starts. `plan: true`
    // creates no file and no link; the throwaway sets it fills are the same
    // paths the real walk below will register, which is what makes the two
    // fingerprints comparable key for key.
    const plannedDirs = [];
    const plannedFiles = [];
    const plannedEntryDirs = [];
    let preStagingBaseline;
    try {
      await stageProjectOverlay({
        projectDir,
        scratchProject,
        sourceRels: staged.map((config) => config.sourceRel),
        links: [],
        liveDirs: plannedDirs,
        liveFiles: plannedFiles,
        liveEntryDirs: plannedEntryDirs,
        metadataDirs: [],
        plan: true,
      });
      preStagingBaseline = await liveTreeFingerprint(
        plannedDirs,
        projectDir,
        plannedFiles,
        plannedEntryDirs,
      );
    } catch (error) {
      return refuseAll(
        `could not fingerprint the live checkout before staging — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await stageProjectOverlay({
        projectDir,
        scratchProject,
        sourceRels: staged.map((config) => config.sourceRel),
        links,
        liveDirs,
        liveFiles,
        liveEntryDirs,
        metadataDirs,
      });
    } catch (error) {
      return refuseAll(
        `could not stage the Functions sources — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // A test's window into the interval between the copy and the baseline below,
    // and nothing else: an ARGUMENT, like `writeContainment` and the two
    // timeouts, so that `main()` never passes it and no shell can reach it. It
    // can only make this classifier answer more conservatively, because
    // everything it can do is something the guard below is there to catch.
    if (onStaged) await onStaged({ projectDir, scratchProject });

    let deployEnv;
    try {
      deployEnv = await productionCredentialEnvironment(scratch, credential.path);
    } catch (error) {
      return refuseAll(
        `could not establish the production hook environment — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Taken AFTER staging and before the first child process, so the window it
    // covers is exactly the window in which this classifier runs other people's
    // programs. Both are also the far end of a bracket: the live tree's against
    // `preStagingBaseline` just below, and the repository's against the
    // pre-setup answers read at the top of this function.
    let liveBaseline;
    let metadataBaseline;
    try {
      liveBaseline = await liveTreeFingerprint(liveDirs, projectDir, liveFiles, liveEntryDirs);
      metadataBaseline = metadataDirs.length > 0 ? await gitAnswerFingerprint(projectDir) : "";
    } catch (error) {
      return refuseAll(
        `could not fingerprint the live checkout — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // THE BASELINE HAS TO BE THE TREE THE COPY READ. Staging reads the checkout
    // file by file and the baseline is taken when it finishes, so anything that
    // edited a Functions source in between was recorded as the unchanged
    // starting state while the scratch project kept the pre-edit bytes. Every
    // later fingerprint then matched that baseline, the drift checks reported
    // nothing, and an artifact built from stale source could prove a selector
    // exact for a checkout that is no longer the one `deploy.sh`'s clean-tree
    // guard approved — the deploy would build and publish the edit with invoker
    // reconciliation switched off (Codex P1, round 25 on #1107).
    //
    // Nothing this rehearsal does writes into the live tree, so the two
    // fingerprints are identical unless something else on this machine wrote
    // during the copy. That is the same condition as a hook writing there, and
    // it is answered the same way: fatal, because the tree the deploy is about
    // to build from has changed since it was approved, and a conservative
    // classification would leave `deploy.sh` to publish it anyway.
    const duringStaging = firstLiveTreeDrift(preStagingBaseline, liveBaseline);
    if (duringStaging) throw new LiveCheckoutDriftError(duringStaging, "concurrent writer");
    // AND THE SAME BRACKET AROUND WHAT GIT ANSWERS. The tree fingerprint above
    // says nothing about a moved ref — `.git` is exposed as metadata, never
    // walked — so the pre-setup answers taken at the top of this function are
    // compared with the post-staging ones here. A background fetch that
    // advanced `origin/main` while the containment was being proved or the copy
    // was running is drift, not a new baseline, and it is FATAL for the reason
    // `RepositoryMetadataDriftError` states: `deploy.sh` asked whether HEAD
    // equalled origin/main before calling this, the build stamps the bundle
    // from `git` answers, and a conservative classification would leave the
    // wrapper to build and publish from a checkout that guard no longer covers.
    //
    // Gated on `metadataDirs` exactly as `metadataDrift` below is, so a layout
    // whose `.git` the staging could not expose is treated the same way at both
    // ends rather than reading as drift for having no answer to compare.
    if (
      preSetupMetadata !== null &&
      metadataDirs.length > 0 &&
      metadataBaseline !== preSetupMetadata
    ) {
      throw new RepositoryMetadataDriftError(
        `\n${preSetupMetadata}\nbecame\n${metadataBaseline}`,
        "concurrent writer",
      );
    }
    /**
     * Whether anything reached the WORKING TREE through the overlay's symlinks
     * since the baseline. Fatal: the deploy is about to build and publish from
     * a tree this run has already changed, after the clean-tree guard passed.
     */
    const liveDrift = async () => {
      try {
        return firstLiveTreeDrift(liveBaseline, await liveTreeFingerprint(liveDirs, projectDir, liveFiles, liveEntryDirs));
      } catch (error) {
        return `the live checkout could not be re-read — ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    /**
     * The same question for the repository metadata, asked of what `git`
     * answers rather than of the files under `.git`. Not fatal: nothing the
     * deploy publishes comes from `.git`, but a run that changed what `git`
     * says answered its own lookups, so the inventory is unusable.
     */
    const metadataDrift = async () => {
      if (metadataDirs.length === 0) return null;
      try {
        const now = await gitAnswerFingerprint(projectDir);
        return now === metadataBaseline ? null : `\n${metadataBaseline}\nbecame\n${now}`;
      } catch (error) {
        return `the repository could not be re-read — ${error instanceof Error ? error.message : String(error)}`;
      }
    };

    /**
     * Whatever this rehearsal started and its process group could not hold,
     * ended and described — or null when there was nothing.
     *
     * A platform that cannot be scanned is itself a refusal: silence there is
     * not an all-clear.
     *
     * The FATAL live-tree and metadata checks are NOT made here. They belong to
     * `settleRehearsal`, which repeats them after the sweep on every exit — so
     * a refusal that had nothing to do with a process (a hook that simply
     * exited nonzero) gets them too, rather than only the exits a sweep
     * happened to find something on.
     */
    const sweepEscapees = async (what) => {
      const escaped = await sweepEscapedProcesses(rehearsalMarker);
      if (escaped.scanned && escaped.pids.length === 0) return null;
      if (!escaped.scanned) {
        return `this platform cannot prove that ${what} left nothing running outside its process group — ${escaped.reason}`;
      }
      return (
        `${what} left ${escaped.pids.length} process(es) running outside its process group, ` +
        "where no signal of this rehearsal's could reach them; they have been ended, but what " +
        "they would have done to the artifact cannot be rehearsed"
      );
    };

    /**
     * The rehearsal's ONE exit: sweep first, repeat the fatal checks second,
     * answer third.
     *
     * SWEEP FIRST, ALWAYS. A process this rehearsal started can outlive the
     * step that started it (see `REHEARSAL_MARKER_VAR`), and it does not have
     * to be the reason that step failed: a hook can detach a sleeper-then-
     * writer into its own session and THEN exit nonzero for a reason that is
     * the rehearsal's own — authenticating against the synthetic ADC, say. That
     * failure is a conservative classification, `deploy.sh` accepts it and
     * carries on, and the detached writer reaches a deployment input minutes
     * later through an inherited absolute path such as `INIT_CWD` — after the
     * clean-tree guard, and after the last fingerprint that was watching (Codex
     * P1, round 20 on #1107). So the sweep runs before the checks below rather
     * than only where an escapee was the complaint, and it runs before them so
     * that nothing is still writing while the tree is read.
     *
     * CHECKS SECOND. Whatever the sweep just ended may already have written, so
     * the fatal live-tree and metadata checks are repeated over the tree as it
     * stands, exactly as they are for a hook that left work inside its group.
     * Both remain fatal: a conservative classification is not enough once the
     * tree the clean-tree guard approved has moved.
     */
    const settleRehearsal = async (exit) => {
      if (!(exit instanceof RehearsalExit)) {
        throw new Error(
          "the rehearsal returned an answer instead of a RehearsalExit, which would skip the sweep",
        );
      }
      const escaped = await sweepEscapees(exit.what);
      if (escaped === null && exit.reason === null) return null;
      const wrote = await liveDrift();
      if (wrote) throw new LiveCheckoutDriftError(wrote, exit.what);
      const moved = await metadataDrift();
      if (moved) throw new RepositoryMetadataDriftError(moved, exit.what);
      if (exit.reason === null) return refuseAll(escaped);
      if (escaped === null) return refuseAll(exit.reason);
      // Both: the step failed AND left something running. Neither half is the
      // whole story, so the refusal names both.
      return refuseAll(`${exit.reason}; ${escaped}`);
    };

    /**
     * Everything this classifier runs of other people's programs: every
     * predeploy hook in Firebase's order, then every discovery probe.
     *
     * It answers with a `RehearsalExit` and never with an inventory, so that
     * the sweep in `settleRehearsal` cannot be skipped by an exit added here
     * later. Fatal drift still THROWS from where it is found, and the caller
     * sweeps on that path too.
     */
    const rehearse = async () => {
      for (const hook of hookPlan) {
        const result = await runPredeployHook(hook.command, {
          projectDir: scratchProject,
          resourceDir: hook.resourceRel ? resolve(scratchProject, hook.resourceRel) : scratchProject,
          project,
          timeoutMs: predeployTimeoutMs,
          deployEnv,
          rehearsalMarker,
          containment,
        });
        if (!result.ok) {
          // A hook can write through the overlay and THEN fail — and it can
          // detach a writer into its own session and then fail for a reason of
          // the rehearsal's own. Its failure is a conservative refusal, but the
          // write is the fatal condition and the escapee is the pending one, so
          // this exit hands both to `settleRehearsal` rather than answering
          // here: sweep, then the fatal checks, and only then the refusal that
          // would otherwise let `deploy.sh` carry on into BUILD_CMD with a
          // mutated checkout (Phase 4b P1, round 19; Codex P1, round 20).
          return new RehearsalExit(
            "failing predeploy hook",
            `predeploy hook failed: ${hook.command} — ${result.output.trim().slice(-400)}`,
          );
        }
        if (result.descendantsLeft) {
          // A hook that returned with work still running in the background has
          // an outcome this rehearsal cannot reproduce: Firebase lets that work
          // finish on its own clock, so the artifact it discovers may differ
          // from the one here whether the descendant is ended or awaited
          // (Codex P1, round 17). The live tree AND the repository metadata are
          // still checked — the descendant may already have written into the
          // tree or moved a ref (Codex P1, round 19) — and only then does the
          // request fall to the conservative arm rather than to a guess.
          // `settleRehearsal` makes those checks, after its sweep.
          return new RehearsalExit(
            "predeploy hook",
            `predeploy hook left work running in the background, whose effect on the artifact cannot be rehearsed: ${hook.command}`,
          );
        }
        // Swept between hooks as well as at the exit, so an escapee is
        // attributed to the hook that started it rather than to a later one.
        const escapedHook = await sweepEscapees("a predeploy hook");
        if (escapedHook) return new RehearsalExit("a predeploy hook", escapedHook);
      }

      const afterHooks = await liveDrift();
      if (afterHooks) throw new LiveCheckoutDriftError(afterHooks, "predeploy hook");
      const metadataAfterHooks = await metadataDrift();
      if (metadataAfterHooks) throw new RepositoryMetadataDriftError(metadataAfterHooks, "predeploy hook");

      const targets = targetCodebases(only, configs, codebaseNames);
      const selected = staged.filter((config) => targets.has(config.codebase));

      /**
       * One private copy of the whole project per config probe, with EVERY
       * selected codebase discovered inside it, in Firebase's own order.
       *
       * The probes still run one at a time from a private copy: two live peers
       * can agree deliberately, and an artifact that appends a marker at load and
       * waits for a second one would answer "one endpoint" to both while the
       * deploy's single discovery sees a group (Codex P2, round 17).
       *
       * What changed in round 18 is the GRAIN. A fresh copy per codebase threw
       * away the effects Firebase preserves between codebase discoveries:
       * `loadCodebases` walks the selected codebases sequentially against ONE
       * project, so the first codebase's module initialization can generate or
       * replace the second's artifact — and with a copy each, that write landed
       * in a directory deleted before the second inventory began, so both probes
       * approved single endpoints while the real second discovery found a group.
       * The probe is therefore project-level: one copy, every codebase in
       * sequence, exactly the shape the deploy will run.
       *
       * The residual is unchanged: state that outlives the process and lives
       * outside both the project and the scratch dir — `$HOME`, `/tmp`, a lock
       * server. The cost is one project copy per probe rather than one per
       * codebase per probe, which for a single-codebase repository is the same
       * two copies it already paid.
       */
      const perProbe = [];
      for (const probe of CONFIG_PROBES) {
        /** @type {string[]} */
        const probeLinks = [];
        let probeRoot;
        try {
          probeRoot = await mkdtemp(join(scratch, "probe-"));
          // At the same place inside its own root the staging used, so a
          // codebase whose module load asks `git` where it is gets the same
          // answer the hooks did. The project directory carries its own `.git`
          // (a nested config never reaches here — `nestedProjectRefusal`), so
          // `copyStagedProject` brings the whole repository view with it.
          const probeProject = join(probeRoot, STAGED_PROJECT_DIRNAME);
          await copyStagedProject(scratchProject, probeProject, probeLinks);
          const results = new Map();
          for (const config of selected) {
            // A codebase this classifier has already refused is never LOADED.
            // Discovering it would run its module-scope code — which can
            // rewrite another selected codebase's artifact before that one is
            // read — for an inventory that could not be authoritative anyway,
            // and under an environment that had to be substituted: a codebase
            // whose `configDir` is absolute has its dotenv files read from its
            // SOURCE dir instead, which is a different configuration from the
            // one the deploy will load. Its inventory is set below, refused.
            if (config.blocked) continue;
            results.set(
              config.codebase,
              await discoverCodebaseInProbe({
                probeProject,
                config,
                project,
                projectAlias,
                probe,
                discoveryTimeoutMs,
                rehearsalMarker,
                containment,
              }),
            );
          }
          perProbe.push({ probe, results });
        } catch (error) {
          // Codebase code has already run by the time a LATER probe fails to set
          // up (Phase 4b P1, run 4): the first discovery may have written through
          // the overlay, or left a process of its own running, and returning
          // conservatively here would let deploy.sh carry on into BUILD_CMD with
          // a mutated checkout. Every exit after executing codebase code sweeps
          // and enforces the fatal checks first — which is what returning an
          // exit rather than an answer guarantees.
          return new RehearsalExit(
            "discovery probe",
            `could not isolate the ${probe.label} discovery probe — ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          for (const link of probeLinks) await unlink(link).catch(() => {});
          if (probeRoot) await rm(probeRoot, { recursive: true, force: true }).catch(() => {});
        }
        const escapedProbe = await sweepEscapees("a discovery probe");
        if (escapedProbe) return new RehearsalExit("a discovery probe", escapedProbe);
      }

      for (const config of selected) {
        inventories.set(
          config.codebase,
          config.blocked
            ? refused(`codebase ${config.codebase} cannot be inventoried here — ${config.blocked}`)
            : reconcileProbeResults(
                config.sourceRel,
                perProbe.map(({ probe, results }) => ({ probe, discovered: results.get(config.codebase) })),
              ),
        );
      }
      for (const config of configs) {
        if (!inventories.has(config.codebase)) {
          inventories.set(
            config.codebase,
            refused(
              targets.has(config.codebase)
                ? "codebase has no mirrorable local source"
                : "this deploy does not load that codebase",
            ),
          );
        }
      }

      // Loading an artifact runs its module-scope code, which reaches the same
      // symlinks a hook does. Checked a second time rather than once at the end,
      // so a hook that writes into the live checkout is caught before this
      // classifier spends a discovery on it.
      const afterDiscovery = await liveDrift();
      if (afterDiscovery) throw new LiveCheckoutDriftError(afterDiscovery, "loaded codebase");
      const metadataAfterDiscovery = await metadataDrift();
      if (metadataAfterDiscovery) {
        throw new RepositoryMetadataDriftError(metadataAfterDiscovery, "loaded codebase");
      }

      // Last, and over the whole selected set: one codebase this run could not
      // vouch for makes every other selected codebase's inventory unusable too.
      // See `firstUnprovableCodebase` for why the answer cannot be per-codebase.
      // Over the SELECTED SET as `targetCodebases` computed it, not over the
      // stageable subset: a selected codebase with no mirrorable source, and a
      // selected codebase this classifier refused to build, are both codebases
      // whose real behaviour is unknown, and both are loaded in the same
      // sequence as the rest.
      const unprovable = firstUnprovableCodebase([...targets], inventories);
      if (unprovable) {
        return new RehearsalExit(
          "the rehearsal",
          `codebase ${unprovable.codebase} could not be inventoried, and this deploy loads it in the ` +
            `same sequence as the rest — ${unprovable.reason}`,
        );
      }
      return new RehearsalExit("the rehearsal");
    };

    let exit;
    try {
      exit = await rehearse();
    } catch (error) {
      // The rehearsal threw: a fatal drift, or a defect. Nothing it started may
      // outlive it either way, so the sweep runs here too — silently, because
      // the error the caller has to see is the one already on its way up.
      await sweepEscapedProcesses(rehearsalMarker).catch(() => {});
      throw error;
    }
    const refusal = await settleRehearsal(exit);
    return refusal ?? inventories;
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
 * The SDK binary the delegate would run for this codebase.
 *
 * Mirrors `findFunctionsBinary`: the codebase's own `node_modules/.bin` first,
 * then the project's, then wherever `firebase-functions` actually resolved
 * from. Returns null when none exists, which is a refusal, not a fallback.
 */
function findFunctionsBinary(sourceDir, projectDir) {
  const candidates = [join(sourceDir, "node_modules"), join(projectDir, "node_modules")];
  try {
    const sdk = require.resolve("firebase-functions", { paths: [sourceDir] });
    const at = sdk.lastIndexOf("node_modules");
    if (at !== -1) candidates.push(sdk.slice(0, at + "node_modules".length));
  } catch {
    // No SDK resolvable from the codebase: the candidates above may still hold
    // a binary, and if none does this returns null and the caller refuses.
  }
  for (const modules of candidates) {
    const binary = join(modules, ".bin", "firebase-functions");
    if (existsSync(binary)) return binary;
  }
  return null;
}

/**
 * Ask the codebase's OWN Firebase Functions SDK what it would deploy.
 *
 * This is the whole point of the design taken to its conclusion. An earlier
 * revision reimplemented `extractStack` in a walker of its own, and every round
 * of review found another way that reimplementation's host differed from the
 * real one: a stubbed module changed control flow, a synchronous walk missed a
 * microtask-queued mutation, `process.argv[1]` and `require.main` were this
 * script's rather than the SDK binary's, and the walker's own report could be
 * forged by the artifact sharing its process (Codex P2, rounds 10-14).
 *
 * None of those can differ from the deploy when the deploy's own program is
 * what answers. `spawnFunctionsProcess` runs the SDK binary with the source dir
 * as argv and cwd; `detectFromPort` then GETs `/__/functions.yaml` from it and
 * reads the endpoint ids out of the wire manifest. So does this — with one
 * addition, a `--require` preload that node consumes and never places in
 * `process.argv`, which records whether anything consulted the one environment
 * value the classifier cannot reproduce.
 */
async function discoverEndpointsFromSdk({
  sourceDir,
  projectDir,
  environment,
  timeout,
  rehearsalMarker,
  containment,
}) {
  const binary = findFunctionsBinary(sourceDir, projectDir);
  if (!binary) return { ok: false, reason: "no firebase-functions binary for this codebase" };

  // The delegate's own port choice (`8000 + randomInt(0, 1000)`, via
  // portfinder), so a busy port behaves here as it does there.
  let port;
  try {
    port = await portfinder.getPortPromise({ port: 8000 + Math.floor(Math.random() * 1000) });
  } catch (error) {
    return { ok: false, reason: `no free discovery port — ${error.message}` };
  }

  const deadline = Date.now() + timeout;
  // Loading an artifact runs its module-scope code, which is another of this
  // config's programs and gets the same containment the hooks got: an endpoint
  // whose module initialisation detaches a writer cannot reach the checkout
  // either. The mechanism is an argv prefix, so the SDK binary still receives
  // exactly the argv `spawnFunctionsProcess` gives it.
  const contained = containment.wrap(process.execPath, [
    "--require",
    DISCOVERY_PRELOAD,
    binary,
    sourceDir,
  ]);
  const server = runCapturedProcess(
    contained.command,
    contained.args,
    {
      cwd: sourceDir,
      timeout,
      extraChannel: true,
      // `serveAdmin`'s teardown waits for the SDK process's `exit` and for
      // nothing else, so this waits for the same event (Phase 4b, runs 6 and 7
      // on #1107). Settling on `close` waited on the PIPES instead, which a
      // background descendant that inherited stdout holds open: the deadline
      // then expired, killed the group, and the run was reported with the SDK's
      // own exit status and no descendants left — a fail-OPEN answer for
      // exactly the shape the refusals below exist to catch. The verdict
      // descriptor is drained separately, so settling earlier does not lose it.
      settleOn: "exit",
      env: {
        ...environment,
        PORT: String(port),
        // The preload deletes this before the artifact can see it; its verdict
        // comes back over the descriptor, not through anything on disk.
        FIREBASE_DEPLOY_SCOPE_WATCH_RUNTIME_CONFIG: "1",
        // Kept, unlike the watch flag above: a process the artifact detaches
        // inherits this copy of the environment, and the marker is the only
        // thing by which the sweep can then find it.
        [REHEARSAL_MARKER_VAR]: rehearsalMarker,
      },
    },
  );

  let manifest;
  let finished;
  try {
    manifest = await pollDiscoveryManifest(port, deadline, server);
  } finally {
    // `serveAdmin`'s teardown: ask it to stop, then make sure of it.
    await fetch(`http://127.0.0.1:${port}/__/quitquitquit`).catch(() => {});
    finished = await server;
  }
  if (!finished) {
    return { ok: false, reason: "the discovery process produced no result" };
  }
  if (finished.timedOut) {
    // The deadline fired, so this run was ENDED rather than finished: whatever
    // the codebase had still to do at that moment, the deploy will let it do.
    return {
      ok: false,
      reason: "discovery did not end before the deadline, so what it would have done cannot be rehearsed",
    };
  }
  if (finished.descendantsLeft) {
    // The same refusal the predeploy-hook path applies (Phase 4b P1, run 5):
    // Firebase's serveAdmin teardown waits only for the SDK process, so a
    // generator a codebase left running with ignored stdio finishes on its own
    // clock during the real deploy and can rewrite a LATER codebase's artifact
    // before that one is discovered. Both rehearsals end it, so neither can
    // see what it would have done; the inventory is refused instead.
    return {
      ok: false,
      reason:
        "discovery left work running in the background, whose effect on a later codebase's artifact cannot be rehearsed",
    };
  }
  if (manifest.ok && finished.channel.includes("consulted")) {
    return {
      ok: false,
      reason:
        "the codebase consulted project configuration only the deploy's authenticated fetch can " +
        "supply — the legacy functions.config() namespaces, the FIREBASE_CONFIG this classifier " +
        "has to invent, or a firebase-admin app option built from one of them",
    };
  }
  if (!manifest.ok) return manifest;
  if (!finished.ok) {
    // The manifest was served, but the process that served it did not end the
    // way the deploy's will. Whatever made it fail ran inside the codebase's
    // own load, so the surface it reported is not one to inventory.
    return {
      ok: false,
      reason: `discovery ended abnormally after answering — ${finished.output.trim().slice(-400) || `exit ${finished.code ?? "?"}`}`,
    };
  }
  return manifest;
}

/** `detectFromPort`, minus the parts that only matter to a real deploy. */
async function pollDiscoveryManifest(port, deadline, server) {
  const url = `http://127.0.0.1:${port}/__/functions.yaml`;
  let exited = false;
  server.then(() => {
    exited = true;
  });
  for (;;) {
    if (Date.now() > deadline) {
      return { ok: false, reason: "discovery did not answer before the deadline" };
    }
    let response;
    try {
      response = await fetch(url);
    } catch {
      if (exited) {
        const finished = await server;
        return {
          ok: false,
          reason: `discovery exited before answering — ${finished.output.trim().slice(-400) || "no output"}`,
        };
      }
      await new Promise((wake) => setTimeout(wake, 50));
      continue;
    }
    if (response.status !== 200) {
      const body = await response.text().catch(() => "");
      return { ok: false, reason: `discovery answered ${response.status} — ${body.trim().slice(-400)}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(await response.text());
    } catch (error) {
      return { ok: false, reason: `discovery manifest did not parse — ${error.message}` };
    }
    if (!parsed || typeof parsed.endpoints !== "object" || parsed.endpoints === null) {
      return { ok: false, reason: "discovery manifest carried no endpoints object" };
    }
    return { ok: true, endpoints: Object.keys(parsed.endpoints) };
  }
}

/**
 * Ask ONE codebase, inside one already-copied project probe, what it deploys.
 *
 * Every uncertainty is reported as a per-codebase refusal rather than thrown,
 * because a codebase this classifier cannot read must not veto a selector
 * qualified to another one.
 */
async function discoverCodebaseInProbe({
  probeProject,
  config,
  project,
  projectAlias,
  probe,
  discoveryTimeoutMs,
  rehearsalMarker,
  containment,
}) {
  const scratchSource = resolve(probeProject, config.sourceRel);

  // The Node delegate tries `functions.yaml` BEFORE running the SDK's
  // discovery, so a manifest — committed, written by a hook, or written by an
  // EARLIER codebase in this same probe — decides the deployed surface and the
  // artifact no longer does (`runtimes/node/index.js` `discoverBuild`). Refuse
  // rather than parse it. Checked inside the probe, where the deploy checks it.
  let manifests;
  try {
    manifests = (await readdir(scratchSource)).filter((name) => /^functions\.ya?ml$/i.test(name));
  } catch (error) {
    return {
      ok: false,
      reason: `could not read ${config.sourceRel} — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (manifests.length > 0) {
    return { ok: false, reason: `${manifests[0]} supplies discovery instead of the artifact` };
  }

  // Read from the probe rather than from the staged original: `loadCodebases`
  // loads each codebase's dotenv files at ITS turn in the sequence, so an
  // earlier codebase that rewrote them is visible here exactly as it is to the
  // deploy.
  let environment;
  try {
    environment = discoveryEnvironment({
      scratchProject: probeProject,
      scratchConfigDir: resolve(probeProject, config.configDirRel ?? config.sourceRel),
      project,
      projectAlias,
      probe,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `could not load the codebase environment — ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return discoverEndpointsFromSdk({
    sourceDir: scratchSource,
    projectDir: probeProject,
    environment,
    timeout: discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
    rehearsalMarker,
    containment,
  });
}

/**
 * The first SELECTED codebase whose inventory this run could not vouch for.
 *
 * A decision rather than a walk, and exported so it can be put directly:
 * `loadCodebases` discovers the selected codebases IN SEQUENCE against one
 * project, so a codebase whose own discovery was refused — it consulted a value
 * this classifier cannot supply, it left work running, it would not load — is a
 * codebase whose real behaviour is unknown, and one of the things an unknown
 * codebase does at module initialisation is rewrite ANOTHER selected codebase's
 * artifact before that one is discovered. The inventories that did come back
 * therefore describe a project this deploy may never produce, so uncertainty in
 * any one selected codebase is uncertainty in all of them (Phase 4b, runs 6 and
 * 7 on #1107). It has to be decided here, over the whole selected set, because
 * the explicit protected-callable branches in `classifyInvokerScope` answer
 * from the selector alone and never consult another codebase's inventory.
 *
 * Only SELECTED codebases count. A codebase this deploy does not load runs no
 * code and can rewrite nothing, which is why `endpointMatchesFilter`'s
 * per-codebase keying stays correct for it.
 *
 * EVERY selected codebase, though, not just the ones that got as far as a
 * discovery. A codebase this classifier refused to build — an unsupported
 * runtime, an unmirrorable `configDir`, a kit, no local source at all — is
 * exactly a codebase whose real behaviour is unknown, and Firebase loads it in
 * the same sequence as the rest. The caller therefore passes the selected set as
 * `targetCodebases` computed it, and the inventories map carries a refusal for
 * each of those (Phase 4b P1 on #1107).
 */
export function firstUnprovableCodebase(selectedCodebases, inventories) {
  for (const codebase of selectedCodebases) {
    const inventory = inventories.get(codebase);
    if (inventory && inventory.authoritative) continue;
    return { codebase, reason: inventory?.reason ?? "no inventory was produced" };
  }
  return null;
}

/**
 * One codebase's inventory, from its discovery in each project probe.
 *
 * Two runs, not one: the deployed surface must be the same under both
 * `CONFIG_PROBES` before it can be trusted, because the difference between them
 * is exactly the project config this classifier could not obtain.
 */
function reconcileProbeResults(sourceRel, results) {
  const failed = results.find(({ discovered }) => !discovered || !discovered.ok);
  if (failed) return refused(failed.discovered?.reason ?? "the discovery probe produced no answer");

  const [first, ...rest] = results.map(({ probe, discovered }) => ({
    probe,
    endpoints: discovered.endpoints,
  }));
  const signature = (result) => [...result.endpoints].sort().join(" ");
  const divergent = rest.find((result) => signature(result) !== signature(first));
  if (divergent) {
    return refused(
      "the deployed surface changes with project config this classifier cannot supply " +
        `(${first.probe.label}: ${first.endpoints.join(", ") || "none"}; ` +
        `${divergent.probe.label}: ${divergent.endpoints.join(", ") || "none"})`,
    );
  }

  if (process.env.FIREBASE_DEPLOY_CLASSIFIER_DEBUG) {
    console.error(`  classifier: ${sourceRel} deploys ${first.endpoints.join(", ")}`);
  }
  return { authoritative: true, endpoints: first.endpoints };
}

/**
 * The artifact inventories for this project, built at most once per process.
 *
 * Lazy on purpose: a `--only hosting` run, a whole-codebase `--only functions`,
 * and every selector the source pre-check already refuses all classify without
 * building anything. Project-wide rather than per-codebase because the hook set
 * Firebase runs is chosen by the `--only` string, not by the codebase.
 *
 * Once per process is also the right lifetime. `deploy.sh` classifies once per
 * deploy, so the inventory describes the tree as it stood a few steps before
 * the release — the same window in which the app build and the deploy's own
 * predeploy run. Editing a codebase inside that window invalidates the
 * classification exactly as it invalidates everything else the deploy computed.
 */
async function artifactEndpointInventory(inventory, codebase) {
  if (!inventory.artifacts) {
    inventory.artifacts = buildAndInventoryProject(inventory.staging);
  }
  const inventories = await inventory.artifacts;
  return inventories.get(codebase) ?? { authoritative: false, endpoints: [], groups: [] };
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
 * `blocked` is tracked PER CODEBASE and then carried onto that codebase's
 * CONFIGS, because two different readers need it. `endpointMatchesFilter`
 * rejects an endpoint whose codebase differs from the filter's, so a selector
 * pointed at a blocked codebase is refused from the entry alone. But
 * `buildAndInventoryProject` works from `configs`, where the restriction used to
 * be invisible: it discovered a blocked codebase anyway — under a substituted
 * environment, since a codebase whose `configDir` is absolute has its dotenv
 * files read from its source dir instead — reported an authoritative inventory
 * for it, and let a PEER's selector be proved exact beside it. With the reason
 * on the config, such a codebase is never loaded, its inventory is never
 * authoritative, and `firstUnprovableCodebase` refuses the whole project when
 * this deploy selects it (Phase 4b P1 on #1107).
 */
async function singleEndpointInventory(
  configSource,
  configPath,
  { project, projectAlias },
  only,
  // The rehearsal's own controls, named rather than positional: they are the
  // arguments `main()` never passes (the two deadlines, the containment mode
  // and the two test seams) plus the one it does — the established deploy
  // credential a wrapper names. See `classifyFirebaseDeployRequest`.
  {
    predeployTimeoutMs,
    discoveryTimeoutMs,
    writeContainment,
    onStaged,
    afterContainment,
    establishedCredentialPath,
  },
) {
  const functionsConfigs = Array.isArray(configSource.functions)
    ? configSource.functions
    : [configSource.functions];
  /**
   * @type {Map<string, { candidates: Set<string>, blocked: string | null }>}
   */
  const byCodebase = new Map();
  const codebaseNames = new Set();
  const projectDir = dirname(configPath);
  /** Every config, in order, as the staging and hook mirror needs them. */
  const configs = [];

  const entryFor = (codebase) => {
    let entry = byCodebase.get(codebase);
    if (!entry) {
      entry = { candidates: new Set(), blocked: null };
      byCodebase.set(codebase, entry);
    }
    return entry;
  };
  /** Whether a kit config carries predeploy hooks this classifier cannot mirror. */
  let kitHooks = false;

  for (const functionsConfig of functionsConfigs) {
    if (!functionsConfig || typeof functionsConfig !== "object") continue;

    if ("kit" in functionsConfig) {
      // Kit instance keys are codebase names; their endpoints come from
      // somewhere this classifier does not build.
      for (const instance of Object.keys(functionsConfig.instances ?? {})) {
        codebaseNames.add(instance);
        entryFor(instance).blocked = "kit codebase";
        configs.push({ codebase: instance, rawCodebase: instance, sourceRel: null, steps: [] });
      }
      // A kit config's OWN predeploy hooks run on every Functions deploy
      // (`getReleventConfigs` takes the unconditional branch for a config with
      // no `codebase` key), including `--only functions:<other>:<endpoint>`,
      // and this classifier has nowhere to rehearse them: the kit has no
      // source directory to stage. A hook that rewrites another codebase's
      // artifact would therefore run for real and never here, so no codebase
      // may be proved exact while such hooks exist (Codex P1, round 16 on
      // #1107). Recorded now and applied to every entry below.
      const kitSteps = predeploySteps(functionsConfig.predeploy);
      if (kitSteps === null || kitSteps.length > 0) kitHooks = true;
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
    configs.push({
      // Two names, because they differ: `codebase` is what this classifier
      // inventories under (an implicit config deploys as "default"), while
      // `rawCodebase` is the config field `getReleventConfigs` reads.
      codebase,
      rawCodebase: explicitCodebase,
      sourceRel,
      // `resolveConfigDir` is `configDir || source`: a codebase that sets one
      // keeps its dotenv files there, not in its source dir.
      configDirRel: functionsConfig.configDir
        ? normalizedSourcePath(functionsConfig.configDir)
        : sourceRel,
      steps: predeploySteps(functionsConfig.predeploy),
    });

    if (!sourceRel) {
      // A remoteSource codebase (or any shape without a mirrorable local
      // source) exists and can be deployed; it simply cannot be built here.
      entry.blocked = "no mirrorable local source";
      continue;
    }

    // `Config.path` preserves an ABSOLUTE `configDir`, so the deploy would read
    // dotenv files from a directory the overlay cannot place. Silently falling
    // back to the source dir would read the wrong ones (Codex P2, round 15).
    if (functionsConfig.configDir && !normalizedSourcePath(functionsConfig.configDir)) {
      entry.blocked = "configDir is not a mirrorable project-relative path";
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
    if (entry.staged) {
      entry.blocked = "several configs share this codebase";
      continue;
    }
    entry.staged = true;

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
  if (kitHooks) {
    for (const entry of byCodebase.values()) entry.blocked ??= "kit predeploy hooks";
  }
  // A blocked codebase's reason has to travel with its CONFIGS, not only with
  // the selector entry above. `selectorIsProvableSingleEndpoint` reads the
  // entry, so an unsupported runtime or an unmirrorable `configDir` already
  // refuses a selector pointed AT that codebase — but `buildAndInventoryProject`
  // works from `configs`, where the restriction was invisible, so it discovered
  // the codebase anyway and let a peer's selector be proved exact beside it
  // (Phase 4b P1 on #1107). Applied after the kit sweep above, so a kit's
  // project-wide block reaches every config too.
  for (const config of configs) {
    const blocked = byCodebase.get(config.codebase)?.blocked;
    if (blocked) config.blocked = blocked;
  }

  return {
    byCodebase,
    codebaseNames,
    staging: {
      projectDir,
      only,
      project: project || "",
      projectAlias: projectAlias || "",
      predeployTimeoutMs,
      discoveryTimeoutMs,
      writeContainment,
      onStaged,
      afterContainment,
      establishedCredentialPath,
      codebaseNames,
      configs,
    },
  };
}

/** `predeploy` as the list of shell commands the CLI would run, or `null`. */
function predeploySteps(predeploy) {
  const steps =
    typeof predeploy === "string"
      ? [predeploy]
      : Array.isArray(predeploy)
        ? predeploy
        : predeploy === undefined || predeploy === null
          ? []
          : null;
  if (steps === null || steps.some((step) => typeof step !== "string")) return null;
  return steps;
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
  if (!entry || entry.blocked) return false;
  // Fast pre-check: no build for a name the source never declares as a builder
  // call. This can only withhold an exemption, never grant one.
  if (!entry.candidates.has(name)) return false;

  const artifact = await artifactEndpointInventory(inventory, codebase);
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

/**
 * The function ids that Hosting will ADD to this deploy on its own: every
 * rewrite of a deployed Hosting config whose `function` is an object carrying
 * `pinTag` (Codex P1, round 13 on #1107). The pinned CLI runs
 * `addPinnedFunctionsToOnlyString` before any lifecycle hook — see
 * `deploy/index.js` and `deploy/hosting/prepare.js` — so `--only
 * functions:daily,hosting` is really `--only functions:daily,hosting,
 * functions:<pinned>` by the time Functions deploys, and it re-adds the
 * `functions` target when `hosting` alone was asked for. A selector this
 * classifier judged exact would otherwise release a pinned protected callable
 * with its invoker left un-reconciled.
 *
 * Only the ids are mirrored, not the codebase the CLI resolves from the live
 * backend: the selector branches accept the bare `functions:<name>` form, and
 * an id no branch recognises falls to the conservative arm, which is the
 * fail-closed direction.
 */
/** The configured Functions codebase names, `default` when none is named. */
function functionsCodebaseNames(configSource) {
  const configs = Array.isArray(configSource?.functions)
    ? configSource.functions
    : [configSource?.functions];
  const names = new Set();
  for (const config of configs) {
    if (!config || typeof config !== "object") continue;
    // A kit config carries no `codebase` of its own: the pinned CLI expands
    // its `instances` keys as codebases (`functionsDeployHelper`), so they are
    // counted here too (Codex P1, round 21 on #1107) — a Hosting pin that
    // belongs to a kit instance must make ownership unknown, not collapse the
    // kit into `default` and leave the default codebase looking alone.
    if ("kit" in config) {
      for (const instance of Object.keys(config.instances ?? {})) names.add(instance);
      continue;
    }
    names.add(config.codebase ?? "default");
  }
  return names.size === 0 ? ["default"] : [...names];
}

/**
 * The selector Firebase will ACT on once Hosting has added its pinned
 * functions, computed once and before anything is planned from it (Codex P1,
 * round 14 on #1107): hook planning, codebase discovery and the invoker
 * classification all have to see the same widened request, or the rehearsal
 * can skip a codebase's predeploy hook that the deploy runs and exempt an
 * artifact that hook rewrites.
 *
 * Firebase resolves each pinned function's codebase from the live backend,
 * which this classifier does not consult. Every configured codebase is
 * widened to instead — `functions:<codebase>:<id>` for each — so whichever
 * codebase owns the function has its hooks planned and its artifact
 * discovered; the others cost a rehearsal and change no verdict, because an
 * id a codebase does not export selects nothing there.
 *
 * `functionsReAdded` mirrors `targetNames.unshift("functions")`: with Hosting
 * deployed and a pinned rewrite present, Functions deploys even when the
 * request excluded or never named it.
 */
export function pinnedRewriteWidening({ only, exceptTargets, configSource, project }) {
  const none = { only, ids: [], functionsReAdded: false, ownershipUnknown: false };
  let hostingConfigs;
  try {
    hostingConfigs = filterExcept(
      filterOnly(extract({ config: { src: configSource }, site: project || undefined }), only),
      exceptTargets,
    );
  } catch {
    // A request the pinned CLI rejects is rejected by the boundary below
    // exactly as before; nothing here may pre-empt or soften that.
    return none;
  }
  const ids = pinnedHostingFunctionIds(hostingConfigs);
  if (ids.length === 0) return none;
  const selectors = only ? only.split(",") : [];
  const hostingDeployed = only
    ? selectors.some((selector) => selector === "hosting" || selector.startsWith("hosting:"))
    : !(exceptTargets ? exceptTargets.split(",") : []).includes("hosting");
  if (!hostingDeployed) return none;
  // Which codebase owns a pinned function is something Firebase reads from
  // the live backend and this classifier cannot. With ONE configured codebase
  // the answer is forced; with more, widening discovery to all of them is not
  // conservative either — a codebase Firebase would not discover can, at
  // module initialisation, rewrite the artifact of the one it would (Phase 4b
  // P2, run 4) — so ownership is reported unknown and the caller refuses the
  // exemption rather than rehearse a discovery set Firebase never runs.
  const codebases = functionsCodebaseNames(configSource);
  const ownershipUnknown = codebases.length > 1;
  if (!only) return { only, ids, functionsReAdded: true, ownershipUnknown };
  const widened = [...selectors];
  for (const id of ids) {
    for (const codebase of codebases) {
      const selector = `functions:${codebase}:${id}`;
      if (!widened.includes(selector)) widened.push(selector);
    }
  }
  return { only: widened.join(","), ids, functionsReAdded: true, ownershipUnknown };
}

function pinnedHostingFunctionIds(hostingConfigs) {
  const ids = [];
  for (const config of hostingConfigs ?? []) {
    for (const rewrite of config?.rewrites ?? []) {
      const fn = rewrite?.function;
      if (fn && typeof fn === "object" && fn.pinTag && typeof fn.functionId === "string") {
        ids.push(fn.functionId);
      }
    }
  }
  return ids;
}

export async function classifyInvokerScope(
  only,
  exceptTargets,
  exportedEventInvitationServices,
  singleEndpointExports = { byCodebase: new Map(), codebaseNames: new Set() },
  pinnedFunctionIds = [],
  pinnedOwnershipUnknown = false,
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

    // `only` arrives already widened for pinned Hosting rewrites
    // (`pinnedRewriteWidening`), the same selector hook planning saw.
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

    // A pinned Hosting function whose codebase cannot be known offline may
    // release anything (Phase 4b P2, run 4): every invoker turns conservative.
    if (pinnedOwnershipUnknown && pinnedFunctionIds.length > 0) selectEveryInvokerConservatively();

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
    // With no `--only` there is no selector string to widen, but the CLI still
    // re-adds the `functions` TARGET when a deployed Hosting config pins a
    // function — and without a selector that is the whole codebase, every
    // invoker included. Undo the exclusion above rather than trust it.
    if (hostingAttempted && pinnedFunctionIds.length > 0 && !functionsAttempted) {
      functionsAttempted = true;
      bugReportInvokerSelected = true;
      emailUnsubscribeInvokerSelected = true;
      authHandoffInvokerSelected = true;
      eventInvitationsInvokerSelected = exportedInvitationServices.size > 0;
      eventInvitationsStrictServices = exportedInvitationCsv;
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
    // The predeploy-hook deadline, as an ARGUMENT rather than an environment
    // variable: `main()` never passes it, so no shell can widen a safety bound
    // from outside, while a test can shorten it enough to prove that a hook
    // whose descendants outlive their shell still settles promptly.
    predeployTimeoutMs = PREDEPLOY_HOOK_TIMEOUT_MS,
    // The discovery deadline, an argument for the same reasons: a test can
    // shorten it to prove that a codebase whose discovery process will not end
    // forfeits the inventory rather than being inventoried anyway.
    discoveryTimeoutMs = DISCOVERY_TIMEOUT_MS,
    // Whether write containment may be established at all. An argument for the
    // same reason again, and one that only ever NARROWS: `"unavailable"` makes
    // this classifier behave as it does on a machine with no mechanism, which
    // is to refuse every exemption without running a hook. `main()` never
    // passes it, so no shell can reach it, and a test that does cannot widen
    // anything by doing so.
    writeContainment = "auto",
    // Awaited between the staging copy and the post-staging baseline, and an
    // argument for the same reasons as the three above: `main()` never passes
    // it, so no shell can reach it, and what it exists to reach is a window
    // this classifier can otherwise only lose a race in. A test uses it to be
    // the concurrent writer the bracket around the staging refuses.
    onStaged = null,
    // The same seam one step earlier: awaited after the write containment is
    // established and before the overlay is planned or copied. That interval is
    // the one the Git baseline used to be taken AFTER, so a test uses this to
    // be the background fetch the bracket around the repository's answers now
    // refuses. `main()` never passes it either.
    afterContainment = null,
    // The ADC document `GOOGLE_APPLICATION_CREDENTIALS` will point at when
    // `firebase deploy` runs, named by whatever wrapper established it. UNLIKE
    // the arguments above, `main()` DOES pass this one, from
    // `FIREBASE_DEPLOY_ESTABLISHED_CREDENTIAL` — a wrapper is the only thing
    // that can know the answer, and the same environment already carries the
    // pinned project and config path. It cannot widen a safety bound by being
    // absent or wrong in the cautious direction: with no document named, every
    // exemption is refused. See `establishedDeployCredential` for what naming
    // one asserts and why no synthetic substitute is written any more.
    establishedCredentialPath = null,
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
  // `--project <alias_or_project_id>`: an ALIAS resolves through `.firebaserc`,
  // and `prepare.js` then hands `loadUserEnvs` BOTH the real id and the alias,
  // so `.env.<projectId>` and `.env.<alias>` are each considered. Reading the
  // alias as an id would look for the wrong dotenv file (Codex P2, round 16).
  let projectAlias = "";
  try {
    const rc = JSON.parse(await readFile(resolve(dirname(resolve(options.config ?? defaultConfigPath)), ".firebaserc"), "utf8"));
    const projects = rc.projects ?? {};
    if (!project) project = projects.default ?? "";
    if (project && typeof projects[project] === "string") {
      projectAlias = project;
      project = projects[project];
    }
  } catch {
    // firebase-tools reports a missing project later. Classification stays
    // useful for repos whose local-only deploy checks do not need one.
  }
  const configPath = resolve(options.config ?? defaultConfigPath);
  const only = normalizedFilter(options.only);
  const exceptTargets = normalizedFilter(options.except);
  const configSource = JSON.parse(await readFile(configPath, "utf8"));
  // What Firebase will deploy once Hosting has added its pinned functions —
  // resolved BEFORE anything is planned, so the rehearsal, the discovery and
  // the classification below all act on one request.
  const pinned = pinnedRewriteWidening({ only, exceptTargets, configSource, project });
  const effectiveOnly = pinned.only;
  const exportedEventInvitationServices =
    await eventInvitationServiceInventory(configSource, configPath);
  const singleEndpointExports = await singleEndpointInventory(
    configSource,
    configPath,
    { project, projectAlias },
    effectiveOnly,
    {
      predeployTimeoutMs,
      discoveryTimeoutMs,
      writeContainment,
      onStaged,
      afterContainment,
      establishedCredentialPath,
    },
  );
  // deploy's before-chain runs this target reduction before
  // checkValidTargetFilters. It is the pinned rejection boundary for an
  // option-looking required value such as `--only --dry-run`: Commander owns
  // `--dry-run` as the --only value, then filterTargets rejects that value as
  // an unknown deploy target before any build can start.
  // The pinned CLI's own `Config`, built once and used for everything that
  // reads a target's configuration. Its constructor runs `MATERIALIZE_TARGETS`,
  // which replaces any target written as an import path with the parsed file;
  // `cwd` and `configPath` are what `resolveProjectPath` resolves those imports
  // against, so they name the CONFIGURED project directory rather than whatever
  // directory this process happens to have been started in.
  const deployConfig = new Config(configSource, {
    projectDir: dirname(configPath),
    cwd: dirname(configPath),
    configPath: basename(configPath),
  });
  const deployTargets = filterTargets(
    { only, except: exceptTargets, config: deployConfig },
    [...VALID_DEPLOY_TARGETS],
  );
  // `deploy/index.js` runs EVERY selected target's predeploy hooks before it
  // prepares any of them, so the mirror needs the whole selected target list,
  // in this order, and the raw config those non-Functions hooks come from.
  // `targetNames.unshift("functions")`: Hosting with a pinned rewrite deploys
  // Functions whether or not the request named it.
  // Asked BEFORE the unshift and before the `--public` override, because that
  // is where `deploy/index.js` asks it: `prepareFrameworks` runs ahead of both.
  // Only the `functions` target is ever added below, so the Hosting guard reads
  // the same either way. See `frameworkPreparationRefusal`.
  singleEndpointExports.staging.frameworkPreparation = frameworkPreparationRefusal(
    deployTargets,
    deployConfig,
    only,
  );
  if (pinned.functionsReAdded && !deployTargets.includes("functions")) deployTargets.unshift("functions");
  singleEndpointExports.staging.deployTargets = deployTargets;
  // `-p, --public <path>` lands in the config BEFORE the plan is taken from it,
  // because the CLI puts it there before it chains a single predeploy hook.
  // Only the `functions` target is ever added to `deployTargets` above, so
  // asking after the unshift asks the same question `deploy/index.js` asks
  // before it. See `applyPublicDirectoryOverride`.
  applyPublicDirectoryOverride(deployConfig, options.public, deployTargets);
  // The MATERIALIZED config: hooks are planned from what the CLI's own
  // `getReleventConfigs` will read, so an externalised target's `predeploy`
  // reaches the plan instead of being read off a string as `undefined`, and a
  // Hosting hook's `$RESOURCE_DIR` is the directory `--public` overrode to.
  singleEndpointExports.staging.configSource = deployConfig.data;
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
    effectiveOnly,
    exceptTargets,
    exportedEventInvitationServices,
    singleEndpointExports,
    pinned.ids,
    pinned.ownershipUnknown,
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
      establishedCredentialPath:
        process.env.FIREBASE_DEPLOY_ESTABLISHED_CREDENTIAL || null,
    });
    if (process.env.FIREBASE_DEPLOY_CLASSIFIER_FORMAT === "shell")
      printShellClassification(result);
    else console.log(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof LiveCheckoutDriftError) {
      // A DIFFERENT failure from an invalid request, and it gets its own exit
      // status so `deploy.sh` can say so: the request was fine, the working
      // tree is not.
      console.error(`✗ The Firebase deploy preflight mutated the live checkout: ${message}`);
      console.error("  NOTHING HAS BEEN BUILT OR PUBLISHED.");
      process.exitCode = LIVE_CHECKOUT_DRIFT_EXIT_CODE;
      return;
    }
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
