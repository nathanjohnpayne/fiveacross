#!/usr/bin/env node
// Dry-run-first marker identity migration for #1072.
//
// The Feed's collection-group listener can be scoped by `eventId` only after
// every marker carries the Event named by its document path. Older installed
// clients do not write that field, so this migration first opens the explicit,
// project-pinned compatibility window consumed by the server-side reconciler,
// then backfills every currently missing field. Present-but-wrong identity is
// never corrected: it is evidence of malformed state and blocks the run.
//
// Usage:
//   npm run migrate:marker-event-id -- <gaycruisebingo|fiveacross> \
//     --accept-legacy-until <ISO timestamp>
//   npm run migrate:marker-event-id -- <gaycruisebingo|fiveacross> \
//     --accept-legacy-until <ISO timestamp> --apply
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEPLOY_TARGETS } from "./build-target.mjs";
import { initFirestore } from "./seed.mjs";

export const COMPATIBILITY_PATH = "markerDeliveryCompatibility/current";
export const COMPATIBILITY_SCHEMA_VERSION = 1;
export const COMPATIBILITY_CUTOFF_UPPER_BOUND_MS = 4_102_444_800_000;

const own = (value, key) =>
  value != null && Object.prototype.hasOwnProperty.call(value, key);

export function resolveMarkerMigrationTarget(target) {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.startsWith("-")
  ) {
    throw new Error(
      `marker-event-id: an explicit positional target is required (${Object.keys(DEPLOY_TARGETS).join("|")}).`,
    );
  }
  if (!Object.hasOwn(DEPLOY_TARGETS, target)) {
    throw new Error(
      `marker-event-id: Unknown deploy target "${target}". Expected one of: ${Object.keys(DEPLOY_TARGETS).join(", ")}.`,
    );
  }
  const config = DEPLOY_TARGETS[target];
  return { target, projectId: config.firebaseProject };
}

export function parseAcceptLegacyUntil(raw, now = Date.now()) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      "marker-event-id: --accept-legacy-until <ISO timestamp> is required.",
    );
  }
  // Date.parse accepts friendly prose such as "tomorrow" in some runtimes.
  // Require an ISO date/time shape as well as a finite parse so the reviewed
  // command names the same instant on every machine.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      raw,
    );
  if (!match) {
    throw new Error(
      "marker-event-id: --accept-legacy-until must be an ISO timestamp.",
    );
  }
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const millisecond = Number(fraction.padEnd(3, "0"));
  const calendarCheck = new Date(0);
  calendarCheck.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendarCheck.setUTCHours(
    Number(hour),
    Number(minute),
    Number(second),
    millisecond,
  );
  if (
    calendarCheck.getUTCFullYear() !== Number(year) ||
    calendarCheck.getUTCMonth() !== Number(month) - 1 ||
    calendarCheck.getUTCDate() !== Number(day) ||
    calendarCheck.getUTCHours() !== Number(hour) ||
    calendarCheck.getUTCMinutes() !== Number(minute) ||
    calendarCheck.getUTCSeconds() !== Number(second) ||
    calendarCheck.getUTCMilliseconds() !== millisecond
  ) {
    throw new Error(
      "marker-event-id: --accept-legacy-until must be an exact ISO calendar timestamp.",
    );
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      "marker-event-id: --accept-legacy-until must be an ISO timestamp.",
    );
  }
  if (value <= now) {
    throw new Error(
      "marker-event-id: --accept-legacy-until must be in the future at run start.",
    );
  }
  if (value >= COMPATIBILITY_CUTOFF_UPPER_BOUND_MS) {
    throw new Error(
      "marker-event-id: --accept-legacy-until must be before 2100-01-01T00:00:00.000Z.",
    );
  }
  return value;
}

function normalizeAcceptLegacyUntil(value, now) {
  if (typeof value === "string") return parseAcceptLegacyUntil(value, now);
  if (!validCompatibilityCutoff(value) || value <= now) {
    throw new Error(
      "marker-event-id: --accept-legacy-until must be in the future at run start and before 2100-01-01T00:00:00.000Z.",
    );
  }
  return value;
}

function validCompatibilityCutoff(value) {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    value < COMPATIBILITY_CUTOFF_UPPER_BOUND_MS
  );
}

export function parseMarkerPath(path) {
  if (typeof path !== "string") return null;
  const parts = path.split("/");
  if (
    parts.length !== 6 ||
    parts[0] !== "events" ||
    parts[2] !== "tally" ||
    parts[4] !== "markers" ||
    !parts[1] ||
    !parts[3] ||
    !parts[5]
  ) {
    return null;
  }
  return { eventId: parts[1], itemId: parts[3], markerUid: parts[5] };
}

