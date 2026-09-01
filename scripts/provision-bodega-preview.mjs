// Provision the public sign-in postcard for every live Bodega serving host.
//
// Dry-run is the DEFAULT. It reads and validates every expected hostname doc,
// then prints the exact update plan. Only --apply writes, and that write runs
// in one Firestore transaction: a missing, inactive, or repointed hostname
// aborts the whole operation instead of creating or partially changing a route.
//
// Usage (after the deploy credential preflight):
//   GOOGLE_CLOUD_PROJECT=fiveacross npm run provision:bodega-preview
//   GOOGLE_CLOUD_PROJECT=fiveacross npm run provision:bodega-preview -- --apply
//
// The Admin SDK initialization deliberately reuses scripts/seed.mjs. That keeps
// its service-account/ADC resolution and explicit-project discipline in one
// place rather than allowing a postcard maintenance command to drift into a
// differently authenticated production write.
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { initFirestore } from './seed.mjs';

export const BODEGA_EVENT_ID = 'bodega-bay-2026';
export const BODEGA_PROJECT_ID = 'fiveacross';

// Every host that currently serves the live Bodega Event (README "Where it
// runs"). These are explicit rather than queried: `hostnames` deliberately
// forbids collection-list reads to clients, and a maintenance command should
// not silently extend a public surface when a new routing document appears.
export const BODEGA_PREVIEW_HOSTS = Object.freeze([
  'bodega-bay.fiveacross.app',
  'bodega-bay.vacaybingo.com',
  'fiveacross.app',
]);

// Public display copy only. It mirrors the #647 wireframe and has no
// membership, roster, card, or Prompt-pool data; hostname documents are
// intentionally world-readable before sign-in (specs/hostnames-lookup.md).
export const BODEGA_EVENT_PREVIEW = Object.freeze({
  eventName: 'Weekend in Bodega Bay',
  dateRange: 'Aug 7–9',
  hostedBy: 'Kim',
  days: Object.freeze([
    Object.freeze({ date: '2026-08-07', title: 'The Birds Have Entered the Chat', emoji: '🐦' }),
    Object.freeze({ date: '2026-08-08', title: 'Side Quests' }),
    Object.freeze({ date: '2026-08-09', title: 'Fog, Froth & Farewells' }),
  ]),
});

/** Validate the fixed Bodega serving inventory shared by every maintenance path. */
export function validateBodegaServingInventory(
  hostDocs,
  { operation = 'bodega-inventory' } = {},
) {
  const rows = new Map();
  for (const row of hostDocs) {
    if (!row || typeof row.host !== 'string') {
      throw new Error(`${operation}: invalid hostname read. No write performed.`);
    }
    if (rows.has(row.host)) {
      throw new Error(
        `${operation}: duplicate hostname read for ${row.host}. No write performed.`,
      );
    }
    rows.set(row.host, row.data ?? null);
  }

  for (const host of BODEGA_PREVIEW_HOSTS) {
    const data = rows.get(host);
    if (!data || typeof data !== 'object') {
      throw new Error(`${operation}: hostnames/${host} is missing. No write performed.`);
    }
    if (data.eventId !== BODEGA_EVENT_ID) {
      throw new Error(
        `${operation}: hostnames/${host} targets ${String(data.eventId)}; expected ${BODEGA_EVENT_ID}. ` +
          'No write performed.',
      );
    }
    if (data.status !== 'active') {
      throw new Error(
        `${operation}: hostnames/${host} is ${String(data.status)}; ` +
          'only an active serving host may be changed. No write performed.',
      );
    }
  }
  return rows;
}

/**
 * Validate the complete hostname set and calculate the strictly-scoped write.
 *
 * `hostDocs` deliberately takes plain values so this safety boundary can be
 * tested without credentials or the Admin SDK. Each row is `{ host, data }`,
 * where `data` is `null` for a document that was not found.
 */
export function planBodegaPreviewProvisioning(hostDocs) {
  const rows = validateBodegaServingInventory(hostDocs, { operation: 'bodega-preview' });

  const updates = [];
  const alreadyCorrect = [];
  for (const host of BODEGA_PREVIEW_HOSTS) {
    const data = rows.get(host);
    if (isDeepStrictEqual(data.preview, BODEGA_EVENT_PREVIEW)) {
      alreadyCorrect.push(host);
    } else {
      updates.push(host);
    }
  }
  return { updates, alreadyCorrect };
}

export function formatBodegaPreviewPlan(plan) {
  const changeLine = plan.updates.length
    ? `will update: ${plan.updates.join(', ')}`
    : 'all configured hosts already carry the approved preview';
  const unchangedLine = plan.alreadyCorrect.length
    ? `already correct: ${plan.alreadyCorrect.join(', ')}`
    : null;
  return [changeLine, unchangedLine].filter(Boolean).join('\n');
}

function rowsFromSnapshots(snapshots) {
  return snapshots.map((snapshot, index) => ({
    host: BODEGA_PREVIEW_HOSTS[index],
    data: snapshot.exists ? snapshot.data() : null,
  }));
}

async function readPlan(db, refs) {
  const snapshots = await db.getAll(...refs);
  return planBodegaPreviewProvisioning(rowsFromSnapshots(snapshots));
}

async function applyPlan(db, refs) {
  return db.runTransaction(async (transaction) => {
    // All reads precede all writes. Firestore retries the transaction if any
    // validated hostname changes while this command is deciding to update it.
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const plan = planBodegaPreviewProvisioning(rowsFromSnapshots(snapshots));
    for (const host of plan.updates) {
      transaction.update(db.doc(`hostnames/${host}`), { preview: BODEGA_EVENT_PREVIEW });
    }
    return plan;
  });
}

function parseArgs(args) {
  const unknown = args.filter((arg) => arg !== '--apply');
  if (unknown.length) {
    throw new Error(`bodega-preview: unknown argument(s): ${unknown.join(', ')}. Only --apply is accepted.`);
  }
  return { apply: args.includes('--apply') };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  // Require the explicit project environment before even initializing the Admin
  // SDK. A missing variable must not fall back to .firebaserc's Gay Cruise
  // Bingo default, even for a read-only dry run.
  if (process.env.GOOGLE_CLOUD_PROJECT !== BODEGA_PROJECT_ID) {
    throw new Error(
      `bodega-preview: refusing project ${process.env.GOOGLE_CLOUD_PROJECT || '(none)'}. Set GOOGLE_CLOUD_PROJECT=${BODEGA_PROJECT_ID}.`,
    );
  }
  const { db, projectId } = await initFirestore();
  if (projectId !== BODEGA_PROJECT_ID) {
    throw new Error(
      `bodega-preview: refusing project ${projectId || '(none)'}. Set GOOGLE_CLOUD_PROJECT=${BODEGA_PROJECT_ID}.`,
    );
  }

  const refs = BODEGA_PREVIEW_HOSTS.map((host) => db.doc(`hostnames/${host}`));
  const plan = apply ? await applyPlan(db, refs) : await readPlan(db, refs);
  console.log(`bodega-preview: project=${projectId} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(formatBodegaPreviewPlan(plan));
  if (!apply && plan.updates.length) {
    console.log('Dry run only: no data was changed. Re-run with --apply after reviewing this plan.');
  }
  if (apply && plan.updates.length) {
    console.log('Applied transactionally. The sign-in postcard is now present on every configured serving host.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
