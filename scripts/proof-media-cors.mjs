import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import { configForTarget } from './build-target.mjs';

// CORS enables browser SDK reads; Auth, App Check and Storage Rules still
// authorize every download. Wildcard origins cover dynamic Event hostnames.
export const PROOF_MEDIA_CORS = Object.freeze({
  origin: ['*'], method: ['GET'], maxAgeSeconds: 3600,
});

const permitsSdkRead = rule => Array.isArray(rule?.origin) && rule.origin.includes('*')
  && Array.isArray(rule.method) && rule.method.includes('GET');

/** Preserve unrelated rules and use bucket metageneration CAS, never object writes. */
export async function reconcileProofMediaCors(target, request) {
  const config = configForTarget(target);
  const bucket = config.identity.VITE_FIREBASE_STORAGE_BUCKET;
  const projectNumber = config.identity.VITE_FIREBASE_MESSAGING_SENDER_ID;
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`;
  const read = async () => {
    const metadata = await request({ url, method: 'GET' });
    if (metadata?.name !== bucket || String(metadata.projectNumber) !== projectNumber
      || !/^[1-9][0-9]*$/.test(String(metadata.metageneration))
      || (metadata.cors !== undefined && !Array.isArray(metadata.cors))) {
      throw new Error('Storage bucket identity or CORS metadata is invalid.');
    }
    return metadata;
  };
  const before = await read();
  const prior = before.cors ?? [];
  if (prior.some(permitsSdkRead)) return { bucket, changed: false };
  await request({
    url, method: 'PATCH', params: { ifMetagenerationMatch: before.metageneration },
    data: { cors: [...prior, PROOF_MEDIA_CORS] },
  });
  const after = await read();
  if (!after.cors?.some(permitsSdkRead)
    || !prior.every(rule => after.cors.some(actual => isDeepStrictEqual(rule, actual)))) {
    throw new Error('Storage bucket CORS readback did not preserve and verify the policy.');
  }
  return { bucket, changed: true };
}

async function main() {
  const [target, mode, ...extra] = process.argv.slice(2);
  const config = configForTarget(target);
  if (extra.length || (mode !== undefined && mode !== '--project')) throw new Error('Invalid CORS arguments.');
  if (mode === '--project') { console.log(config.firebaseProject); return; }
  // Explicit preflight/materialized input only: never silently use local ADC.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Deploy credential preflight is required.');
  const auth = new GoogleAuth({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/devstorage.full_control'],
  });
  const result = await reconcileProofMediaCors(target, async options =>
    (await auth.request({ ...options, timeout: 15_000, retry: false })).data);
  console.log(`Verified SDK-read CORS for ${result.bucket} (${result.changed ? 'updated' : 'already configured'}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // SDK errors may include request headers/credential context; never echo them.
    console.error('Proof-media CORS readiness failed; nothing has been built or published. Check target identity, credentials and storage.buckets.get/update permissions.');
    process.exitCode = 1;
  });
}