export function classifyMarkerDocument({ path, data }) {
  const parsed = parseMarkerPath(path);
  if (!parsed) return { path, classification: "malformed-path" };
  if (
    data == null ||
    typeof data !== "object" ||
    data.uid !== parsed.markerUid
  ) {
    return { path, ...parsed, classification: "malformed-uid" };
  }
  if (!own(data, "eventId"))
    return { path, ...parsed, classification: "missing" };
  if (typeof data.eventId !== "string") {
    return {
      path,
      ...parsed,
      classification: "event-id-nonstring",
      actualEventId: data.eventId,
    };
  }
  if (data.eventId !== parsed.eventId) {
    return {
      path,
      ...parsed,
      classification: "event-id-mismatch",
      actualEventId: data.eventId,
    };
  }
  return { path, ...parsed, classification: "exact" };
}

export function planMarkerEventIdMigration(markerDocuments) {
  const classified = markerDocuments.map(classifyMarkerDocument);
  const missing = classified.filter((row) => row.classification === "missing");
  const exact = classified.filter((row) => row.classification === "exact");
  const anomalies = classified.filter(
    (row) => row.classification !== "missing" && row.classification !== "exact",
  );
  return {
    total: classified.length,
    exact,
    missing,
    anomalies,
    blocked: anomalies.length > 0,
  };
}

function desiredCompatibility({ projectId, acceptLegacyUntil }) {
  return {
    schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
    projectId,
    acceptLegacyUntil,
  };
}

function validCompatibilityDocument(data) {
  if (data == null || typeof data !== "object" || Array.isArray(data))
    return false;
  const keys = Object.keys(data).sort();
  return (
    keys.length === 3 &&
    keys[0] === "acceptLegacyUntil" &&
    keys[1] === "projectId" &&
    keys[2] === "schemaVersion" &&
    data.schemaVersion === COMPATIBILITY_SCHEMA_VERSION &&
    typeof data.projectId === "string" &&
    data.projectId.length > 0 &&
    validCompatibilityCutoff(data.acceptLegacyUntil)
  );
}

export function planCompatibilityWrite(
  current,
  { projectId, acceptLegacyUntil },
) {
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    !validCompatibilityCutoff(acceptLegacyUntil)
  ) {
    throw new Error(
      "marker-event-id: requested compatibility config is malformed. No write performed.",
    );
  }
  const desired = desiredCompatibility({ projectId, acceptLegacyUntil });
  if (current == null) return { action: "create", desired };
  if (!validCompatibilityDocument(current)) {
    throw new Error(
      `marker-event-id: ${COMPATIBILITY_PATH} is malformed; expected exactly ` +
        "{schemaVersion:1,projectId,acceptLegacyUntil:number}. No write performed.",
    );
  }
  if (current.projectId !== projectId) {
    throw new Error(
      `marker-event-id: ${COMPATIBILITY_PATH} belongs to wrong project ${current.projectId}; ` +
        `expected ${projectId}. No write performed.`,
    );
  }
  if (current.acceptLegacyUntil > acceptLegacyUntil) {
    throw new Error(
      `marker-event-id: refusing to shorten ${COMPATIBILITY_PATH} from ` +
        `${new Date(current.acceptLegacyUntil).toISOString()} to ${new Date(acceptLegacyUntil).toISOString()}.`,
    );
  }
  if (current.acceptLegacyUntil === acceptLegacyUntil)
    return { action: "none", desired };
  return { action: "extend", desired };
}

function snapshotExists(snapshot) {
  return typeof snapshot?.exists === "function"
    ? snapshot.exists()
    : snapshot?.exists === true;
}

function snapshotData(snapshot) {
  return snapshotExists(snapshot) ? snapshot.data() : null;
}

function markerRows(snapshot) {
  return snapshot.docs.map((doc) => ({
    path: doc.ref.path,
    data: doc.data(),
    ref: doc.ref,
  }));
}

async function readState(db) {
  const compatibilityRef = db.doc(COMPATIBILITY_PATH);
  const [compatibilitySnapshot, markerSnapshot] = await Promise.all([
    compatibilityRef.get(),
    db.collectionGroup("markers").get(),
  ]);
  return {
    compatibilityRef,
    compatibility: snapshotData(compatibilitySnapshot),
    markerDocuments: markerRows(markerSnapshot),
  };
}

function formatAnomaly(row) {
  const actual = own(row, "actualEventId")
    ? ` (eventId=${JSON.stringify(row.actualEventId)})`
    : "";
  return `${row.classification}: ${row.path}${actual}`;
}

