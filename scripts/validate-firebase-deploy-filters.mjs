#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const commander = require("commander");
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
  if (!value) return undefined;
  const normalized = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(",");
  return normalized || undefined;
}

function classifyInvokerScope(only, exceptTargets) {
  let functionsAttempted = true;
  let hostingAttempted = true;
  let bugReportInvokerSelected = true;
  let emailUnsubscribeInvokerSelected = true;
  let authHandoffInvokerSelected = true;
  let bugReportInvokerConservative = false;
  let emailUnsubscribeInvokerConservative = false;
  let authHandoffInvokerConservative = false;
  let authHandoffStrictHalf = "";

  if (only) {
    functionsAttempted = false;
    hostingAttempted = false;
    bugReportInvokerSelected = false;
    emailUnsubscribeInvokerSelected = false;
    authHandoffInvokerSelected = false;
    let mintNamed = false;
    let exchangeNamed = false;

    for (const selector of only.split(",")) {
      if (selector === "hosting" || selector.startsWith("hosting:")) {
        hostingAttempted = true;
      } else if (selector === "functions" || selector === "functions:default") {
        functionsAttempted = true;
        bugReportInvokerSelected = true;
        emailUnsubscribeInvokerSelected = true;
        authHandoffInvokerSelected = true;
        mintNamed = true;
        exchangeNamed = true;
        bugReportInvokerConservative = false;
        emailUnsubscribeInvokerConservative = false;
        authHandoffInvokerConservative = false;
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
      } else if (selector.startsWith("functions:")) {
        functionsAttempted = true;
        if (!bugReportInvokerSelected) bugReportInvokerConservative = true;
        if (!emailUnsubscribeInvokerSelected)
          emailUnsubscribeInvokerConservative = true;
        if (!authHandoffInvokerSelected) authHandoffInvokerConservative = true;
        bugReportInvokerSelected = true;
        emailUnsubscribeInvokerSelected = true;
        authHandoffInvokerSelected = true;
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
  } else if (exceptTargets) {
    for (const selector of exceptTargets.split(",")) {
      if (selector === "hosting") hostingAttempted = false;
      if (selector === "functions") {
        functionsAttempted = false;
        bugReportInvokerSelected = false;
        emailUnsubscribeInvokerSelected = false;
        authHandoffInvokerSelected = false;
        bugReportInvokerConservative = false;
        emailUnsubscribeInvokerConservative = false;
        authHandoffInvokerConservative = false;
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
    bugReportInvokerConservative,
    emailUnsubscribeInvokerConservative,
    authHandoffInvokerConservative,
    authHandoffStrictHalf,
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

  return {
    project,
    configPath,
    only: only ?? "",
    except: exceptTargets ?? "",
    firebaseDryRun: options.dryRun === true,
    ...classifyInvokerScope(only, exceptTargets),
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
    BUG_REPORT_INVOKER_CONSERVATIVE: result.bugReportInvokerConservative,
    EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE:
      result.emailUnsubscribeInvokerConservative,
    AUTH_HANDOFF_INVOKER_CONSERVATIVE: result.authHandoffInvokerConservative,
    AUTH_HANDOFF_STRICT_HALF: result.authHandoffStrictHalf,
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
