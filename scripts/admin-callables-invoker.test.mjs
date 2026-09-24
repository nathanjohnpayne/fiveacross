// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = resolve(repoRoot, "scripts", "set-admin-callables-invoker.sh");
const fixtures = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "admin-callables-invoker-"));
  fixtures.push(root);
  const log = join(root, "gcloud.log");
  const gcloud = join(root, "gcloud");
  await writeFile(
    gcloud,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GCLOUD_LOG"
service=""
for candidate in unlockdaynow approveprompts; do
  if [[ " $* " == *" $candidate "* ]]; then service="$candidate"; fi
done
if [[ " $* " == *" run services describe "* ]]; then
  if [[ ",\${MISSING_SERVICES:-}," == *",$service,"* ]]; then
    echo "ERROR: (gcloud.run.services.describe) NOT_FOUND: Requested entity was not found." >&2
    exit 1
  fi
  echo "\${ANNOTATION:-true}"
  exit 0
fi
if [[ " $* " == *" run services update "* ]]; then exit 0; fi
if [[ " $* " == *" run services list "* ]]; then exit 0; fi
exit 1
`,
  );
  await chmod(gcloud, 0o755);
  return { root, log, gcloud };
}

function runWrapper(fixture, args = [], overrides = {}) {
  return spawnSync(wrapper, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GOOGLE_APPLICATION_CREDENTIALS: "",
      GCLOUD_BIN: fixture.gcloud,
      GCLOUD_LOG: fixture.log,
      MISSING_SERVICES: "",
      ...overrides,
    },
  });
}

describe("admin-callables Cloud Run invoker wrapper", () => {
  it("checks both lowercased Gen2 services in the selected project", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--dry-run"], {
      ADMIN_CALLABLES_PROJECT: "target-project",
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain(
      "run services describe unlockdaynow --region us-central1 --project target-project",
    );
    expect(calls).toContain(
      "run services describe approveprompts --region us-central1 --project target-project",
    );
    expect(result.stdout).toContain("Admin callable (unlockDayNow) invoker config");
    expect(result.stdout).toContain("Admin callable (approvePrompts) invoker config");
  });

  it("never mutates in --dry-run even when the check is still enabled", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--dry-run"], { ANNOTATION: "false" });

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, "utf8");
    expect(calls).not.toMatch(/run services update /);
    expect(result.stdout).toContain("[dry-run] would run: gcloud run services update unlockdaynow");
  });

  it("tolerates an absent approvePrompts only when it is named as allowed-missing", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--allow-missing-service", "approve"], {
      MISSING_SERVICES: "approveprompts",
      ANNOTATION: "false",
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain("run services update unlockdaynow");
    expect(result.stdout).toContain("401 UNAUTHENTICATED JSON, never an HTML 403");
  });

  it("fails when the selected service is missing and still checks its peer", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--allow-missing-service", "approve"], {
      MISSING_SERVICES: "unlockdaynow",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ADMIN_CALLABLES_UNLOCK_SERVICE");
    const calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain("run services describe approveprompts");
  });

  it("forces an idempotent update for every service when asked to prove permission", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--prove-update"]);

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, "utf8");
    expect(calls.match(/run services update /g)).toHaveLength(2);
  });

  it("rejects an unknown missing-service alias before calling gcloud", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--allow-missing-service", "resnapshot"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("expects 'unlock' or 'approve'");
    await expect(readFile(fixture.log, "utf8")).rejects.toThrow();
  });
});
