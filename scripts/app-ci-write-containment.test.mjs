// The one invariant `app-ci` carries for the deploy-scope classifier, pinned
// here because nothing else can see it (#1164).
//
// WHAT IS AT STAKE. The classifier refuses the single-endpoint exemption
// fail-closed unless it can PROVE a platform write containment, and both of its
// suites skip every case that needs a predeploy hook to have run when it cannot
// — `scripts/single-endpoint-deploy-scope.test.mjs` under `npm test`, and
// `tests/test_deploy.sh` under `npm run test:deploy`. On `ubuntu-latest` the
// classifier could prove nothing (no `bwrap`, and Ubuntu 24.04 refuses the
// unprivileged user namespace `unshare` needs), so those skips were the whole
// of CI's Linux coverage and nobody's log said so out loud. The workflow now
// installs `bubblewrap` and fails unless the probe names `bwrap` — but only
// from one position in the job, and both of its neighbours are load-bearing.
//
// BELOW the root `npm ci`, because the probe imports the classifier and that
// module's body resolves `commander`, `typescript`, seven `firebase-tools/lib`
// entry points and `portfinder` through `createRequire` before it exports
// anything: on a runner whose `node_modules` does not exist yet, the probe and
// its retry both die with MODULE_NOT_FOUND and the job ends before the first
// suite runs at all. ABOVE both consumers, because a step reordered below
// either one — or deleted — silently restores the skips, and the suites stay
// green while proving less, which is exactly the failure this repository keeps
// re-learning. Neither neighbour announces itself in the classifier, so both
// ends are pinned here.
//
// WHY OFFSETS RATHER THAN A PARSED WORKFLOW. Steps run in document order, so a
// position in the file IS the order, and this repository's dependency graph
// carries no YAML parser of its own — adding one to assert four line positions
// would cost more than it pins.
//
// WHAT IS ASSERTED ABOUT THE CONTENTS. Only the part that is the WORKFLOW's
// answer to give rather than the runner's: that the step asks the classifier's
// own probe, and that an answer which is not `bwrap` exits nonzero. Those two
// are the whole difference between this step and a bare
// `apt-get install bubblewrap`, which would install the binary and let every
// case go on skipping if the kernel still refused the namespace. Whether the
// runner can actually contain a write is the runner's answer, and nothing here
// pins it.
//
// EVERY CONTENT MATCH IS AGAINST EXECUTABLE LINES. The step carries a long
// comment which names the same identifiers the assertions look for, and the
// slice below runs to the next `- name:`, so it also swallows the comment block
// that introduces the following step. Matching the raw slice would let prose —
// this step's, or a future neighbour's — stand in for the code it describes,
// and the guard would survive the exact deletion it exists to catch. Comment
// lines are therefore stripped before any content assertion.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "app-ci.yml");

/** The offset of the single line matching `pattern`, and a named failure when it is not unique. */
function soleOffset(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  expect(matches.length, `${label}: expected exactly one match in app-ci.yml`).toBe(1);
  return matches[0].index;
}

describe("app-ci provisions the deploy-scope classifier's write containment", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  /** Where the workflow installs bubblewrap. Resolved per case, so a missing step fails a case rather than the file's collection. */
  const installOffset = () =>
    soleOffset(workflow, /^\s*sudo apt-get install .*\bbubblewrap\b.*$/gm, "the bubblewrap install");

  /**
   * That step's own body, so a match cannot be satisfied by some unrelated
   * step: from the install line to wherever the next step's `- name:` begins.
   * Comment lines are dropped, so only executable content can satisfy a match.
   */
  const containmentStepCode = () => {
    const rest = workflow.slice(installOffset());
    const next = rest.search(/\n\s*- name:/);
    const step = next === -1 ? rest : rest.slice(0, next);
    return step.replaceAll(/^[ \t]*#.*$/gm, "");
  };

  it.each([
    // Not a stand-in for the probe — a `bwrap --version` that succeeds says
    // nothing about whether the kernel will grant the namespace, which is the
    // half that was actually missing.
    [
      "imports the classifier's own probe",
      /const \{ probeWriteContainment \} = await import\(/,
    ],
    // The import alone is not the assertion: a body that imported the symbol
    // and never called it would print nothing and exit 0.
    ["and calls it", /await probeWriteContainment\(\)/],
  ])("%s, so a runner that can contain nothing fails the job", (_label, pattern) => {
    expect(containmentStepCode()).toMatch(pattern);
  });

  it("installs bubblewrap after the root `npm ci`, whose packages the probe's import needs", () => {
    // Above `npm ci` the step is not merely early, it is fatal: the classifier
    // requires `commander`, `typescript`, `firebase-tools` and `portfinder` at
    // module load, so the probe and its retry both fail MODULE_NOT_FOUND and
    // no suite in the job ever starts.
    expect(soleOffset(workflow, /^\s*run: npm ci$/gm, "the root npm ci")).toBeLessThan(
      installOffset(),
    );
  });

  it.each([
    ["the vitest suites (npm test)", /^\s*run: npm test$/gm],
    ["the deployment safety harness (npm run test:deploy)", /^\s*run: npm run test:deploy$/gm],
  ])("installs bubblewrap before %s", (label, pattern) => {
    expect(installOffset()).toBeLessThan(soleOffset(workflow, pattern, label));
  });

  it.each([
    // Not `!answer.ok`: an `unshare` spelling winning instead is a proved
    // mechanism and would satisfy that, while leaving the `bwrap` argv — the
    // read-only checkout bound back over the writable set — exactly as
    // untested as it was before #1164.
    ["insists on `bwrap` by name rather than on some mechanism", /answer\.label !== "bwrap"/],
    // Without this the probe is a `console.log`: the answer is printed, the
    // step is green, and every case goes on skipping unread.
    ["fails the job on any other answer", /process\.exit\(1\)/],
  ])("%s", (_label, pattern) => {
    expect(containmentStepCode()).toMatch(pattern);
  });
});
