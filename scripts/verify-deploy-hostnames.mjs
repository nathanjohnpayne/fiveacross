import { GoogleAuth } from 'google-auth-library';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BODEGA_EVENT_ID, BODEGA_PREVIEW_HOSTS, BODEGA_PROJECT_ID } from './provision-bodega-preview.mjs';

const fieldMask = '?mask.fieldPaths=eventId&mask.fieldPaths=status';
const datastoreScopes = Object.freeze(['https://www.googleapis.com/auth/datastore']);
const applicationDefaultAccessTokenTimeoutMs = 10_000;

class ApplicationDefaultAccessTokenTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Application Default Credentials access token acquisition timed out after ${timeoutMs} ms.`);
    this.name = 'ApplicationDefaultAccessTokenTimeoutError';
  }
}

function assertFiveAcrossProject(projectId) {
  if (projectId !== BODEGA_PROJECT_ID) {
    throw new Error(`Five Across project must be ${BODEGA_PROJECT_ID}.`);
  }
}

function withApplicationDefaultAccessTokenTimeout(work, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApplicationDefaultAccessTokenTimeoutError(timeoutMs)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function getApplicationDefaultAccessToken(
  createAuth = (options) => new GoogleAuth(options),
  timeoutMs = applicationDefaultAccessTokenTimeoutMs,
) {
  const accessToken = await withApplicationDefaultAccessTokenTimeout(
    Promise.resolve(createAuth({ scopes: [...datastoreScopes] }).getAccessToken()),
    timeoutMs,
  );
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Application Default Credentials returned no access token.');
  }
  return accessToken;
}

export async function verifyBodegaHostnameDocuments({ projectId, accessToken, fetchImpl = fetch }) {
  assertFiveAcrossProject(projectId);
  for (const host of BODEGA_PREVIEW_HOSTS) {
    const url =
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
      `/databases/(default)/documents/hostnames/${encodeURIComponent(host)}${fieldMask}`;
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(`Hostname document read failed for ${host}.`);
    }
    if (response.status === 404) {
      throw new Error(`Hostname document is missing for ${host}.`);
    }
    if (!response.ok) {
      throw new Error(`Hostname document read failed for ${host} (HTTP ${response.status}).`);
    }
    let document;
    try {
      document = await response.json();
    } catch {
      throw new Error(`Hostname document is malformed for ${host}.`);
    }
    const expectedName = `projects/${BODEGA_PROJECT_ID}/databases/(default)/documents/hostnames/${host}`;
    if (
      document?.name !== expectedName ||
      typeof document?.fields?.eventId?.stringValue !== 'string' ||
      typeof document?.fields?.status?.stringValue !== 'string'
    ) {
      throw new Error(`Hostname document is malformed for ${host}.`);
    }
    if (document.fields.status.stringValue !== 'active') {
      throw new Error(`Hostname document is not active for ${host}.`);
    }
    if (document.fields.eventId.stringValue !== BODEGA_EVENT_ID) {
      throw new Error(`Hostname document resolves to the wrong Event for ${host}.`);
    }
  }
  return BODEGA_PREVIEW_HOSTS;
}

export async function runBodegaHostnameVerification({
  projectId = process.env.GOOGLE_CLOUD_PROJECT,
  acquireAccessToken = () => getApplicationDefaultAccessToken(),
  verifyDocuments = verifyBodegaHostnameDocuments,
} = {}) {
  assertFiveAcrossProject(projectId);

  let accessToken;
  try {
    accessToken = await acquireAccessToken();
  } catch (error) {
    if (error instanceof ApplicationDefaultAccessTokenTimeoutError) throw error;
    throw new Error('Unable to obtain the Five Across deploy access token.');
  }

  return verifyDocuments({ projectId, accessToken });
}

export async function runBodegaHostnameVerificationCommand(options) {
  try {
    const hosts = await runBodegaHostnameVerification(options);
    console.log(`Verified ${hosts.length} serving Bodega hostname documents.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Five Across hostname verification failed.';
    if (error instanceof ApplicationDefaultAccessTokenTimeoutError) {
      // GoogleAuth does not expose an abort signal for getAccessToken(). The
      // promise deadline above controls the diagnostic; this hard CLI boundary
      // also terminates any transport handle the abandoned exchange retained.
      // A synchronous write guarantees the timeout reason reaches CI/operator
      // logs before process.exit() tears that handle down.
      writeSync(process.stderr.fd, `${message}\n`);
      process.exit(1);
    }
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBodegaHostnameVerificationCommand();
}
