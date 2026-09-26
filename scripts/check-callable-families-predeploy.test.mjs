// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBuiltArtifact, codebasePrefixes, httpsEndpointIds, prefixedEndpointIds } from "./check-callable-families-predeploy.mjs";
import { CALLABLE_INVOKER_FAMILIES, httpsFunctionExports, unfamiliedHttpsNames } from "./callable-invoker-families.mjs";

// The guard reads a BUILT artifact through the discovery `firebase deploy`
// runs, so every fixture here is a real (tiny) Functions codebase: this
// repository's own `functions/node_modules` symlinked in (the real SDK and its
// `firebase-functions` discovery binary, and `tsc`), and an artifact that is
// either written as the CommonJS `tsc` emits or built by the real `tsc`.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_MODULES = join(repoRoot, "functions", "node_modules");
const SCRIPT = join(repoRoot, "scripts", "check-callable-families-predeploy.mjs");
const PROJECT = "fiveacross";
const BUILDS = { timeout: 120_000 };
const fixtures = [];

beforeAll(async () => {
  // As the classifier suite does it: `npm test` can run before anything has
  // installed the Functions dependencies, and this is the same install.
  if (existsSync(SHARED_MODULES)) return;
  await run("npm", ["--prefix", "functions", "install", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: repoRoot });
}, 300_000);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function run(command, args, options = {}) {
  return new Promise((settle, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("exit", (code) => settle({ code, stdout, stderr }));
  });
}

/** A project root with one Functions codebase at `functions/`, the toolchain linked in. */
async function codebase(files) {
  const root = await mkdtemp(join(tmpdir(), "callable-families-predeploy-"));
  fixtures.push(root);
  const functionsDir = join(root, "functions");
  await mkdir(join(functionsDir, "node_modules"), { recursive: true });
  for (const entry of await readdir(SHARED_MODULES)) {
    await symlink(join(SHARED_MODULES, entry), join(functionsDir, "node_modules", entry));
  }
  const all = {
    "package.json": JSON.stringify({ name: "fixture-functions", private: true, main: "lib/index.js", engines: { node: "22" } }),
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    await mkdir(dirname(join(functionsDir, name)), { recursive: true });
    await writeFile(join(functionsDir, name), text);
  }
  return { root, functionsDir };
}

const check = ({ root, functionsDir }) => checkBuiltArtifact({ sourceDir: functionsDir, projectDir: root, projectId: PROJECT });

const cjs = (...lines) => ['"use strict";', 'const { onCall, onRequest } = require("firebase-functions/v2/https");', ...lines].join("\n");

