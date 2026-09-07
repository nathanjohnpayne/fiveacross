// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The conventional Firebase predeploy hook that rebuilds the loaded artifact. */
const PREDEPLOY = ['npm --prefix "$RESOURCE_DIR" run build'];

/**
 * The conventional Firebase TypeScript layout the inventory requires before it
 * will trust a parsed `src/index.ts`: `main` is the compiled `outDir/index.js`
 * and `rootDir` is `src`. Fixtures must supply it, because the CLI loads the
 * BUILT artifact and only this layout lets the source stand in for it.
 */
async function writeConventionalManifests(dir) {
  await writeFile(
    resolve(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      main: "lib/index.js",
      scripts: { build: "tsc" },
      engines: { node: "22" },
    }),
  );
  await writeFile(
    resolve(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { outDir: "lib", rootDir: "src" } }),
  );
}

function classify(args, configPath = resolve(repoRoot, "firebase.json")) {
  return classifyFirebaseDeployRequest(["fiveacross", ...args], {
    defaultConfigPath: configPath,
  });
}

/** A temp project whose Functions entrypoint is exactly `source`. */
async function withFunctionsSource(source, run) {
  const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-scope-"));
  try {
    await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
    await writeFile(
      resolve(fixture, "firebase.json"),
      JSON.stringify({ functions: { source: "functions", predeploy: PREDEPLOY } }),
    );
    await writeConventionalManifests(resolve(fixture, "functions"));
    await writeFile(
      resolve(fixture, "functions", "src", "index.ts"),
      source,
      "utf8",
    );
    await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const BUILDER_IMPORT =
  "import { onSchedule } from 'firebase-functions/v2/scheduler';";

// Every invoker the conservative fallback would otherwise switch on. Asserting
// the whole set matters: the bug this closes was one selector forcing ALL of
// them true, not just the auth-handoff one.
const NO_INVOKER_SELECTED = {
  bugReportInvokerSelected: false,
  emailUnsubscribeInvokerSelected: false,
  authHandoffInvokerSelected: false,
  eventInvitationsInvokerSelected: false,
};

const ALL_INVOKERS_CONSERVATIVE = {
  bugReportInvokerSelected: true,
  emailUnsubscribeInvokerSelected: true,
  authHandoffInvokerSelected: true,
  authHandoffInvokerConservative: true,
};

describe("exact single-endpoint scopes against the real Functions index", () => {
  it("does not select any invoker for endpoints proven to be builder calls", async () => {
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
    const result = await classify([
      "--only",
      "functions:default:dailyEngagementEmail",
    ]);
    expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
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

describe("fail-closed: shapes that must NOT be read as a single endpoint", () => {
  it("refuses a require() group, whose initializer is also a CallExpression", async () => {
    // The exact hazard: `exports.metrics = require('./metrics')` deploys as
    // `--only functions:metrics` and may contain a protected callable. It is a
    // call, so an initializer-is-a-call test alone would wrongly exempt it.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export const metrics = require('./metrics');",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:metrics"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses an object-literal group", async () => {
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "const a = 1; const b = 2;",
        "export const metrics = { a, b };",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:metrics"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a builder-shaped call whose callee is not a firebase-functions import", async () => {
    // Same syntax as a real endpoint, but `onSchedule` here is local. Trusting
    // the NAME rather than the import would exempt an arbitrary factory.
    await withFunctionsSource(
      [
        "const onSchedule = (fn) => fn;",
        "export const daily = onSchedule(() => {});",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses every name once a runtime export-star makes the inventory non-authoritative", async () => {
    // The module graph is not traversed, so the star may re-export a protected
    // callable. Even a locally-proven endpoint must fall back.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export const daily = onSchedule('every day 00:00', () => {});",
        "export * from './more.js';",
      ].join("\n"),
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
      await writeFile(
        resolve(fixture, "firebase.json"),
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

  it("exempts a proven endpoint in a clean source, so the guard is not vacuous", async () => {
    // The positive control for this whole describe block: without it, every
    // assertion above would still pass if the exemption never fired at all.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export const daily = onSchedule('every day 00:00', () => {});",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({
          functionsAttempted: true,
          ...NO_INVOKER_SELECTED,
        });
      },
    );
  });
});

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
      await writeConventionalManifests(resolve(fixture, dir));
      await writeFile(resolve(fixture, dir, "src", "index.ts"), source, "utf8");
      functions.push(
        codebase === "default"
          ? { source: dir, predeploy: PREDEPLOY }
          : { source: dir, codebase, predeploy: PREDEPLOY },
      );
    }
    await writeFile(
      resolve(fixture, "firebase.json"),
      JSON.stringify({ functions }),
    );
    await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const endpoint = (name) =>
  [BUILDER_IMPORT, `export const ${name} = onSchedule('every day 00:00', () => {});`].join("\n");

describe("codebase precedence and per-codebase keying", () => {
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
        const result = await classify(
          ["--only", "functions:submitBugReport"],
          configPath,
        );
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
    // Control: with no such codebase the same selector is still the one
    // protected endpoint, selecting only its own invoker, non-conservatively.
    await withCodebases(
      { default: endpoint("unrelated") },
      async (configPath) => {
        const result = await classify(
          ["--only", "functions:submitBugReport"],
          configPath,
        );
        expect(result).toMatchObject({
          bugReportInvokerSelected: true,
          bugReportInvokerConservative: false,
          authHandoffInvokerSelected: false,
          emailUnsubscribeInvokerSelected: false,
        });
      },
    );
  });

  it("does not let one codebase's export vouch for another codebase's selector", async () => {
    // `endpointMatchesFilter` rejects an endpoint whose codebase differs from
    // the filter's, so a union across codebases would be unsound.
    await withCodebases(
      { alpha: endpoint("alphaOnly"), beta: endpoint("betaOnly") },
      async (configPath) => {
        const result = await classify(
          ["--only", "functions:alpha:betaOnly"],
          configPath,
        );
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("exempts a codebase-qualified endpoint proven in that same codebase", async () => {
    await withCodebases(
      { alpha: endpoint("alphaOnly"), beta: endpoint("betaOnly") },
      async (configPath) => {
        const result = await classify(
          ["--only", "functions:alpha:alphaOnly"],
          configPath,
        );
        expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
      },
    );
  });

  it("refuses an unqualified name that another codebase exports as a non-endpoint", async () => {
    // Unqualified selectors match across codebases, so one codebase proving the
    // name is an endpoint is not enough while another exports it as a group.
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
      const result = await classify(
        ["--only", "functions:ghost:alphaOnly"],
        configPath,
      );
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

describe("selector resolution mirrors the pinned firebase-tools parser", () => {
  it("does not let a remoteSource codebase be read as a same-named local endpoint", async () => {
    // projectConfig accepts `remoteSource` as an alternative to `source`, and
    // such a config still carries a codebase. Dropping its NAME would let
    // codebase precedence be missed and release its whole surface — protected
    // callables included — with every invoker flag false (Codex P2, round 2).
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-remote-"));
    try {
      await mkdir(resolve(fixture, "functions-default", "src"), { recursive: true });
      await writeConventionalManifests(resolve(fixture, "functions-default"));
      await writeFile(
        resolve(fixture, "functions-default", "src", "index.ts"),
        [BUILDER_IMPORT, "export const api = onSchedule('every day 00:00', () => {});"].join("\n"),
      );
      await writeFile(
        resolve(fixture, "firebase.json"),
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
        expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
      },
    );
  });

  it("does not let one codebase's unreadable source poison a qualified proof in another", async () => {
    // endpointMatchesFilter rejects a codebase mismatch before comparing ids,
    // so uncertainty in `beta` cannot widen an explicitly qualified `alpha`.
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-authority-"));
    try {
      await mkdir(resolve(fixture, "functions-alpha", "src"), { recursive: true });
      await writeConventionalManifests(resolve(fixture, "functions-alpha"));
      await writeFile(
        resolve(fixture, "functions-alpha", "src", "index.ts"),
        endpoint("alphaOnly"),
      );
      await mkdir(resolve(fixture, "functions-beta"), { recursive: true }); // no src/index.ts
      await writeFile(
        resolve(fixture, "firebase.json"),
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
      expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("allows a hyphenated CODEBASE while still refusing a hyphenated endpoint id", async () => {
    // validateCodebase permits [a-z0-9_-]+, and the parser splits the codebase
    // off before applying idChunks, so the hyphen rule belongs to the id alone.
    await withCodebases({ "my-codebase": endpoint("daily") }, async (configPath) => {
      const ok = await classify(["--only", "functions:my-codebase:daily"], configPath);
      expect(ok).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });

      const prefixed = await classify(
        ["--only", "functions:my-codebase:daily-extra"],
        configPath,
      );
      expect(prefixed).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });
});

describe("the config must be simple enough to analyse before any proof counts", () => {
  /** A fixture with explicit control over package.json / tsconfig / firebase config. */
  async function withManifests({ pkg, tsconfig, functionsConfig }, run) {
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-manifest-"));
    try {
      await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
      await writeFile(resolve(fixture, "functions", "package.json"), JSON.stringify(pkg));
      if (tsconfig)
        await writeFile(resolve(fixture, "functions", "tsconfig.json"), JSON.stringify(tsconfig));
      await writeFile(
        resolve(fixture, "functions", "src", "index.ts"),
        endpoint("daily"),
      );
      await writeFile(
        resolve(fixture, "firebase.json"),
        JSON.stringify({
          functions: { source: "functions", predeploy: PREDEPLOY, ...functionsConfig },
        }),
      );
      await run(resolve(fixture, "firebase.json"));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }

  const CONVENTIONAL = {
    pkg: { main: "lib/index.js", scripts: { build: "tsc" }, engines: { node: "22" } },
    tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src" } },
  };

  it("refuses when package.json main is not the compiled src/index.ts", async () => {
    // The CLI loads `package.json.main || "index.js"` — the BUILT artifact. If
    // main points elsewhere, a safe-looking src/index.ts says nothing about
    // what Firebase actually deploys.
    await withManifests(
      { ...CONVENTIONAL, pkg: { main: "dist/server.js", engines: { node: "22" } } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses when tsconfig does not map src to the built output", async () => {
    await withManifests(
      { ...CONVENTIONAL, tsconfig: { compilerOptions: { outDir: "lib", rootDir: "." } } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses when the manifests are missing entirely", async () => {
    await withManifests({ pkg: {}, tsconfig: null }, async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });

  it.each([
    ["no predeploy at all", { predeploy: [] }],
    ["a predeploy that does not build", { predeploy: ['npm --prefix "$RESOURCE_DIR" run lint'] }],
  ])("refuses when the config has %s, so the loaded artifact may be stale", async (_label, functionsConfig) => {
    // The CLI loads `main` (the built artifact) and its Node delegate's own
    // build() is empty; only the predeploy hook refreshes it from src/index.ts.
    await withManifests({ ...CONVENTIONAL, functionsConfig }, async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });

  it.each([
    ["a tsc --noEmit build script", { pkg: { main: "lib/index.js", scripts: { build: "tsc --noEmit" }, engines: { node: "22" } } }],
    ["a build script that redirects the emit", { pkg: { main: "lib/index.js", scripts: { build: "tsc --outDir dist" }, engines: { node: "22" } } }],
    ["a project-mode build script", { pkg: { main: "lib/index.js", scripts: { build: "tsc -p tsconfig.build.json" }, engines: { node: "22" } } }],
    ["noEmit in tsconfig", { tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src", noEmit: true } } }],
    ["emitDeclarationOnly in tsconfig", { tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src", emitDeclarationOnly: true } } }],
    ["outFile in tsconfig", { tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src", outFile: "lib/index.js" } } }],
  ])("refuses %s, whose successful build leaves main untouched", async (_label, override) => {
    // `tsc --noEmit` exits 0 without writing, so the predeploy hook succeeds
    // while a stale lib/index.js is what Firebase loads.
    await withManifests({ ...CONVENTIONAL, ...override }, async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });

  it.each([
    ["a bare npm run build, which builds the project root", { predeploy: ["npm run build"] }],
    ["a bare tsc, which runs in the project root", { predeploy: ["tsc"] }],
    ["a --prefix pointing somewhere else", { predeploy: ['npm --prefix "$RESOURCE_DIR/../other" run build'] }],
  ])("refuses %s", async (_label, functionsConfig) => {
    // Hooks run with the project directory as cwd and see the Functions
    // directory only through $RESOURCE_DIR (lifecycleHooks.js:74-76).
    await withManifests({ ...CONVENTIONAL, functionsConfig }, async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });

  it.each([
    ['npm --prefix "$RESOURCE_DIR" run build'],
    ["npm --prefix functions run build"],
    ['cd "$RESOURCE_DIR" && npm run build'],
    ["cd functions && tsc"],
  ])("accepts the Functions-targeted hook %s", async (hook) => {
    await withManifests({ ...CONVENTIONAL, functionsConfig: { predeploy: [hook] } }, async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
    });
  });

  it.each([
    ["a files list that omits the entry point", { tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src" }, files: ["src/other.ts"] } }],
    ["an exclude", { tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src" }, include: ["src"], exclude: ["src/index.ts"] } }],
    ["an extends", { tsconfig: { extends: "./tsconfig.base.json", compilerOptions: { outDir: "lib", rootDir: "src" } } }],
    ["project references", { tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src" }, references: [{ path: "../shared" }] } }],
    ["an include narrower than src", { tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src" }, include: ["src/other.ts"] } }],
  ])("refuses a tsconfig with %s, which can leave main stale while tsc exits 0", async (_label, override) => {
    await withManifests({ ...CONVENTIONAL, ...override }, async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });

  it("accepts include: [\"src\"], the conventional whole-directory program", async () => {
    await withManifests(
      { ...CONVENTIONAL, tsconfig: { compilerOptions: { outDir: "lib", rootDir: "src" }, include: ["src"] } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
      },
    );
  });

  it("refuses when package.json has no tsc build script for the predeploy hook to run", async () => {
    await withManifests(
      { ...CONVENTIONAL, pkg: { main: "lib/index.js", engines: { node: "22" } } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a codebase configured with a prefix", async () => {
    // A `prefix` rewrites deployed ids to `<prefix>-<name>`, so an inventory of
    // raw export names no longer describes what a selector matches.
    await withManifests(
      { ...CONVENTIONAL, functionsConfig: { prefix: "daily" } },
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("accepts the conventional layout, so these preconditions are not vacuous", async () => {
    await withManifests(CONVENTIONAL, async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
    });
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

  it.each([
    ["Object.assign", "Object.assign(exports, { daily: { submitBugReport } });"],
    ["Object.defineProperty", "Object.defineProperty(exports, 'daily', { value: { submitBugReport } });"],
    ["an alias of exports", "const e = exports; e.daily = { submitBugReport };"],
    ["Reflect.set on module.exports", "Reflect.set(module.exports, 'daily', { submitBugReport });"],
  ])("refuses an indirect CommonJS export mutation via %s", async (_label, mutation) => {
    // The mutation syntaxes are open-ended, so the guard rejects any runtime
    // reference to `exports` / `module` rather than matching each shape.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "const submitBugReport = onSchedule('every day 00:00', () => {});",
        "export const daily = onSchedule('every day 00:00', () => {});",
        mutation,
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("keeps authority when module or exports appear only as property names", async () => {
    // A property key or member name is not a reference to Node's module
    // object; refusing it would re-block the unrelated endpoint this change
    // exists to exempt.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        'const metadata = { module: "engagement", exports: 3 };',
        "console.log(metadata.module, metadata.exports);",
        "export const daily = onSchedule('every day 00:00', () => {});",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
      },
    );
  });

  it.each([
    ["params.select wrapping a callable", "import { select } from 'firebase-functions/params';\nimport { onCall } from 'firebase-functions/v2/https';\nexport const daily = select([onCall(() => {})]);"],
    ["a non-builder export of an endpoint module", "import { HttpsError } from 'firebase-functions/v2/https';\nexport const daily = HttpsError('internal', 'x');"],
    ["a builder-named import from the logger module", "import { onInit } from 'firebase-functions/logger';\nexport const daily = onInit(() => {});"],
  ])("refuses %s, since only onX factories from endpoint modules build endpoints", async (_label, source) => {
    await withFunctionsSource(source, async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });

  it("refuses when a CommonJS assignment can overwrite a proven export", async () => {
    // TypeScript preserves the reassignment in its emit, and the runtime loader
    // recursively deploys the final object as a group.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export const daily = onSchedule('every day 00:00', () => {});",
        "exports.daily = require('./group');",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });
});

describe("narrowing that removes whole classes rather than modelling them", () => {
  async function withRuntimeConfig(extraConfig, source, run) {
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-runtime-"));
    try {
      await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
      await writeConventionalManifests(resolve(fixture, "functions"));
      await writeFile(resolve(fixture, "functions", "src", "index.ts"), source, "utf8");
      await writeFile(
        resolve(fixture, "firebase.json"),
        JSON.stringify({
          functions: { source: "functions", predeploy: PREDEPLOY, ...extraConfig },
        }),
      );
      await run(resolve(fixture, "firebase.json"));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }

  it("refuses a non-Node runtime even when decoy TypeScript is present", async () => {
    // The CLI picks its runtime delegate from the configured runtime, so a
    // python codebase's endpoints come from source this parser never reads.
    await withRuntimeConfig({ runtime: "python311" }, endpoint("daily"), async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
    });
  });

  it("accepts an explicitly declared Node runtime", async () => {
    await withRuntimeConfig({ runtime: "nodejs22" }, endpoint("daily"), async (configPath) => {
      const result = await classify(["--only", "functions:daily"], configPath);
      expect(result).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
    });
  });

  it("refuses a package.json with no declared node engine", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "single-endpoint-engine-"));
    try {
      await mkdir(resolve(fixture, "functions", "src"), { recursive: true });
      await writeFile(
        resolve(fixture, "functions", "package.json"),
        JSON.stringify({ main: "lib/index.js" }), // no engines
      );
      await writeFile(
        resolve(fixture, "functions", "tsconfig.json"),
        JSON.stringify({ compilerOptions: { outDir: "lib", rootDir: "src" } }),
      );
      await writeFile(
        resolve(fixture, "functions", "src", "index.ts"),
        endpoint("daily"),
      );
      await writeFile(
        resolve(fixture, "firebase.json"),
        JSON.stringify({ functions: { source: "functions", predeploy: PREDEPLOY } }),
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

  it("refuses a reassignable `export let` binding", async () => {
    // `export let daily = onSchedule(...); daily = { submitBugReport };`
    // rebinds the export with no `exports.` text for the mutation guard to see.
    // Requiring `const` removes the class instead of hunting for assignments.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export let daily = onSchedule('every day 00:00', () => {});",
        "daily = { submitBugReport: 1 };",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("treats a non-const exported name as exported-but-unproven, so it vetoes", async () => {
    // It must not merely fail to support the proof — an unqualified selector
    // has to see it as a name this parser cannot vouch for.
    await withFunctionsSource(
      [BUILDER_IMPORT, "export let daily = onSchedule('every day 00:00', () => {});"].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });
});

describe("module-level replacement and prefix-colliding export ids", () => {
  it("refuses whole-object module.exports replacement", async () => {
    // Member mutation was already caught; wholesale replacement was not.
    // `module.exports = { daily: { submitBugReport } }` replaces the module and
    // the loader discovers `daily-submitBugReport`.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export const daily = onSchedule('every day 00:00', () => {});",
        "module.exports = { daily: { submitBugReport: 1 } };",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a string-named export whose id shares a proven endpoint's prefix", async () => {
    // The CLI matches `id === prefix || id.startsWith(prefix + "-")`, so
    // `daily-submitBugReport` is inside `--only functions:daily`.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "const report = 1;",
        "export const daily = onSchedule('every day 00:00', () => {});",
        'export { report as "daily-submitBugReport" };',
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a namespace re-export, whose members this parser cannot enumerate", async () => {
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "export const daily = onSchedule('every day 00:00', () => {});",
        "export * as group from './group.js';",
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("records a plain named re-export as exported-but-unproven, so it vetoes", async () => {
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "const other = 1;",
        "export const daily = onSchedule('every day 00:00', () => {});",
        "export { other as somethingElse };",
      ].join("\n"),
      async (configPath) => {
        // `daily` is still provable — the re-export neither proves nor
        // collides with it, so this must NOT become conservative.
        const ok = await classify(["--only", "functions:daily"], configPath);
        expect(ok).toMatchObject({ ...NO_INVOKER_SELECTED, functionsAttempted: true });
        // ...but the re-exported name itself is unproven and must veto.
        const vetoed = await classify(["--only", "functions:somethingElse"], configPath);
        expect(vetoed).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });

  it("refuses a string-named export even without a hyphen, since its id is unpinnable", async () => {
    // Discriminates the string-literal guard from the hyphen guard: with no
    // hyphen the prefix rule is not what saves us, so removing the
    // `isIdentifier` check must break this and only this.
    await withFunctionsSource(
      [
        BUILDER_IMPORT,
        "const report = 1;",
        "export const daily = onSchedule('every day 00:00', () => {});",
        'export { report as "weird name" };',
      ].join("\n"),
      async (configPath) => {
        const result = await classify(["--only", "functions:daily"], configPath);
        expect(result).toMatchObject(ALL_INVOKERS_CONSERVATIVE);
      },
    );
  });
});
