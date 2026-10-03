// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALLABLE_INVOKER_FAMILIES,
  httpsExportGraph,
  httpsFunctionExports,
  unfamiliedHttpsExports,
} from "./callable-invoker-families.mjs";
import { classifyFirebaseDeployRequest, classifyInvokerScope } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realIndex = resolve(repoRoot, "functions", "src", "index.ts");
const fixtures = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Run `action`, capturing what it writes through console.error (the classifier's warning channel). */
async function capturingWarnings(action) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await action();
    return { result, text: spy.mock.calls.map((call) => call.join(" ")).join("\n") };
  } finally {
    spy.mockRestore();
  }
}

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "callable-families-"));
  fixtures.push(root);
  await mkdir(resolve(root, "functions", "src"), { recursive: true });
  await writeFile(resolve(root, "firebase.json"), JSON.stringify({ functions: { source: "functions" } }));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(resolve(root, "functions", "src", name), text);
  }
  return root;
}

describe("callable invoker families (#1277)", () => {
  it("leaves no HTTPS export of the real Functions index unfamilied", () => {
    expect(unfamiliedHttpsExports(realIndex)).toEqual([]);
    expect([...httpsFunctionExports(realIndex)]).toContain("unlockDayNow");
  });

  it("classifies every familied export of the real index, so a star over it stays inventoried (#1299)", () => {
    const graph = httpsExportGraph(realIndex);
    const familied = CALLABLE_INVOKER_FAMILIES.flatMap((family) => family.exports);
    expect(graph.opaque).toBe(false);
    expect(familied.filter((name) => graph.unread.has(name) && !graph.https.has(name))).toEqual([]);
    expect([...graph.https]).toEqual(expect.arrayContaining(["submitBugReport", "emailUnsubscribe", "mintAuthHandoff", "exchangeAuthHandoff", "unlockDayNow"]));
  });

  it("registers a wrapper that exists for every family", () => {
    for (const family of CALLABLE_INVOKER_FAMILIES) {
      expect(existsSync(resolve(repoRoot, family.wrapper)), family.wrapper).toBe(true);
    }
  });

  it("wires every family into deploy.sh, its wrapper and the deploy classifier", () => {
    const deployScript = readFileSync(resolve(repoRoot, "scripts", "deploy.sh"), "utf8");
    const classifier = readFileSync(resolve(repoRoot, "scripts", "validate-firebase-deploy-filters.mjs"), "utf8");
    for (const family of CALLABLE_INVOKER_FAMILIES) {
      const basename = family.wrapper.replace(/^scripts\//, "");
      expect(deployScript, `${basename} in INVOKER_SCRIPTS`).toContain(`INVOKER_SCRIPTS+=("$SCRIPT_DIR/${basename}")`);
      const wrapper = readFileSync(resolve(repoRoot, family.wrapper), "utf8");
      for (const name of family.exports) {
        expect(wrapper, `${family.wrapper} reconciles ${name.toLowerCase()}`).toContain(name.toLowerCase());
        expect(classifier, `exact --only selector for ${name}`).toContain(`/^functions:(?:[^:]+:)?${name}$/`);
      }
    }
  });

  it("finds HTTPS functions built through local and imported helper factories", async () => {
    const root = await fixture({
      "index.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "import { createRequest as makeRequest } from './factories';",
        "export { reexportedFactory } from './factories';",
        "function createCallable(handler: () => Promise<number>) { return onCall(handler); }",
        "const createWrapped = () => createCallable(async () => 1);",
        "export const viaLocalFactory = createCallable(async () => 1);",
        "export const viaFactoryOfFactory = createWrapped();",
        "export const viaImportedFactory = makeRequest();",
        "export const notHttps = Math.max(1, 2);",
      ].join("\n"),
      "factories.ts": [
        "import { onRequest } from 'firebase-functions/v2/https';",
        "export const createRequest = () => onRequest((req, res) => res.end());",
        "export function reexportedFactory() { return onRequest((req, res) => res.end()); }",
      ].join("\n"),
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "viaFactoryOfFactory",
      "viaImportedFactory",
      "viaLocalFactory",
    ]);
  });

  it("finds HTTPS functions imported from a local module, then re-exported or aliased", async () => {
    const root = await fixture({
      "index.ts": [
        "import { adminCallable, other as renamedImport } from './admin';",
        "import { helper } from './admin';",
        "export { adminCallable };",
        "export { renamedImport as reexported };",
        "export const aliased = adminCallable;",
        "export const notHttps = helper;",
      ].join("\n"),
      "admin.ts": [
        "import { onCall, onRequest } from 'firebase-functions/v2/https';",
        "export const adminCallable = onCall(async () => 1);",
        "export const other = onRequest((req, res) => res.end());",
        "export const helper = 42;",
      ].join("\n"),
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "adminCallable",
      "aliased",
      "reexported",
    ]);
  });

  it("finds direct, aliased, local-renamed and re-exported HTTPS functions but not other triggers", async () => {
    const root = await fixture({
      "index.ts": [
        "import { onCall as call, onRequest } from 'firebase-functions/v2/https';",
        "import * as https from 'firebase-functions/v2/https';",
        "import { onSchedule } from 'firebase-functions/v2/scheduler';",
        "export const direct = call({}, async () => 1);",
        "export const viaNamespace = https.onRequest((req, res) => res.end());",
        "const hidden = onRequest((req, res) => res.end());",
        "export { hidden as renamed };",
        "export const scheduled = onSchedule('every day 00:00', async () => {});",
        "export const factory = () => call({}, async () => 1);",
        "export { remote } from './remote.js';",
        "export * from './star';",
      ].join("\n"),
      "remote.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport const remote = onCall(async () => 1);\n",
      "star.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport const starred = onCall(async () => 1);\n",
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "direct",
      "remote",
      "renamed",
      "starred",
      "viaNamespace",
    ]);
  });

  it("warns, naming the export, but never refuses the classification for an unfamilied callable (#1283)", async () => {
    const root = await fixture({
      "index.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => 1);",
        "export const brandNewCallable = onCall(async () => 1);",
      ].join("\n"),
    });

    const warnings = await capturingWarnings(() =>
      classifyFirebaseDeployRequest(["fiveacross", "--only", "functions"], {
        defaultConfigPath: resolve(root, "firebase.json"),
      }),
    );
    expect(warnings.result.functionsAttempted).toBe(true);
    expect(warnings.text).toMatch(/advisory, syntax only.*brandNewCallable.*belongs to no Cloud Run invoker family/);
    expect(warnings.text).toMatch(/check-callable-families-predeploy\.mjs/);
  });

  it("refuses a -c/--config other than the default for a deploy that may release Functions (#1283, #1328)", async () => {
    // The guard is a hook of the default config's Functions predeploy chain; an
    // alternate config replaces that chain, so it must not carry a Functions
    // release past the guard.
    const root = await fixture({
      "index.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport const unlockDayNow = onCall(async () => 1);\n",
    });
    const defaultConfigPath = resolve(root, "firebase.json");
    const other = resolve(root, "other.firebase.json");
    await writeFile(other, JSON.stringify({ functions: { source: "functions" }, firestore: { rules: "firestore.rules" } }));
    await writeFile(resolve(root, "firestore.rules"), "rules_version = '2';\n");

    for (const spelling of [["--config", other], [`--config=${other}`], ["-c", other]]) {
      await expect(
        classifyFirebaseDeployRequest(["fiveacross", ...spelling, "--only", "functions"], { defaultConfigPath }),
      ).rejects.toThrow(/replaces the default .*firebase\.json.*HTTPS export guard.*cannot use it/);
    }
    // The same file reached from another directory is refused too: Firebase
    // takes the project directory from the -c path, and would run that
    // directory's scripts/ as the guard (CodeRabbit P1 on #1328).
    const planted = await mkdtemp(join(tmpdir(), "callable-families-planted-"));
    fixtures.push(planted);
    await symlink(defaultConfigPath, join(planted, "firebase.json"));
    await expect(
      classifyFirebaseDeployRequest(["fiveacross", "--config", join(planted, "firebase.json"), "--only", "functions"], {
        defaultConfigPath,
      }),
    ).rejects.toThrow(/replaces the default .*HTTPS export guard.*cannot use it/);

    // Controls: the same file as the default passes, and so does an alternate
    // config whose deploy releases no Functions.
    const same = await classifyFirebaseDeployRequest(["fiveacross", "--config", defaultConfigPath, "--only", "functions"], {
      defaultConfigPath,
    });
    expect(same.functionsAttempted).toBe(true);
    const away = await classifyFirebaseDeployRequest(["fiveacross", "--config", other, "--only", "firestore"], {
      defaultConfigPath,
    });
    expect(away.functionsAttempted).toBe(false);
  });

  it("follows default exports through default imports and named re-exports", async () => {
    const root = await fixture({
      "index.ts": [
        "import factory from './factory';",
        "export { default as newCallable } from './endpoint';",
        "export const viaDefaultFactory = factory();",
      ].join("\n"),
      "endpoint.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport default onCall(async () => 1);\n",
      "factory.ts": "import { onRequest } from 'firebase-functions/v2/https';\nexport default function () { return onRequest((req, res) => res.end()); }\n",
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "newCallable",
      "viaDefaultFactory",
    ]);
  });

  it("names the HTTPS functions of a namespace export as a Firebase group", async () => {
    const root = await fixture({
      "index.ts": [
        "import * as grouped from './admin';",
        "export * as admin from './admin';",
        "export { grouped };",
        "export const assigned = grouped;",
        "const localGroup = { unlockDayNow };",
        "export { localGroup as aliasedGroup };",
        "export const assignedGroup = localGroup;",
        "const namespaceAlias = grouped;",
        "export const chainedNamespace = namespaceAlias;",
        "export const spreadGroup = { ...localGroup, ...grouped, ...{ inline: unlockDayNow } };",
        "export const outerGroup = { localGroup, named: grouped };",
        "export const castAlias = (unlockDayNow as unknown);",
        "export const memberAlias = grouped.unlockDayNow!;",
        "export const castGroup = { member: grouped.unlockDayNow, cast: unlockDayNow as unknown } satisfies object;",
        "import { onRequest } from 'firebase-functions/v2/https';",
        "import { unlockDayNow } from './admin';",
        "export const objectGroup = { unlockDayNow, renamed: unlockDayNow, inline: onRequest((req, res) => res.end()), other: 1, nested: { deeper: { unlockDayNow } } };",
      ].join("\n"),
      "admin.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => 1);",
        "export const notHttps = 1;",
      ].join("\n"),
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "admin-unlockDayNow",
      "aliasedGroup-unlockDayNow",
      "assigned-unlockDayNow",
      "assignedGroup-unlockDayNow",
      "castAlias",
      "castGroup-cast",
      "castGroup-member",
      "chainedNamespace-unlockDayNow",
      "grouped-unlockDayNow",
      "memberAlias",
      "objectGroup-inline",
      "objectGroup-nested-deeper-unlockDayNow",
      "objectGroup-renamed",
      "objectGroup-unlockDayNow",
      "outerGroup-localGroup-unlockDayNow",
      "outerGroup-named-unlockDayNow",
      "spreadGroup-inline",
      "spreadGroup-unlockDayNow",
    ]);
  });

  it("carries object groups imported or re-exported by name from a local module", async () => {
    const root = await fixture({
      "index.ts": [
        "import { admin } from './groups';",
        "export { admin };",
        "export { admin as renamedAdmin } from './groups';",
      ].join("\n"),
      "groups.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "const unlockDayNow = onCall(async () => 1);",
        "export const admin = { unlockDayNow };",
      ].join("\n"),
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "admin-unlockDayNow",
      "renamedAdmin-unlockDayNow",
    ]);
  });

  it("scans the default functions/ source when the config names none", async () => {
    const root = await fixture({
      "index.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport const brandNewCallable = onCall(async () => 1);\n",
    });
    await writeFile(resolve(root, "firebase.json"), JSON.stringify({ functions: {} }));

    const warnings = await capturingWarnings(() =>
      classifyFirebaseDeployRequest(["fiveacross", "--only", "functions"], {
        defaultConfigPath: resolve(root, "firebase.json"),
      }),
    );
    expect(warnings.text).toMatch(/brandNewCallable.*belongs to no Cloud Run invoker family/);
  });

  it("carries a namespace export as a group through a named import and a named re-export (#1285)", async () => {
    const root = await fixture({
      "index.ts": [
        "import { admin } from './bridge';",
        "export { admin };",
        "export { admin as grouped } from './bridge';",
      ].join("\n"),
      "bridge.ts": "export * as admin from './endpoints';\n",
      "endpoints.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => 1);",
      ].join("\n"),
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "admin-unlockDayNow",
      "grouped-unlockDayNow",
    ]);
  });

  it("does not forward a default export through export * (#1286)", async () => {
    const root = await fixture({
      "index.ts": "export * from './endpoint';\nexport * from './groups';\n",
      "endpoint.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export default onCall(async () => 1);",
        "export const named = onCall(async () => 1);",
      ].join("\n"),
      "groups.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "const inner = onCall(async () => 1);",
        "export default { inner };",
      ].join("\n"),
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual(["named"]);
  });

  it("follows builder aliases, factory aliases and factories across an import cycle", async () => {
    const root = await fixture({
      "index.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "import { cyclic } from './cycle';",
        "import { create } from './aliases';",
        "export { make } from './aliases';",
        "import * as https from 'firebase-functions/v2/https';",
        "const makeCallable = onCall;",
        "const { onRequest: makeRequest } = https;",
        "export const viaBuilderAlias = makeCallable(async () => 1);",
        "export const viaDestructuredBuilder = makeRequest((req, res) => res.end());",
        "export const viaFactoryAlias = create();",
        "export { cyclic };",
      ].join("\n"),
      "aliases.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const make = () => onCall(async () => 1);",
        "export const create = make;",
      ].join("\n"),
      "cycle.ts": [
        "import { make } from './index';",
        "export const cyclic = make();",
      ].join("\n"),
    });

    expect([...httpsFunctionExports(resolve(root, "functions", "src", "index.ts"))].sort()).toEqual([
      "cyclic",
      "viaBuilderAlias",
      "viaDestructuredBuilder",
      "viaFactoryAlias",
    ]);
  });

  it("does not block a deploy that cannot release Functions", async () => {
    const root = await fixture({
      "index.ts": "import { onCall } from 'firebase-functions/v2/https';\nexport const brandNewCallable = onCall(async () => 1);\n",
    });
    await writeFile(
      resolve(root, "firebase.json"),
      JSON.stringify({ hosting: { public: "dist" }, functions: { source: "functions" } }),
    );

    const result = await classifyFirebaseDeployRequest(["fiveacross", "--only", "hosting"], {
      defaultConfigPath: resolve(root, "firebase.json"),
    });
    expect(result.functionsAttempted).toBe(false);
  });
});