describe("the Functions predeploy export guard (#1283)", () => {
  it("passes this repository's real Functions codebase, built by its own build script", BUILDS, async () => {
    const root = await mkdtemp(join(tmpdir(), "callable-families-predeploy-real-"));
    fixtures.push(root);
    const functionsDir = join(root, "functions");
    await mkdir(functionsDir);
    for (const name of ["src", "package.json", "tsconfig.json"]) {
      await cp(join(repoRoot, "functions", name), join(functionsDir, name), { recursive: true });
    }
    await symlink(SHARED_MODULES, join(functionsDir, "node_modules"), "junction");
    // The Functions source imports shared types from the app (`../../src/domainTypes`).
    await symlink(join(repoRoot, "src"), join(root, "src"), "junction");
    // The real firebase.json, so the ids are checked with its codebase prefixes.
    await cp(join(repoRoot, "firebase.json"), join(root, "firebase.json"));
    const build = await run("npm", ["--prefix", functionsDir, "run", "build"], { cwd: root });
    expect(build.code, build.stdout + build.stderr).toBe(0);

    const verdict = await checkBuiltArtifact({ sourceDir: functionsDir, projectDir: root, projectId: PROJECT });
    expect(verdict, verdict.message).toMatchObject({ ok: true });
    // Positive control: the discovery really found the HTTPS endpoints.
    expect(verdict.message).toMatch(/\(\d+ checked\)/);
    expect(Number(verdict.message.match(/\((\d+) checked\)/)[1])).toBeGreaterThanOrEqual(5);
  });

  it("refuses an onCall endpoint in the built artifact that belongs to no family, naming it", BUILDS, async () => {
    const fixture = await codebase({
      "lib/index.js": cjs(
        "exports.unlockDayNow = onCall(async () => ({ ok: true }));",
        "exports.brandNewCallable = onCall(async () => 1);",
      ),
    });
    const verdict = await check(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/deploys brandNewCallable, an onCall\/onRequest endpoint that belongs to no Cloud Run invoker family/);
    expect(verdict.message).not.toMatch(/unlockDayNow/);
  });

  it("names an unfamilied onRequest inside an exported group by the id Firebase deploys", BUILDS, async () => {
    const fixture = await codebase({
      "lib/index.js": cjs(
        "exports.emailUnsubscribe = onRequest((req, res) => res.end());",
        "exports.admin = { hidden: onRequest((req, res) => res.end()), nested: { deeper: onCall(async () => 1) } };",
      ),
    });
    const verdict = await check(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/deploys admin-hidden, admin-nested-deeper, an onCall/);
  });

  it("catches the forms the advisory syntax scan cannot see, from the artifact the real tsc builds", BUILDS, async () => {
    const fixture = await codebase({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "commonjs", target: "es2021", outDir: "lib", rootDir: "src", esModuleInterop: true, skipLibCheck: true },
        include: ["src"],
      }),
      // #1283: a binding declared without an initializer and assigned later.
      "src/index.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => ({ ok: true }));",
        "let endpoint;",
        "endpoint = onCall(async () => 1);",
        "export { endpoint };",
        "export * from './more';",
      ].join("\n"),
      // Deferred from #1301: a destructured binding exported in a later clause,
      // reached through a local star.
      "src/more.ts": [
        "import { onCall } from 'firebase-functions/v2/https';",
        "const { destructured } = { destructured: onCall(async () => 1) };",
        "export { destructured };",
      ].join("\n"),
    });
    const build = await run(join(fixture.functionsDir, "node_modules", ".bin", "tsc"), [], { cwd: fixture.functionsDir });
    expect(build.code, build.stdout + build.stderr).toBe(0);
    // The blind spot this guard exists for: the scan sees neither endpoint.
    const scanned = [...httpsFunctionExports(join(fixture.functionsDir, "src", "index.ts"))];
    expect(scanned).toEqual(["unlockDayNow"]);

    const verdict = await check(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/deploys destructured, endpoint, an onCall/);
  });

  it("checks the prefixed id the deploy publishes when the codebase sets a prefix (#1328)", BUILDS, async () => {
    // prepare.js renames every endpoint `<prefix>-<id>` after discovery, so a
    // familied export name deploys as an id no invoker family reconciles.
    const fixture = await codebase({ "lib/index.js": cjs("exports.unlockDayNow = onCall(async () => 1);") });
    await writeFile(join(fixture.root, "firebase.json"), JSON.stringify({ functions: { source: "functions", prefix: "admin" } }));
    const verdict = await check(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/deploys admin-unlockDayNow, an onCall/);

    // Control: the same artifact with no prefix passes.
    await writeFile(join(fixture.root, "firebase.json"), JSON.stringify({ functions: { source: "functions" } }));
    expect(await check(fixture)).toMatchObject({ ok: true });
  });

  it("refuses, rather than reads as unprefixed, a firebase.json whose Functions config it cannot read (#1328)", BUILDS, async () => {
    const fixture = await codebase({ "lib/index.js": cjs("exports.unlockDayNow = onCall(async () => 1);") });
    await writeFile(join(fixture.root, "firebase.json"), JSON.stringify({ functions: "missing.config.json" }));
    const verdict = await check(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/could not discover what the built Functions artifact .* deploys — .*missing\.config\.json/);
  });

  it("counts only HTTPS and callable triggers", BUILDS, async () => {
    const fixture = await codebase({
      "lib/index.js": [
        '"use strict";',
        'const { onCall } = require("firebase-functions/v2/https");',
        'const { onSchedule } = require("firebase-functions/v2/scheduler");',
        'const { onDocumentCreated } = require("firebase-functions/v2/firestore");',
        "exports.submitBugReport = onCall(async () => 1);",
        "exports.nightly = onSchedule('every day 00:00', async () => {});",
        "exports.onThing = onDocumentCreated('things/{id}', async () => {});",
      ].join("\n"),
    });
    expect(await check(fixture)).toMatchObject({ ok: true });
  });

  it("reads a committed functions.yaml instead of the artifact, as the deploy does", BUILDS, async () => {
    const fixture = await codebase({
      "lib/index.js": cjs("exports.unlockDayNow = onCall(async () => 1);"),
      "functions.yaml": [
        "specVersion: v1alpha1",
        "endpoints:",
        "  manifestOnly:",
        "    platform: gcfv2",
        "    entryPoint: manifestOnly",
        "    httpsTrigger: {}",
      ].join("\n"),
    });
    const verdict = await check(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/deploys manifestOnly, an onCall/);
  });

  it("fails closed when the discovery cannot load the artifact", BUILDS, async () => {
    const fixture = await codebase({ "lib/index.js": 'throw new Error("boom at module load");\n' });
    const verdict = await check(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/could not discover what the built Functions artifact .* deploys/);
  });

  it("runs as the hook: exits 1 naming the endpoint, and promptly, without waiting on the discovery kill timer", BUILDS, async () => {
    const fixture = await codebase({ "lib/index.js": cjs("exports.brandNewCallable = onCall(async () => 1);") });
    const started = Date.now();
    const result = await run(process.execPath, [SCRIPT, fixture.functionsDir], {
      cwd: fixture.root,
      env: { ...process.env, GCLOUD_PROJECT: PROJECT, PROJECT_DIR: fixture.root },
    });
    const elapsed = Date.now() - started;
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unreconciled HTTPS Function: .*deploys brandNewCallable/);
    // firebase-tools arms a ten-second SIGKILL timer when it tears discovery
    // down; the hook exits on its verdict rather than holding every deploy open.
    expect(elapsed).toBeLessThan(9_000);
  });

  it("runs as the hook when reached through a symlinked scripts/ directory", BUILDS, async () => {
    // The classifier's staged project links `scripts/` back to the checkout, so
    // `node scripts/…` there names a path whose real path differs. A module
    // check by URL alone would load the file, skip the guard and exit 0.
    const fixture = await codebase({ "lib/index.js": cjs("exports.brandNewCallable = onCall(async () => 1);") });
    await symlink(join(repoRoot, "scripts"), join(fixture.root, "scripts"), "junction");
    const result = await run(process.execPath, ["scripts/check-callable-families-predeploy.mjs", fixture.functionsDir], {
      cwd: fixture.root,
      env: { ...process.env, GCLOUD_PROJECT: PROJECT, PROJECT_DIR: fixture.root },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/deploys brandNewCallable/);
  });

  it("runs as the hook: exits 0 on a familied artifact and refuses without GCLOUD_PROJECT", BUILDS, async () => {
    const fixture = await codebase({ "lib/index.js": cjs("exports.unlockDayNow = onCall(async () => 1);") });
    const passed = await run(process.execPath, [SCRIPT, fixture.functionsDir], {
      cwd: fixture.root,
      env: { ...process.env, GCLOUD_PROJECT: PROJECT, PROJECT_DIR: fixture.root },
    });
    expect(passed.code, passed.stderr).toBe(0);
    expect(passed.stdout).toMatch(/every HTTPS endpoint in the built Functions artifact belongs to an invoker family \(1 checked\)/);

    const env = { ...process.env };
    delete env.GCLOUD_PROJECT;
    const refused = await run(process.execPath, [SCRIPT, fixture.functionsDir], { cwd: fixture.root, env });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/run it as a Functions predeploy hook/);
  });

  it("is wired into firebase.json's Functions predeploy chain after the build", () => {
    const { functions } = JSON.parse(readFileSync(join(repoRoot, "firebase.json"), "utf8"));
    const hooks = functions.predeploy;
    const build = hooks.indexOf('npm --prefix "$RESOURCE_DIR" run build');
    const guard = hooks.indexOf('node scripts/check-callable-families-predeploy.mjs "$RESOURCE_DIR"');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(build);
    // firebase-tools' cross-env-shell silently drops a hook whose text carries
    // `NAME=`, so the guard must never grow one.
    for (const hook of hooks) expect(hook).not.toMatch(/\w+=/);
  });
});

