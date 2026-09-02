// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = resolve(
  repoRoot,
  "scripts",
  "set-event-invitations-invoker.sh",
);
const fixtures = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "event-invitations-invoker-"));
  fixtures.push(root);
  const log = join(root, "gcloud.log");
  const gcloud = join(root, "gcloud");
  await writeFile(
    gcloud,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GCLOUD_LOG"
service=""
for candidate in minteventinvitation redeemeventinvitation revokeeventinvitation; do
  if [[ " $* " == *" $candidate "* ]]; then service="$candidate"; fi
done
if [[ " $* " == *" run services describe "* ]]; then
  if [[ ",\${MISSING_SERVICES:-}," == *",$service,"* ]]; then
    echo "ERROR: (gcloud.run.services.describe) NOT_FOUND: Requested entity was not found." >&2
    exit 1
  fi
  echo true
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

describe("event-invitation Cloud Run invoker wrapper", () => {
  it("checks all three lowercased Gen2 services in the selected project", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--dry-run"], {
      EVENT_INVITATIONS_PROJECT: "target-project",
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain(
      "run services describe minteventinvitation --region us-central1 --project target-project",
    );
    expect(calls).toContain(
      "run services describe redeemeventinvitation --region us-central1 --project target-project",
    );
    expect(calls).toContain(
      "run services describe revokeeventinvitation --region us-central1 --project target-project",
    );
  });

  it("allows only named unselected services to be absent", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(
      fixture,
      [
        "--allow-missing-service",
        "redeem",
        "--allow-missing-service",
        "revoke",
      ],
      {
        MISSING_SERVICES: "redeemeventinvitation,revokeeventinvitation",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain("minteventinvitation");
    expect(calls).toContain("redeemeventinvitation");
    expect(calls).toContain("revokeeventinvitation");
  });

  it("fails when the exact selected service is missing and still checks its peers", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(
      fixture,
      [
        "--allow-missing-service",
        "redeem",
        "--allow-missing-service",
        "revoke",
      ],
      { MISSING_SERVICES: "minteventinvitation" },
    );

    expect(result.status).not.toBe(0);
    const calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain("redeemeventinvitation");
    expect(calls).toContain("revokeeventinvitation");
  });

  it("forces an idempotent update for every service when asked to prove permission", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--prove-update"]);

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, "utf8");
    expect(calls.match(/run services update /g)).toHaveLength(3);
  });

  it("rejects an unknown missing-service alias before calling gcloud", async () => {
    const fixture = await makeFixture();

    const result = runWrapper(fixture, ["--allow-missing-service", "exchange"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("expects 'mint', 'redeem', or 'revoke'");
    await expect(readFile(fixture.log, "utf8")).rejects.toThrow();
  });
});
