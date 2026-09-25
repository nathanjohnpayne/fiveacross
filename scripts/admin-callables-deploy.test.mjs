// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A Node Functions source: `src/` plus the `package.json` whose presence makes
// the CLI pick the Node runtime, with the conventional `lib/index.js` entry.
async function nodeSource(dir) {
  await mkdir(resolve(dir, "src"), { recursive: true });
  await writeFile(resolve(dir, "package.json"), JSON.stringify({ main: "lib/index.js" }));
}

async function classify(args) {
  return classifyFirebaseDeployRequest(["fiveacross", ...args], {
    defaultConfigPath: resolve(repoRoot, "firebase.json"),
  });
}

async function withIndex(lines, run) {
  const fixture = await mkdtemp(join(tmpdir(), "admin-callable-exports-"));
  try {
    await nodeSource(resolve(fixture, "functions"));
    await writeFile(
      resolve(fixture, "firebase.json"),
      JSON.stringify({ functions: { source: "functions" } }),
    );
    await writeFile(resolve(fixture, "functions", "src", "index.ts"), lines.join("\n"));
    return await run(resolve(fixture, "firebase.json"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

describe("admin-callables deploy scope across Functions codebases (#1282)", () => {
  // Only the non-default `ops` codebase exports a protected callable.
  async function withTwoCodebases(run) {
    const fixture = await mkdtemp(join(tmpdir(), "admin-callable-codebases-"));
    try {
      await nodeSource(resolve(fixture, "functions"));
      await nodeSource(resolve(fixture, "ops"));
      await writeFile(
        resolve(fixture, "firebase.json"),
        JSON.stringify({ functions: [{ source: "functions" }, { source: "ops", codebase: "ops" }] }),
      );
      await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
      await writeFile(
        resolve(fixture, "ops", "src", "index.ts"),
        "import { onCall } from 'firebase-functions/v2/https';\nexport const unlockDayNow = onCall(async () => 1);\n",
      );
      return await run(resolve(fixture, "firebase.json"));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }

  // [args, selected, conservative, strict]. A selected family with nothing
  // strict is an allow-missing probe, the only empty form deploy.sh accepts.
  it.each([
    [[], true, false, "unlock"],
    [["--only", "functions"], true, false, "unlock"],
    [["--only", "functions:default"], false, false, ""],
    [["--only", "functions:default:unlockDayNow"], true, true, ""],
    [["--only", "functions:ops"], true, false, "unlock"],
    [["--only", "functions:unlockDayNow"], true, true, ""],
    [["--only", "functions:ops:unlockDayNow"], true, false, "unlock"],
    [["--only", "functions:ops:approvePrompts"], true, true, ""],
  ])("marks strict only what the selected codebase exports (%j)", async (args, selected, conservative, strict) => {
    const result = await withTwoCodebases((configPath) =>
      classifyFirebaseDeployRequest(["fiveacross", ...args], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      functionsAttempted: true,
      adminCallablesInvokerSelected: selected,
      adminCallablesInvokerConservative: conservative,
      adminCallablesStrictServices: strict,
    });
  });

  // A codebase with no `src/index.ts` (a JavaScript or Python codebase) has an
  // unknown surface, not an empty one, so its scope stays conservative.
  // A codebase with no `src/index.ts` (a JavaScript or Python codebase) has an
  // unknown surface, not an empty one, so a selector that releases it keeps
  // each family it might carry selected with every service allowed absent.
  async function withUnindexedCodebase(layout, run) {
    const fixture = await mkdtemp(join(tmpdir(), "admin-callable-no-index-"));
    const callable = "export const unlockDayNow = onCall(async () => 1);\n";
    const header = "import { onCall } from 'firebase-functions/v2/https';\n";
    try {
      await nodeSource(resolve(fixture, "functions"));
      await mkdir(resolve(fixture, "py"), { recursive: true });
      if (layout === "ts-default-and-remote") {
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({
            functions: [
              { source: "functions" },
              { remoteSource: { repository: "https://github.com/example/ops", ref: "main" }, codebase: "remote", runtime: "nodejs22" },
            ],
          }),
        );
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
      } else if (layout === "ts-default-and-kit") {
        await nodeSource(resolve(fixture, "kit"));
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({ functions: [{ source: "functions" }, { kit: "example-kit", source: "kit", instances: { daily: "kit" } }] }),
        );
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
        await writeFile(resolve(fixture, "kit", "src", "index.ts"), header + callable);
      } else if (layout === "ts-default-and-python-ops") {
        await nodeSource(resolve(fixture, "ops"));
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({
            functions: [{ source: "functions" }, { source: "ops", codebase: "ops", runtime: "python311" }],
          }),
        );
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
        await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export const unrelated = 1;\n");
        await writeFile(resolve(fixture, "ops", "main.py"), "# unlock_day_now is exported as unlockDayNow\n");
      } else if (layout === "ts-default-and-generated-ops" || layout === "ts-default-and-missing-ops") {
        // A source directory a predeploy hook generates does not exist yet;
        // with no hook, a missing directory has nothing to publish.
        const hook = layout === "ts-default-and-generated-ops" ? { predeploy: ["node generate-ops.js"] } : {};
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({ functions: [{ source: "functions" }, { source: "generated-ops", codebase: "ops", ...hook }] }),
        );
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
      } else if (layout === "ts-default-and-bracket-module-ops") {
        await nodeSource(resolve(fixture, "ops"));
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({ functions: [{ source: "functions" }, { source: "ops", codebase: "ops" }] }),
        );
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
        await writeFile(
          resolve(fixture, "ops", "src", "index.ts"),
          header + 'module["exports"].unlockDayNow = onCall(async () => 1);\n',
        );
      } else if (layout === "ts-default-and-export-equals-ops") {
        await nodeSource(resolve(fixture, "ops"));
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({ functions: [{ source: "functions" }, { source: "ops", codebase: "ops" }] }),
        );
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
        await writeFile(
          resolve(fixture, "ops", "src", "index.ts"),
          header + "const unlockDayNow = onCall(async () => 1);\nexport = { unlockDayNow };\n",
        );
      } else if (layout === "inline-config-unlock-codebase" || layout === "imported-config-unlock-codebase") {
        // A codebase named like a protected callable, configured inline or
        // through an imported functions config the CLI materialises.
        await nodeSource(resolve(fixture, "ops"));
        const functions = [{ source: "functions" }, { source: "ops", codebase: "unlockDayNow" }];
        if (layout === "imported-config-unlock-codebase") {
          await writeFile(resolve(fixture, "functions.config.json"), JSON.stringify(functions));
          await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions: "functions.config.json" }));
        } else {
          await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions }));
        }
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
        await writeFile(
          resolve(fixture, "ops", "src", "index.ts"),
          header + "export const mintEventInvitation = onCall(async () => 1);\n",
        );
      } else if (layout.startsWith("ops-variant-")) {
        // One non-default TypeScript codebase exporting `unlockDayNow`, made
        // opaque by a single variant.
        const variant = layout.slice("ops-variant-".length);
        await nodeSource(resolve(fixture, "ops"));
        const ops = { source: "ops", codebase: "ops", ...(variant === "prefix" ? { prefix: "tenant" } : {}) };
        await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions: [{ source: "functions" }, ops] }));
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
        if (variant === "main") {
          await writeFile(resolve(fixture, "ops", "package.json"), JSON.stringify({ main: "lib/main.js" }));
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export const unrelated = 1;\n");
        } else if (variant === "top-level-this") {
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + "(this as any).unlockDayNow = onCall(async () => 1);\n",
          );
        } else if (variant === "heritage-this") {
          // A class heritage expression sees the top-level `this`, not the class's.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + "class Holder extends ((this as any).unlockDayNow = onCall(async () => 1), Object) {}\n",
          );
        } else if (variant === "computed-name-this") {
          // So does a computed member name, even on a method that binds its own.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + "class Holder { [((this as any).unlockDayNow = onCall(async () => 1), \"k\")]() { return 1; } }\n",
          );
        } else if (variant === "computed-field-this") {
          // And a computed field name, whose member does not bind `this` itself.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + "class Holder { [((this as any).unlockDayNow = onCall(async () => 1), \"k\")] = 1; }\n",
          );
        } else if (variant === "decorator-this") {
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + "const mark = (..._: unknown[]) => undefined;\n" +
              "class Holder { @mark(((this as any).unlockDayNow = onCall(async () => 1))) run() { return 1; } }\n",
          );
        } else if (variant === "star-commonjs") {
          // A local star copies whatever a CommonJS mutation put on the module's exports.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header + "exports.unlockDayNow = onCall(async () => 1);\n",
          );
        } else if (variant === "star-star-commonjs") {
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './group';\n");
          await writeFile(resolve(fixture, "ops", "src", "group.ts"), "export * from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header + "Object.assign(exports, { unlockDayNow: onCall(async () => 1) });\n",
          );
        } else if (variant === "star-named-hop") {
          // A named re-export behind a star carries a name out of an opaque module.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './middle';\n");
          await writeFile(resolve(fixture, "ops", "src", "middle.ts"), "export { unlockDayNow } from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header +
              "namespace inner { export const unlockDayNow = onCall(async () => 1); }\nexport import unlockDayNow = inner.unlockDayNow;\n",
          );
        } else if (variant === "python-inferred") {
          // No `runtime` and no `package.json`: the CLI infers Python from
          // `requirements.txt`, whatever TypeScript the directory also carries.
          await rm(resolve(fixture, "ops", "package.json"));
          await writeFile(resolve(fixture, "ops", "requirements.txt"), "firebase-functions\n");
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export const unrelated = 1;\n");
        } else if (variant === "star-later-assignment") {
          // A binding assigned after its export declaration is still exported by name.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header + "export let unlockDayNow: unknown;\nunlockDayNow = onCall(async () => 1);\n",
          );
        } else if (variant === "star-destructured-clause") {
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header + "const { unlockDayNow } = { unlockDayNow: onCall(async () => 1) };\nexport { unlockDayNow };\n",
          );
        } else if (variant === "star-package-named") {
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(resolve(fixture, "ops", "src", "admin.ts"), "export { unlockDayNow } from 'my-admin-callables';\n");
        } else if (variant === "star-default-function") {
          // `export default function approvePrompts` exports `default`, which a star skips.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header + callable + "export default function approvePrompts() { return 1; }\n",
          );
        } else if (variant === "star-declare") {
          // An ambient `export declare` is erased and publishes nothing.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header + callable + "export declare const approvePrompts: unknown;\n",
          );
        } else if (variant === "star-declared") {
          // A star of a module the walk models stays inventoried.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(resolve(fixture, "ops", "src", "admin.ts"), header + callable);
        } else if (variant === "star-interface-clause") {
          // `export { name }` of a local interface is erased and publishes nothing.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header + callable + "interface approvePrompts { value: string }\nexport { approvePrompts };\n",
          );
        } else if (variant === "interface-clause") {
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + callable + "type approvePrompts = { value: string };\nexport { approvePrompts };\n",
          );
        } else if (variant === "ambient-clause") {
          // An ambient binding is at most an `undefined` property, not an endpoint.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + callable + "declare const approvePrompts: unknown;\nexport { approvePrompts };\n",
          );
        } else if (variant === "star-ambient-clause") {
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            header + callable + "declare function approvePrompts(): void;\nexport { approvePrompts };\n",
          );
        } else if (variant === "type-reexport" || variant === "star-type-reexport") {
          // A named re-export of an interface is erased and emits no property.
          const module = header + callable + "export { AdminCallable as approvePrompts } from './types';\n";
          if (variant === "star-type-reexport") {
            await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export * from './admin';\n");
            await writeFile(resolve(fixture, "ops", "src", "admin.ts"), module);
          } else {
            await writeFile(resolve(fixture, "ops", "src", "index.ts"), module);
          }
          await writeFile(resolve(fixture, "ops", "src", "types.ts"), "export interface AdminCallable { value: string }\n");
        } else if (variant === "star-hop-type-reexport") {
          // The re-exported name reaches an interface through a local star.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + callable + "export { AdminCallable as approvePrompts } from './middle';\n",
          );
          await writeFile(resolve(fixture, "ops", "src", "middle.ts"), "export * from './types';\n");
          await writeFile(resolve(fixture, "ops", "src", "types.ts"), "export interface AdminCallable { value: string }\n");
        } else if (variant === "merged-type-value-reexport") {
          // A type and a value exported under one name emit the value.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), "export { Foo as unlockDayNow } from './admin';\n");
          await writeFile(
            resolve(fixture, "ops", "src", "admin.ts"),
            "export interface Foo { value: string }\nexport { callable as Foo } from './callable';\n",
          );
          await writeFile(resolve(fixture, "ops", "src", "callable.ts"), header + "export const callable = onCall(async () => 1);\n");
        } else if (variant === "default-type-import" || variant === "named-type-import" || variant === "default-type-reexport") {
          // An imported type re-exported under a callable's name is erased.
          const statements = {
            "default-type-import": "import AdminCallable from './types';\nexport { AdminCallable as approvePrompts };\n",
            "named-type-import": "import { AdminCallable } from './types';\nexport { AdminCallable as approvePrompts };\n",
            "default-type-reexport": "export { default as approvePrompts } from './types';\n",
          }[variant];
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), header + callable + statements);
          await writeFile(
            resolve(fixture, "ops", "src", "types.ts"),
            variant === "named-type-import"
              ? "export interface AdminCallable { value: string }\n"
              : "export default interface AdminCallable { value: string }\n",
          );
        } else if (variant === "merged-import-value") {
          // A local value merged with an imported interface is what the export emits.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header +
              callable +
              "import { AdminCallable } from './types';\nconst AdminCallable = onCall(async () => 1);\nexport { AdminCallable as approvePrompts };\n",
          );
          await writeFile(resolve(fixture, "ops", "src", "types.ts"), "export interface AdminCallable { value: string }\n");
        } else if (variant === "cyclic-type-reexport") {
          // A re-export cycle through stars ends; the name is not proven type-only.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + callable + "export { T as approvePrompts } from './a';\n",
          );
          await writeFile(resolve(fixture, "ops", "src", "a.ts"), "export * from './b';\n");
          await writeFile(resolve(fixture, "ops", "src", "b.ts"), "export interface T { value: string }\nexport * from './c';\n");
          await writeFile(resolve(fixture, "ops", "src", "c.ts"), "export { T } from './a';\n");
        } else if (variant === "default-value-import") {
          // A default-imported value re-exported under a callable's name stays a value.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + callable + "import approve from './approve';\nexport { approve as approvePrompts };\n",
          );
          await writeFile(resolve(fixture, "ops", "src", "approve.ts"), header + "export default onCall(async () => 1);\n");
        } else if (variant === "value-reexport") {
          // A named re-export of a local value stays a value.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + callable + "export { approve as approvePrompts } from './approve';\n",
          );
          await writeFile(resolve(fixture, "ops", "src", "approve.ts"), header + "export const approve = onCall(async () => 1);\n");
        } else if (variant === "interface-merged-value") {
          // A value merged with a same-named interface is still exported.
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header +
              callable +
              "const approvePrompts = onCall(async () => 1);\ninterface approvePrompts { value: string }\nexport { approvePrompts };\n",
          );
        } else if (variant === "functions-yaml") {
          // A discovery manifest decides the surface before the index loads.
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), header + callable);
          await writeFile(resolve(fixture, "ops", "functions.yaml"), "endpoints: {}\n");
        } else if (variant === "import-alias") {
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header +
              "namespace admin { export const unlockDayNow = onCall(async () => 1); }\nexport import unlockDayNow = admin.unlockDayNow;\n",
          );
        } else if (variant === "binding") {
          await writeFile(
            resolve(fixture, "ops", "src", "index.ts"),
            header + "export const { unlockDayNow } = { unlockDayNow: onCall(async () => 1) };\n",
          );
        } else {
          await writeFile(resolve(fixture, "ops", "src", "index.ts"), header + callable);
        }
      } else if (layout === "ts-default-and-object-assign-ops") {
        await nodeSource(resolve(fixture, "ops"));
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({ functions: [{ source: "functions" }, { source: "ops", codebase: "ops" }] }),
        );
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
        await writeFile(
          resolve(fixture, "ops", "src", "index.ts"),
          header + "const unlockDayNow = onCall(async () => 1);\nObject.assign(exports, { unlockDayNow });\n",
        );
      } else if (layout === "ts-default-and-commonjs-ops") {
        await nodeSource(resolve(fixture, "ops"));
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({ functions: [{ source: "functions" }, { source: "ops", codebase: "ops" }] }),
        );
        await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export const unrelated = 1;\n");
        await writeFile(
          resolve(fixture, "ops", "src", "index.ts"),
          header + "exports.unlockDayNow = onCall(async () => 1);\n",
        );
      } else if (layout === "js-default") {
        await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions: [{ source: "functions" }] }));
        await writeFile(
          resolve(fixture, "functions", "index.js"),
          "const { onCall } = require('firebase-functions/v2/https');\nexports.unlockDayNow = onCall(async () => 1);\n",
        );
      } else {
        await writeFile(
          resolve(fixture, "firebase.json"),
          JSON.stringify({ functions: [{ source: "functions" }, { source: "py", codebase: "py" }] }),
        );
        await writeFile(
          resolve(fixture, "functions", "src", "index.ts"),
          layout === "ts-default-unlock-and-py" ? header + callable : "export const unrelated = 1;\n",
        );
      }
      return await run(resolve(fixture, "firebase.json"));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }

  const unknown = { selected: true, conservative: true, strict: "" };
  it.each([
    ["ts-default-and-py", ["--only", "functions:py"], unknown, unknown],
    ["js-default", ["--only", "functions:default"], unknown, unknown],
    ["js-default", ["--only", "functions"], unknown, unknown],
    ["js-default", [], unknown, unknown],
    // A `remoteSource` codebase has no local source to inventory.
    ["ts-default-and-remote", ["--only", "functions"], unknown, unknown],
    ["ts-default-and-remote", [], unknown, unknown],
    // A kit with a local `source` is never the `default` codebase.
    ["ts-default-and-kit", ["--only", "functions"], unknown, unknown],
    ["ts-default-and-kit", ["--only", "functions:daily"], unknown, unknown],
    ["ts-default-and-kit", ["--only", "functions:default"], { selected: false, conservative: false, strict: "" }, { selected: false, conservative: false, strict: "" }],
    // A CommonJS export assignment is a shape the source walk does not model.
    ["ts-default-and-commonjs-ops", ["--only", "functions:ops"], unknown, unknown],
    ["ts-default-and-commonjs-ops", ["--only", "functions"], unknown, unknown],
    ["ts-default-and-object-assign-ops", ["--only", "functions:ops"], unknown, unknown],
    ["ts-default-and-bracket-module-ops", ["--only", "functions:ops"], unknown, unknown],
    ["ts-default-and-export-equals-ops", ["--only", "functions:ops"], unknown, unknown],
    // An entry point other than the index build, a destructured export, and a
    // service-renaming `prefix` each make the source index unauthoritative.
    ["ops-variant-main", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-binding", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-import-alias", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-top-level-this", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-heritage-this", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-computed-name-this", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-computed-field-this", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-decorator-this", ["--only", "functions:ops"], unknown, unknown],
    // So does a local module the index reaches through `export *`.
    ["ops-variant-star-commonjs", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-star-star-commonjs", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-star-named-hop", ["--only", "functions:ops"], unknown, unknown],
    ["ops-variant-python-inferred", ["--only", "functions:ops"], unknown, unknown],
    // A default-modified declaration is opaque; an ambient declaration exports nothing.
    ["ops-variant-star-default-function", ["--only", "functions:ops"], unknown, unknown],
    [
      "ops-variant-star-declare",
      ["--only", "functions:ops"],
      { selected: true, conservative: false, strict: "unlock" },
      { selected: false, conservative: false, strict: "" },
    ],
    // A name exported behind a local star is exported whatever the graph traces.
    ...["star-later-assignment", "star-destructured-clause", "star-package-named"].map((variant) => [
      `ops-variant-${variant}`,
      ["--only", "functions:ops"],
      { selected: true, conservative: false, strict: "unlock" },
      { selected: false, conservative: false, strict: "" },
    ]),
    [
      "ops-variant-star-declared",
      ["--only", "functions:ops"],
      { selected: true, conservative: false, strict: "unlock" },
      { selected: false, conservative: false, strict: "" },
    ],
    // A local type-only or ambient binding in a named export clause publishes nothing.
    ...[
      "star-interface-clause",
      "interface-clause",
      "ambient-clause",
      "star-ambient-clause",
      "type-reexport",
      "star-type-reexport",
      "star-hop-type-reexport",
      "merged-type-value-reexport",
      "default-type-import",
      "named-type-import",
      "default-type-reexport",
    ].map((variant) => [
      `ops-variant-${variant}`,
      ["--only", "functions:ops"],
      { selected: true, conservative: false, strict: "unlock" },
      { selected: false, conservative: false, strict: "" },
    ]),
    ...["value-reexport", "default-value-import", "merged-import-value", "cyclic-type-reexport"].map((variant) => [
      `ops-variant-${variant}`,
      ["--only", "functions:ops"],
      { selected: true, conservative: false, strict: "unlock,approve" },
      { selected: false, conservative: false, strict: "" },
    ]),
    [
      "ops-variant-interface-merged-value",
      ["--only", "functions:ops"],
      { selected: true, conservative: false, strict: "unlock,approve" },
      { selected: false, conservative: false, strict: "" },
    ],
    ["ops-variant-functions-yaml", ["--only", "functions:ops"], unknown, unknown],
    // Codebase precedence holds for an imported functions config too.
    ...["inline-config-unlock-codebase", "imported-config-unlock-codebase"].map((layout) => [
      layout,
      ["--only", "functions:unlockDayNow"],
      { selected: false, conservative: false, strict: "" },
      { selected: true, conservative: false, strict: "mint" },
    ]),
    ["ops-variant-prefix", ["--only", "functions:ops"], unknown, unknown],
    // A non-Node runtime's surface is not its TypeScript index, even if one exists.
    ["ts-default-and-python-ops", ["--only", "functions:ops"], unknown, unknown],
    ["ts-default-and-python-ops", ["--only", "functions"], unknown, unknown],
    // A source directory a predeploy hook may generate has an unknown surface;
    // a missing one with no hook publishes nothing.
    ["ts-default-and-generated-ops", ["--only", "functions:ops"], unknown, unknown],
    ["ts-default-and-generated-ops", ["--only", "functions"], unknown, unknown],
    [
      "ts-default-and-missing-ops",
      ["--only", "functions:ops"],
      { selected: false, conservative: false, strict: "" },
      { selected: false, conservative: false, strict: "" },
    ],
    ["ts-default-unlock-and-py", ["--only", "functions"], { selected: true, conservative: false, strict: "unlock" }, unknown],
    ["ts-default-unlock-and-py", [], { selected: true, conservative: false, strict: "unlock" }, unknown],
    [
      "ts-default-unlock-and-py",
      ["--only", "functions:default"],
      { selected: true, conservative: false, strict: "unlock" },
      { selected: false, conservative: false, strict: "" },
    ],
  ])("classifies an unindexed or star-resolved codebase layout (%s, %j)", async (layout, args, admin, invitation) => {
    const result = await withUnindexedCodebase(layout, (configPath) =>
      classifyFirebaseDeployRequest(["fiveacross", ...args], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      functionsAttempted: true,
      adminCallablesInvokerSelected: admin.selected,
      adminCallablesInvokerConservative: admin.conservative,
      adminCallablesStrictServices: admin.strict,
      eventInvitationsInvokerSelected: invitation.selected,
      eventInvitationsInvokerConservative: invitation.conservative,
      eventInvitationsStrictServices: invitation.strict,
    });
  });
});

