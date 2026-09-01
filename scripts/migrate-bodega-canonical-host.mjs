#!/usr/bin/env node
// One-off, dry-run-first production correction for #960.
//
// The Bodega hostname migration left two documents claiming to be canonical:
// `bodega-bay.fiveacross.app` (the accepted canonical address) and the legacy
// `bodega-bay.vacaybingo.com` entry. A hostname-resolved client installs that
// metadata before analytics starts, so leaving the legacy document
// self-canonical splits one Event's analytics dimension by entry host. The
// server email resolver also prefers `isCanonical: true`, making duplicate
// canonical rows an ambiguous origin choice.
//
// This script reads the fixed three-host Bodega inventory and validates every
// routing precondition before doing anything. `--apply` transactionally changes
// exactly two fields on the legacy document:
//
//   canonicalHost: bodega-bay.fiveacross.app
//   isCanonical: false
//
// No other document or field is written. The known pre-migration pair and the
// exact post-migration pair are the only accepted legacy states; partial or
// unfamiliar metadata fails closed. A post-commit readback proves convergence.
//
// Usage after the exact Five Across deploy preflight:
//   npm run migrate:bodega-canonical-host
//   npm run migrate:bodega-canonical-host -- --apply
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BODEGA_EVENT_ID,
  BODEGA_PREVIEW_HOSTS,
  BODEGA_PROJECT_ID,
  validateBodegaServingInventory,
} from './provision-bodega-preview.mjs';
import { initFirestore } from './seed.mjs';

export { BODEGA_EVENT_ID, BODEGA_PROJECT_ID };
export const CANONICAL_HOST = 'bodega-bay.fiveacross.app';
export const LEGACY_HOST = 'bodega-bay.vacaybingo.com';
export const BODEGA_HOSTS = BODEGA_PREVIEW_HOSTS;
const expectedEditionByHost = Object.freeze({
  [CANONICAL_HOST]: 'vacay',
  [LEGACY_HOST]: 'vacay',
  'fiveacross.app': 'fiveacross',
});

const targetMetadata = Object.freeze({ canonicalHost: CANONICAL_HOST, isCanonical: false });
const legacyMetadata = Object.freeze({ canonicalHost: LEGACY_HOST, isCanonical: true });

const metadataOf = (data) => ({
  canonicalHost: data?.canonicalHost,
  isCanonical: data?.isCanonical,
});

const sameMetadata = (left, right) =>
  left.canonicalHost === right.canonicalHost && left.isCanonical === right.isCanonical;

/**
 * Validate the complete live inventory and return the only permitted update.
 * Pure and non-mutating so every safety branch is unit-testable without
 * credentials or firebase-admin.
 */
export function planCanonicalHostMigration(hostDocuments) {
  const rows = validateBodegaServingInventory(hostDocuments, {
    operation: 'bodega-canonical-host',
  });

  for (const host of BODEGA_HOSTS) {
    const data = rows.get(host);
    const expectedEdition = expectedEditionByHost[host];
    if (data.edition !== expectedEdition) {
      throw new Error(
        `bodega-canonical-host: hostnames/${host} has Edition ${String(data.edition)}; expected ${expectedEdition}. ` +
          'No write performed.',
      );
    }
  }

  const canonical = metadataOf(rows.get(CANONICAL_HOST));
  if (!sameMetadata(canonical, { canonicalHost: CANONICAL_HOST, isCanonical: true })) {
    throw new Error(
      `bodega-canonical-host: canonical document metadata drifted on hostnames/${CANONICAL_HOST}. ` +
        'No write performed.',
    );
  }

  const apexHost = BODEGA_HOSTS[2];
  const apex = metadataOf(rows.get(apexHost));
  if (!sameMetadata(apex, targetMetadata)) {
    throw new Error(
      `bodega-canonical-host: alias metadata drifted on hostnames/${apexHost}. No write performed.`,
    );
  }

  const before = metadataOf(rows.get(LEGACY_HOST));
  if (sameMetadata(before, targetMetadata)) {
    return {
      changed: false,
      host: LEGACY_HOST,
      update: null,
      before,
      after: { ...targetMetadata },
    };
  }
  if (sameMetadata(before, legacyMetadata)) {
    return {
      changed: true,
      host: LEGACY_HOST,
      update: { ...targetMetadata },
      before,
      after: { ...targetMetadata },
    };
  }

  const knownCanonicalHost = before.canonicalHost === LEGACY_HOST || before.canonicalHost === CANONICAL_HOST;
  const knownCanonicalFlag = before.isCanonical === true || before.isCanonical === false;
  const detail = JSON.stringify(before);
  if (knownCanonicalHost && knownCanonicalFlag) {
    throw new Error(
      `bodega-canonical-host: partial canonical metadata on hostnames/${LEGACY_HOST}: ${detail}. ` +
        'No write performed.',
    );
  }
  throw new Error(
    `bodega-canonical-host: unrecognised canonical metadata on hostnames/${LEGACY_HOST}: ${detail}. ` +
      'No write performed.',
  );
}

export function formatCanonicalHostPlan(plan) {
  if (!plan.changed) {
    return `hostnames/${plan.host}: already canonical alias metadata; nothing to write`;
  }
  return [
    `hostnames/${plan.host}:`,
    `  canonicalHost: ${plan.before.canonicalHost} -> ${plan.after.canonicalHost}`,
    `  isCanonical: ${plan.before.isCanonical} -> ${plan.after.isCanonical}`,
  ].join('\n');
}