describe("submitPrompt invoker deployment scope (#1311)", () => {
  const scope = (only, exports = ["submitPrompt"], except) =>
    classifyInvokerScope(only, except, [], undefined, [], false, [], exports);

  it("selects only the strict prompt family for its proven named export", async () => {
    const result = await scope("functions:submitPrompt");
    expect(result).toMatchObject({ submitPromptInvokerSelected: true,
      submitPromptInvokerConservative: false, bugReportInvokerSelected: false,
      emailUnsubscribeInvokerSelected: false, authHandoffInvokerSelected: false,
      eventInvitationsInvokerSelected: false, adminCallablesInvokerSelected: false });
  });

  it("keeps an unproven named prompt export conservative", async () => {
    expect(await scope("functions:submitPrompt", [])).toMatchObject({
      submitPromptInvokerSelected: true, submitPromptInvokerConservative: true,
      bugReportInvokerSelected: false, authHandoffInvokerSelected: false });
  });

  it("does not select prompt reconciliation for another named callable or hosting", async () => {
    for (const only of ["hosting", "functions:submitBugReport"]) {
      expect(await scope(only, ["submitPrompt", "bugReport"])).toMatchObject({
        submitPromptInvokerSelected: false, submitPromptInvokerConservative: false });
    }
  });

  it("selects prompt conservatively for full releases with no proven export", async () => {
    for (const only of [undefined, "functions", "functions:default", "functions:unknown.group"]) {
      expect(await scope(only, [])).toMatchObject({
        submitPromptInvokerSelected: true, submitPromptInvokerConservative: true });
    }
  });

  it("does not reconcile prompt when all Functions are excluded", async () => {
    expect(await scope(undefined, ["submitPrompt"], "functions")).toMatchObject({
      functionsAttempted: false, submitPromptInvokerSelected: false });
  });

  it("keeps codebase precedence and named-codebase export attribution", async () => {
    const inventory = new Map([["default", []], ["ops", ["submitPrompt"]], ["submitPrompt", []]]);
    const endpoints = { byCodebase: new Map(), codebaseNames: new Set(inventory.keys()) };
    const classify = (only) => classifyInvokerScope(only, undefined, [], endpoints, [], false, [], inventory);
    expect(await classify("functions:ops:submitPrompt")).toMatchObject({
      submitPromptInvokerSelected: true, submitPromptInvokerConservative: false,
      bugReportInvokerSelected: false });
    expect(await classify("functions:default:submitPrompt")).toMatchObject({
      submitPromptInvokerSelected: true, submitPromptInvokerConservative: true });
    expect(await classify("functions:submitPrompt")).toMatchObject({
      submitPromptInvokerSelected: true, submitPromptInvokerConservative: true,
      bugReportInvokerSelected: true, adminCallablesInvokerSelected: true });
  });

  async function invokerFixture() {
    const root = await fixture({});
    const gcloud = resolve(root, "gcloud");
    const log = resolve(root, "gcloud.log");
    await writeFile(gcloud, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GCLOUD_LOG"
if [[ " $* " == *" services describe "* ]]; then
  case "\${FIXTURE_DESCRIBE:-present}" in
    missing) echo 'NOT_FOUND: Requested entity was not found.' >&2; exit 1 ;;
    denied) echo 'PERMISSION_DENIED: fixture denial' >&2; exit 1 ;;
  esac
  echo false
fi
`);
    chmodSync(gcloud, 0o755);
    const run = (args, state) => spawnSync(resolve(repoRoot, "scripts/set-submit-prompt-invoker.sh"), args, {
      encoding: "utf8", env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: "",
        GCLOUD_REQUIRE_SERVICE_ACCOUNT_KEY_ACTIVATION: "", GCLOUD_IMPERSONATE_SERVICE_ACCOUNT: "",
        GCLOUD_BIN: gcloud, GCLOUD_LOG: log, FIXTURE_DESCRIBE: state,
        SUBMIT_PROMPT_PROJECT: "fixture-project", SUBMIT_PROMPT_REGION: "fixture-region",
        SUBMIT_PROMPT_SERVICE: "fixture-submitprompt" },
    });
    return { run, log };
  }

  it("permits a missing first-deploy service in a read-only precheck", async () => {
    const { run, log } = await invokerFixture();
    expect(run(["--dry-run", "--allow-missing"], "missing").status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("services describe fixture-submitprompt");
    expect(calls).toContain("--project fixture-project");
    expect(calls).not.toContain("services update");
  });

  it("refuses missing proven post-publish services and denied prechecks", async () => {
    for (const [args, state] of [[[], "missing"], [["--dry-run", "--allow-missing"], "denied"]]) {
      const { run, log } = await invokerFixture();
      expect(run(args, state).status).toBe(1);
      expect(readFileSync(log, "utf8")).not.toContain("services update");
    }
  });

  it("never mutates on dry-run and pins authorized repair to the wrapper target", async () => {
    const first = await invokerFixture();
    expect(first.run(["--dry-run"], "present").status).toBe(0);
    expect(readFileSync(first.log, "utf8")).not.toContain("services update");
    const repair = await invokerFixture();
    expect(repair.run([], "present").status).toBe(0);
    const calls = readFileSync(repair.log, "utf8");
    expect(calls).toContain("services update fixture-submitprompt");
    expect(calls).toContain("--no-invoker-iam-check");
    expect(calls).toContain("--project fixture-project");
    expect(calls).toContain("--region fixture-region");
  });
});