function assertSafeMarkerPlan(plan, stage) {
  if (!plan.blocked) return;
  throw new Error(
    `marker-event-id: ${stage} found ${plan.anomalies.length} anomalous marker(s); refusing migration.\n` +
      plan.anomalies.map((row) => `  ${formatAnomaly(row)}`).join("\n"),
  );
}

function exactCompatibility(data, desired) {
  return (
    validCompatibilityDocument(data) &&
    data.schemaVersion === desired.schemaVersion &&
    data.projectId === desired.projectId &&
    data.acceptLegacyUntil === desired.acceptLegacyUntil
  );
}

export function assertReviewedMainCheckout({
  cwd = process.cwd(),
  runGuard = spawnSync,
  environment = process.env,
  target = "(target)",
} = {}) {
  const guardPath = fileURLToPath(
    new URL("./lib/deploy-main-guard.sh", import.meta.url),
  );
  const commandName = `npm run migrate:marker-event-id -- ${target} --accept-legacy-until <ISO> --apply`;
  const result = runGuard(
    "bash",
    [
      "-c",
      'source "$1"; guard_deploy_main_checkout "$2" false',
      "bash",
      guardPath,
      commandName,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...environment, DEPLOY_ALLOW_DIRTY: "0" },
    },
  );
  if (result.status === 0) return;
  const detail =
    typeof result.stderr === "string"
      ? result.stderr
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("To override "))
          .join("\n")
          .trim()
      : "";
  throw new Error(
    "marker-event-id: --apply requires a clean main checkout at exact origin/main. " +
      `No write performed.${detail ? `\n${detail}` : ""}`,
  );
}

export function assertReviewedDeployCredential({
  target,
  environment = process.env,
  readCredential = readFileSync,
} = {}) {
  const { projectId } = resolveMarkerMigrationTarget(target);
  const credentialPath = environment.GOOGLE_APPLICATION_CREDENTIALS;
  if (
    !credentialPath ||
    credentialPath !== environment.OP_PREFLIGHT_FIREBASE_SA_TMPFILE ||
    environment.OP_PREFLIGHT_FIREBASE_PROJECT !== projectId
  ) {
    throw new Error(
      `marker-event-id: --apply requires the exact ${projectId} deploy preflight credential. No write performed.`,
    );
  }
  let credential;
  try {
    credential = JSON.parse(readCredential(credentialPath, "utf8"));
  } catch {
    credential = null;
  }
  if (
    credential?.type !== "service_account" ||
    credential?.project_id !== projectId ||
    credential?.client_email !==
      `firebase-deployer@${projectId}.iam.gserviceaccount.com`
  ) {
    throw new Error(
      `marker-event-id: --apply requires the exact ${projectId} deploy preflight credential. No write performed.`,
    );
  }
  return credentialPath;
}