function parseArgs(args) {
  const unknown = args.filter((arg) => arg !== '--apply');
  if (unknown.length) {
    throw new Error(
      `bodega-canonical-host: unknown argument(s): ${unknown.join(', ')}. Only --apply is accepted.`,
    );
  }
  return { apply: args.includes('--apply') };
}

function rowsFromSnapshots(snapshots) {
  return snapshots.map((snapshot, index) => ({
    host: BODEGA_HOSTS[index],
    data: snapshot.exists ? snapshot.data() : null,
  }));
}

async function readPlan(db, refs) {
  return planCanonicalHostMigration(rowsFromSnapshots(await db.getAll(...refs)));
}

export function assertReviewedMainCheckout({
  cwd = process.cwd(),
  runGuard = spawnSync,
  environment = process.env,
} = {}) {
  const guardPath = fileURLToPath(new URL('./lib/deploy-main-guard.sh', import.meta.url));
  const commandName = 'npm run migrate:bodega-canonical-host -- --apply';
  const result = runGuard(
    'bash',
    [
      '-c',
      'source "$1"; cd "$2"; guard_deploy_main_checkout "$3" false',
      'bash',
      guardPath,
      cwd,
      commandName,
    ],
    {
      encoding: 'utf8',
      env: { ...environment, DEPLOY_ALLOW_DIRTY: '0' },
    },
  );
  if (result.status === 0) return;

  const detail =
    typeof result.stderr === 'string'
      ? result.stderr
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('To override '))
          .join('\n')
          .trim()
      : '';
  throw new Error(
    `bodega-canonical-host: --apply requires a clean main checkout at exact origin/main. ` +
      `No write performed.${detail ? `\n${detail}` : ''}`,
  );
}

export function assertReviewedDeployCredential({
  environment = process.env,
  readCredential = readFileSync,
} = {}) {
  const credentialPath = environment.GOOGLE_APPLICATION_CREDENTIALS;
  const preflightPath = environment.OP_PREFLIGHT_FIREBASE_SA_TMPFILE;
  const preflightProject = environment.OP_PREFLIGHT_FIREBASE_PROJECT;
  if (
    !credentialPath ||
    !preflightPath ||
    credentialPath !== preflightPath ||
    preflightProject !== BODEGA_PROJECT_ID
  ) {
    throw new Error(
      'bodega-canonical-host: --apply requires the exact Five Across deploy preflight credential. ' +
      'No write performed.',
    );
  }

  let credential;
  try {
    credential = JSON.parse(readCredential(credentialPath, 'utf8'));
  } catch {
    credential = null;
  }
  if (
    credential?.type !== 'service_account' ||
    credential?.project_id !== BODEGA_PROJECT_ID ||
    credential?.client_email !==
      `firebase-deployer@${BODEGA_PROJECT_ID}.iam.gserviceaccount.com`
  ) {
    throw new Error(
      'bodega-canonical-host: --apply requires the exact Five Across deploy preflight credential. ' +
        'No write performed.',
    );
  }
  return credentialPath;
}

export async function executeCanonicalHostMigration({
  apply,
  initializeFirestore = initFirestore,
  verifyReviewedSource = assertReviewedMainCheckout,
  verifyReviewedCredential = assertReviewedDeployCredential,
  environment = process.env,
  log = console.log,
} = {}) {
  if (apply) {
    verifyReviewedSource();
    verifyReviewedCredential({ environment });
  }

  // Pin both values consumed by seed.mjs's shared Admin-SDK initializer. An
  // ambient project or Event from another maintenance task cannot redirect this
  // migration, and the returned identity is checked before the first read.
  environment.GOOGLE_CLOUD_PROJECT = BODEGA_PROJECT_ID;
  environment.VITE_EVENT_ID = BODEGA_EVENT_ID;
  const { db, projectId, EVENT_ID } = await initializeFirestore({
    // `--apply` already proved GOOGLE_APPLICATION_CREDENTIALS is the reviewed
    // preflight file. Never let a repo-root key silently take precedence.
    allowLocalServiceAccountKey: !apply,
  });
  if (projectId !== BODEGA_PROJECT_ID || EVENT_ID !== BODEGA_EVENT_ID) {
    throw new Error(
      `bodega-canonical-host: refusing destination ${projectId || '(none)'}/${EVENT_ID || '(none)'}.`,
    );
  }

  const refs = BODEGA_HOSTS.map((host) => db.doc(`hostnames/${host}`));
  const initialPlan = await readPlan(db, refs);
  log(`bodega-canonical-host: project=${projectId} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  log(formatCanonicalHostPlan(initialPlan));

  if (!initialPlan.changed) return { changed: false, wrote: false };
  if (!apply) {
    log('Dry run only: no data was changed. Re-run with --apply after reviewed code is merged.');
    return { changed: true, wrote: false };
  }

  let wrote = false;
  await db.runTransaction(async (transaction) => {
    // Reset for every retry; Firestore may abandon one callback attempt after it
    // observed a write-worthy state and rerun against an already-correct state.
    wrote = false;
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const plan = planCanonicalHostMigration(rowsFromSnapshots(snapshots));
    if (!plan.changed) return;
    transaction.update(refs[BODEGA_HOSTS.indexOf(LEGACY_HOST)], plan.update);
    wrote = true;
  });

  const readback = await readPlan(db, refs);
  if (readback.changed) {
    throw new Error('bodega-canonical-host: post-commit readback did not converge.');
  }
  log(
    wrote
      ? 'bodega-canonical-host: applied and verified transactionally.'
      : 'bodega-canonical-host: another writer corrected the document first; readback verified.',
  );
  return { changed: true, wrote };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  await executeCanonicalHostMigration({ apply });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'bodega-canonical-host failed.');
    process.exitCode = 1;
  });
}
