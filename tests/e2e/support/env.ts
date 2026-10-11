// Shared constants for the x-e2e-happy-path layer: the emulator ports
// firebase.json already pins, the demo project/event this suite seeds into
// (isolated from the real `gaycruisebingo` project and the real `med-2026`
// event other tooling touches), and the dev-server URL Playwright drives.
// Imported by both `playwright.config.ts` (webServer wiring) and the spec's
// support helpers, so the two never drift apart.

/** `demo-`-prefixed per Firebase convention: the CLI/emulators treat this as
 * emulator-only and it can never resolve to a real Google Cloud project, even
 * if a client somehow reached out to the real network. */
export const PROJECT_ID = 'demo-gaycruisebingo-e2e';

/** A dedicated Event id for this suite — never the real `med-2026`. */
export const EVENT_ID = 'e2e-happy-path';

/** The Storage bucket the e2e build reads (VITE_FIREBASE_STORAGE_BUCKET).
 * Not the rules-unit-testing default, `gs://<projectId>`: since Proofs persist
 * only a `storagePath` (#1861), the app resolves media against THIS bucket, so
 * a fixture that uploads to the test-env default seeds bytes the Feed 404s on. */
export const STORAGE_BUCKET = `${PROJECT_ID}.appspot.com`;

export const FIRESTORE_PORT = 8080; // firebase.json emulators.firestore.port
export const AUTH_PORT = 9099; // firebase.json emulators.auth.port
export const STORAGE_PORT = 9199; // firebase.json emulators.storage.port

export const FIRESTORE_HOST = '127.0.0.1';
export const AUTH_EMULATOR_URL = `http://127.0.0.1:${AUTH_PORT}`;

export const WEB_PORT = 5183; // dedicated to this suite, distinct from `vite dev`'s default 5173
export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