describe("codebasePrefixes / prefixedEndpointIds (#1328)", () => {
  it("reads every prefix firebase.json gives the source directory, as prepare.js applies them", async () => {
    const root = await mkdtemp(join(tmpdir(), "callable-families-prefixes-"));
    fixtures.push(root);
    const sourceDir = join(root, "functions");
    // No firebase.json: unprefixed.
    expect(codebasePrefixes({ sourceDir, projectDir: root })).toEqual([""]);
    await writeFile(
      join(root, "firebase.json"),
      JSON.stringify({
        functions: [
          { source: "functions", codebase: "default" },
          { source: "functions", codebase: "beta", prefix: "beta" },
          { source: "other", codebase: "other", prefix: "other" },
          { kit: "sample", source: "functions", instances: { one: "config/one" } },
        ],
      }),
    );
    expect(codebasePrefixes({ sourceDir, projectDir: root }).sort()).toEqual(["", "beta", "kit-one"]);
    // A source directory no config names is unprefixed.
    expect(codebasePrefixes({ sourceDir: join(root, "elsewhere"), projectDir: root })).toEqual([""]);
    // A config with no source deploys the CLI default functions/.
    await writeFile(join(root, "firebase.json"), JSON.stringify({ functions: { prefix: "solo" } }));
    expect(codebasePrefixes({ sourceDir, projectDir: root })).toEqual(["solo"]);
    // An import-path `functions` key is materialized from the file it names, as
    // the deploy's own Config does (Codex P2 / CodeRabbit P1 on #1328).
    await writeFile(join(root, "functions.config.json"), JSON.stringify({ source: "functions", prefix: "imported" }));
    await writeFile(join(root, "firebase.json"), JSON.stringify({ functions: "functions.config.json" }));
    expect(codebasePrefixes({ sourceDir, projectDir: root })).toEqual(["imported"]);
    // Fail closed: an import that is missing, and shapes the guard does not
    // recognise, throw rather than read as unprefixed.
    for (const functions of ["missing.json", [42], [{ source: "functions", prefix: 7 }], [{ source: ["functions"] }]]) {
      await writeFile(join(root, "firebase.json"), JSON.stringify({ functions }));
      expect(() => codebasePrefixes({ sourceDir, projectDir: root }), JSON.stringify(functions)).toThrow();
    }

    expect(prefixedEndpointIds(["b", "a"], ["", "beta"])).toEqual(["a", "b", "beta-a", "beta-b"]);
  });
});

describe("httpsEndpointIds / unfamiliedHttpsNames", () => {
  it("selects httpsTrigger and callableTrigger endpoints only, and filters the families", () => {
    const ids = httpsEndpointIds({
      endpoints: {
        b: { httpsTrigger: {} },
        a: { callableTrigger: {} },
        c: { scheduleTrigger: { schedule: "every day 00:00" } },
        d: { eventTrigger: { eventType: "x" } },
        e: { taskQueueTrigger: {} },
      },
    });
    expect(ids).toEqual(["a", "b"]);
    const familied = CALLABLE_INVOKER_FAMILIES[0].exports[0];
    expect(unfamiliedHttpsNames(["zeta", familied, "alpha"])).toEqual(["alpha", "zeta"]);
  });
});