describe("admin-callables deploy scope (#1277)", () => {
  it.each([{ args: [] }, { args: ["--only", "functions"] }, { args: ["--only", "functions:default"] }])(
    "keeps both admin callables the real index exports strict ($args)",
    async ({ args }) => {
      const result = await classify(args);

      expect(result).toMatchObject({
        adminCallablesInvokerSelected: true,
        adminCallablesInvokerConservative: false,
        adminCallablesStrictServices: "unlock,approve",
      });
    },
  );

  it("keeps an exported unlockDayNow strict and tolerates a not-yet-exported approvePrompts", async () => {
    const result = await withIndex(
      [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => 1);",
      ],
      (configPath) =>
        classifyFirebaseDeployRequest(["fiveacross", "--only", "functions"], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: false,
      adminCallablesStrictServices: "unlock",
    });
  });

  it("resolves a local export-star to what the module exports instead of making every admin peer strict", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "admin-callable-star-"));
    try {
      await nodeSource(resolve(fixture, "functions"));
      await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions: { source: "functions" } }));
      await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export * from './admin';\n");
      await writeFile(
        resolve(fixture, "functions", "src", "admin.ts"),
        "import { onCall } from 'firebase-functions/v2/https';\nexport const unlockDayNow = onCall(async () => 1);\n",
      );

      const result = await classifyFirebaseDeployRequest(["fiveacross"], {
        defaultConfigPath: resolve(fixture, "firebase.json"),
      });
      expect(result).toMatchObject({
        adminCallablesInvokerSelected: true,
        adminCallablesInvokerConservative: false,
        adminCallablesStrictServices: "unlock",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("stays conservative when a local star re-exports a package star", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "admin-callable-package-star-"));
    try {
      await nodeSource(resolve(fixture, "functions"));
      await writeFile(resolve(fixture, "firebase.json"), JSON.stringify({ functions: { source: "functions" } }));
      await writeFile(resolve(fixture, "functions", "src", "index.ts"), "export * from './admin';\n");
      await writeFile(
        resolve(fixture, "functions", "src", "admin.ts"),
        "import { onCall } from 'firebase-functions/v2/https';\nexport const unlockDayNow = onCall(async () => 1);\nexport * from 'my-admin-callables';\n",
      );

      const result = await classifyFirebaseDeployRequest(["fiveacross"], {
        defaultConfigPath: resolve(fixture, "firebase.json"),
      });
      expect(result).toMatchObject({
        adminCallablesInvokerSelected: true,
        adminCallablesInvokerConservative: false,
        adminCallablesStrictServices: "unlock,approve",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("keeps both services strict once approvePrompts is exported", async () => {
    const result = await withIndex(
      [
        "import { onCall } from 'firebase-functions/v2/https';",
        "export const unlockDayNow = onCall(async () => 1);",
        "export const approvePrompts = onCall(async () => 1);",
      ],
      (configPath) =>
        classifyFirebaseDeployRequest(["fiveacross"], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: false,
      adminCallablesStrictServices: "unlock,approve",
    });
  });

  it("does not select the family for a codebase that exports neither callable", async () => {
    const result = await withIndex(["export const unrelated = 1;"], (configPath) =>
      classifyFirebaseDeployRequest(["fiveacross"], { defaultConfigPath: configPath }),
    );

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: false,
      adminCallablesStrictServices: "",
    });
  });

  it.each([
    ["functions:unlockDayNow", "unlock"],
    ["functions:default:unlockDayNow", "unlock"],
    ["functions:approvePrompts", "approve"],
    ["functions:unlockDayNow,functions:approvePrompts", "unlock,approve"],
    ["functions:someGroup,functions:approvePrompts", "approve"],
  ])("keeps only explicitly selected services strict for %s", async (only, strict) => {
    const result = await classify(["--only", only]);

    expect(result).toMatchObject({
      functionsAttempted: true,
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: false,
      adminCallablesStrictServices: strict,
    });
  });

  it("treats an unfamiliar Functions selector as an allow-missing probe", async () => {
    const result = await classify(["--only", "functions:someGroup"]);

    expect(result).toMatchObject({
      adminCallablesInvokerSelected: true,
      adminCallablesInvokerConservative: true,
      adminCallablesStrictServices: "",
    });
  });

  it("does not inspect admin services for hosting or an unrelated exact endpoint", async () => {
    for (const only of ["hosting", "functions:emailUnsubscribe"]) {
      expect(await classify(["--only", only])).toMatchObject({
        adminCallablesInvokerSelected: false,
        adminCallablesInvokerConservative: false,
        adminCallablesStrictServices: "",
      });
    }
    expect((await classify(["--except", "functions"])).adminCallablesInvokerSelected).toBe(false);
  });

  it("emits the three admin fields in the shell classification deploy.sh parses", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts", "validate-firebase-deploy-filters.mjs"), "--", "fiveacross", "--only", "functions:unlockDayNow"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          FIREBASE_DEPLOY_DEFAULT_CONFIG: resolve(repoRoot, "firebase.json"),
          FIREBASE_DEPLOY_CLASSIFIER_FORMAT: "shell",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ADMIN_CALLABLES_INVOKER_SELECTED=true\n");
    expect(result.stdout).toContain("ADMIN_CALLABLES_INVOKER_CONSERVATIVE=false\n");
    expect(result.stdout).toContain("ADMIN_CALLABLES_STRICT_SERVICES=unlock\n");
    expect(result.stdout.trim().split("\n")).toHaveLength(17);
  });
});