export async function executeMarkerEventIdMigration({
  target,
  acceptLegacyUntil,
  apply = false,
  now = Date.now,
  initializeFirestore = initFirestore,
  verifyReviewedSource = assertReviewedMainCheckout,
  verifyReviewedCredential = assertReviewedDeployCredential,
  environment = process.env,
  log = console.log,
} = {}) {
  const selected = resolveMarkerMigrationTarget(target);
  // A numeric clock keeps callers/tests deterministic; production's Date.now
  // function is sampled again inside every retried compatibility transaction.
  const currentTime = typeof now === "function" ? now : () => now;
  const cutoff = normalizeAcceptLegacyUntil(acceptLegacyUntil, currentTime());
  const desired = desiredCompatibility({
    projectId: selected.projectId,
    acceptLegacyUntil: cutoff,
  });

  if (apply) {
    verifyReviewedSource({ target, environment });
    verifyReviewedCredential({ target, environment });
  }

  environment.GOOGLE_CLOUD_PROJECT = selected.projectId;
  // Never let an ambient Event redirect the shared initializer. Targets with a
  // static Event pin it; the hostname-resolved Five Across target deliberately
  // falls through to seed.mjs's registered project default.
  environment.VITE_EVENT_ID =
    DEPLOY_TARGETS[target].identity.VITE_EVENT_ID || "";
  const initialized = await initializeFirestore({
    allowLocalServiceAccountKey: !apply,
  });
  if (initialized.projectId !== selected.projectId) {
    throw new Error(
      `marker-event-id: refusing Firestore project ${initialized.projectId || "(none)"}; expected ${selected.projectId}.`,
    );
  }
  const { db } = initialized;
  const initial = await readState(db);
  const compatibilityPlan = planCompatibilityWrite(
    initial.compatibility,
    desired,
  );
  const markerPlan = planMarkerEventIdMigration(initial.markerDocuments);
  assertSafeMarkerPlan(markerPlan, "initial scan");

  log(
    `marker-event-id: target=${target} project=${selected.projectId} mode=${apply ? "APPLY" : "DRY-RUN"} ` +
      `markers=${markerPlan.total} exact=${markerPlan.exact.length} missing=${markerPlan.missing.length} ` +
      `compatibility=${compatibilityPlan.action} until=${new Date(cutoff).toISOString()}`,
  );
  if (!apply) {
    log("Dry run only: no data was changed. Re-run with --apply after review.");
    return {
      wroteCompatibility: false,
      wroteMarkers: 0,
      compatibilityPlan,
      markerPlan,
    };
  }

  let wroteCompatibility = false;
  await db.runTransaction(async (transaction) => {
    // Firestore may retry the callback after an earlier attempt scheduled a
    // write. Report only what the committed attempt did.
    wroteCompatibility = false;
    const fresh = snapshotData(await transaction.get(initial.compatibilityRef));
    const checkedAt = currentTime();
    if (!Number.isFinite(checkedAt) || cutoff <= checkedAt) {
      throw new Error(
        "marker-event-id: cutoff expired before compatibility could be opened. No write performed.",
      );
    }
    const freshPlan = planCompatibilityWrite(fresh, desired);
    if (freshPlan.action === "none") return;
    transaction.set(initial.compatibilityRef, freshPlan.desired);
    wroteCompatibility = true;
  });

  let wroteMarkers = 0;
  const markerByPath = new Map(
    initial.markerDocuments.map((row) => [row.path, row]),
  );
  for (const planned of markerPlan.missing) {
    const row = markerByPath.get(planned.path);
    if (!row) {
      throw new Error(
        `marker-event-id: internal plan lost marker ${planned.path}.`,
      );
    }
    let wroteThisMarker = false;
    await db.runTransaction(async (transaction) => {
      wroteThisMarker = false;
      const freshSnapshot = await transaction.get(row.ref);
      if (!snapshotExists(freshSnapshot)) {
        throw new Error(
          `marker-event-id: marker deleted after planning: ${row.path}.`,
        );
      }
      if (freshSnapshot.ref?.path !== row.ref.path) {
        throw new Error(
          `marker-event-id: marker path drifted after planning from ${row.ref.path} to ` +
            `${freshSnapshot.ref?.path ?? "(missing)"}. Refusing update.`,
        );
      }
      const fresh = classifyMarkerDocument({
        path: freshSnapshot.ref.path,
        data: freshSnapshot.data(),
      });
      if (fresh.classification === "exact") return;
      if (fresh.classification !== "missing") {
        throw new Error(
          `marker-event-id: marker drifted after planning (${formatAnomaly(fresh)}). Refusing update.`,
        );
      }
      transaction.update(row.ref, { eventId: fresh.eventId });
      wroteThisMarker = true;
    });
    if (wroteThisMarker) wroteMarkers += 1;
  }

  const readback = await readState(db);
  const readbackPlan = planMarkerEventIdMigration(readback.markerDocuments);
  assertSafeMarkerPlan(readbackPlan, "readback");
  if (readbackPlan.missing.length > 0) {
    throw new Error(
      `marker-event-id: readback did not converge; ${readbackPlan.missing.length} marker(s) still lack eventId.`,
    );
  }
  if (!exactCompatibility(readback.compatibility, desired)) {
    throw new Error(
      `marker-event-id: ${COMPATIBILITY_PATH} readback is not the exact requested config.`,
    );
  }
  log(
    `marker-event-id: applied and verified; compatibility=${wroteCompatibility ? "written" : "unchanged"} ` +
      `markers-written=${wroteMarkers}.`,
  );
  return { wroteCompatibility, wroteMarkers, compatibilityPlan, markerPlan };
}

export function parseCliArgs(args, now = Date.now()) {
  const target = args[0];
  resolveMarkerMigrationTarget(target);
  let apply = false;
  let rawCutoff;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--apply") {
      if (apply)
        throw new Error("marker-event-id: --apply may be provided only once.");
      apply = true;
      continue;
    }
    if (arg === "--accept-legacy-until") {
      if (rawCutoff !== undefined) {
        throw new Error(
          "marker-event-id: --accept-legacy-until may be provided only once.",
        );
      }
      rawCutoff = args[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`marker-event-id: unknown argument ${arg}.`);
  }
  return {
    target,
    acceptLegacyUntil: parseAcceptLegacyUntil(rawCutoff, now),
    apply,
  };
}

async function main() {
  await executeMarkerEventIdMigration(parseCliArgs(process.argv.slice(2)));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "marker-event-id migration failed.",
    );
    process.exitCode = 1;
  });
}
