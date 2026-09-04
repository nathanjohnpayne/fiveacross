// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
      JSON.stringify({ functions: { source: "functions" } }),
    );
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
        JSON.stringify({ functions: { source: "functions" } }),
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
      await writeFile(resolve(fixture, dir, "src", "index.ts"), source, "utf8");
      functions.push(
        codebase === "default" ? { source: dir } : { source: dir, codebase },
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
