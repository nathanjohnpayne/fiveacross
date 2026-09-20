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
// installs `bubblewrap` and fails unless the probe names `bwrap` — but only if
// that step runs FIRST. A step reordered below either consumer, or
// deleted, silently restores the skips and the suites stay green while proving
// less, which is exactly the failure this repository keeps re-learning.
//
// WHY OFFSETS RATHER THAN A PARSED WORKFLOW. Steps run in document order, so a
// position in the file IS the order, and this repository's dependency graph
// carries no YAML parser of its own — adding one to assert three line positions
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
   */
  const containmentStep = () => {
    const rest = workflow.slice(installOffset());
    const next = rest.search(/\n\s*- name:/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it("asks the classifier's own probe, so a runner that can contain nothing fails the job", () => {
    // Not a stand-in for the probe — a `bwrap --version` that succeeds says
    // nothing about whether the kernel will grant the namespace, which is the
    // half that was actually missing.
    expect(workflow).toMatch(/probeWriteContainment/);
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
    expect(containmentStep()).toMatch(pattern);
  });
});
