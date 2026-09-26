// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALLABLE_INVOKER_FAMILIES,
  httpsFunctionExports,
  unfamiliedHttpsExports,
} from "./callable-invoker-families.mjs";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

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
