#!/usr/bin/env node
/**
 * Validates `functions/.env.<projectId>` (merged with `functions/.env`, in
 * firebase-tools' own deploy-time file order) against the param set
 * `functions/src/params.ts` actually declares — BEFORE `firebase deploy`
 * begins.
 *
 * WHY (#767): `resolveParams` partitions purely on whether a declared
 * param's NAME is present in the merged dotenv files — a `default:` in
 * params.ts does NOT exempt it, it only supplies the interactive prompt's
 * default answer, and `firebase deploy --non-interactive` cannot answer
 * that prompt. A drifted, hand-maintained `functions/.env.<projectId>`
 * therefore hard-fails MID-DEPLOY. That happened in production on
 * 2026-08-13: `EMAIL_REPLY_TO` and `EMAIL_UNSUBSCRIBE_URL` were both
 * declared in params.ts but absent from `functions/.env.gaycruisebingo`.
 *
 * The fix mirrors PR #730's e2e answer (scripts/e2e-functions-env.mjs):
 * derive the required key set from params.ts rather than hand-restating
 * it, and fail loudly, by name, before anything is published.
 *
 * SCOPE: non-secret params only. A `defineSecret` value lives in Secret
 * Manager, never a dotenv file, so it has no presence-in-file failure
 * mode here — `functions/.env.example` excludes `RESEND_API_KEY` the
 * same way.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  declaredParamNamesAcross,
  deployDotenvFiles,
  functionsSources,
  parseDotenv,
  unassignedNames,
} from './e2e-functions-env.mjs';

/** The params.ts-declared, non-secret param set reachable from `entrypoint`. */
export function requiredDeployParams(entrypoint) {
  return declaredParamNamesAcross(functionsSources(entrypoint)).params;
}

/**
 * The dotenv assignments `firebase deploy` merges for `projectId`
 * (`deployDotenvFiles`; later files win). A missing file is skipped, like
 * the CLI's own `findEnvfiles`.
 */
export function mergedDeployEnv(functionsDir, projectId) {
  let merged = {};
  for (const file of deployDotenvFiles(projectId)) {
    const path = join(functionsDir, file);
    if (existsSync(path)) {
      merged = { ...merged, ...parseDotenv(readFileSync(path, 'utf8'), path) };
    }
  }
  return merged;
}

/**
 * Every required param absent from every deploy-merged file. Presence-only,
 * matching `resolveParams`: an explicit empty value counts as set.
 */
export function missingDeployParams(requiredParams, mergedEnv) {
  return unassignedNames(mergedEnv, requiredParams);
}

function main(argv) {
  const [functionsEntrypoint, functionsDir, projectId] = argv;
  if (!functionsEntrypoint || !functionsDir || !projectId) {
    throw new Error(
      'usage: validate-functions-env.mjs <functions/src/index.ts> <functions-dir> <projectId>',
    );
  }
  const required = requiredDeployParams(functionsEntrypoint);
  const merged = mergedDeployEnv(functionsDir, projectId);
  const missing = missingDeployParams(required, merged);
  if (missing.length > 0) {
    const checkedFiles = deployDotenvFiles(projectId)
      .map((file) => join(functionsDir, file))
      .join(', ');
    throw new Error(
      `functions/src/params.ts declares ${missing.join(', ')}, which none of [${checkedFiles}] ` +
        'assign. `firebase deploy` resolves params by presence-in-file, not by whether ' +
        'params.ts has a default — so a non-interactive deploy would hard-fail mid-deploy on ' +
        `this (the 2026-08-13 production incident this guard exists to prevent, #767). Add the ` +
        `missing key(s) to functions/.env.${projectId} before deploying.`,
    );
  }
  console.log(`functions/.env.${projectId}: every declared param (${required.length}) is present.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
