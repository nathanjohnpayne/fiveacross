// Real cross-context proof for specs/auth-handoff-client.md Leg 3 (#1060).
// Two same-origin tabs redeem distinct Auth Emulator custom-token credentials
// for the same uid through the production dedicated Worker. Attempt-specific
// emulator claims make their refresh tokens deterministically different.
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { HANDOFF_TRANSACTION_KEY } from '../../src/auth/handoffTransaction';
import { BASE_URL } from './support/env';

const FIRST_CODE = 'A'.repeat(43);
const SECOND_CODE = 'B'.repeat(43);
const FIRST_VERIFIER = 'V'.repeat(43);
const SECOND_VERIFIER = 'W'.repeat(43);
const UID = 'same-user-worker-adoption';

interface SessionFingerprint {
  uid: string;
  refreshTokenDigest: string;
}

interface PreparedAttempt extends SessionFingerprint {
  ownerNonce: string;
}

async function capturePreparedWorkerCandidate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    class ObservedWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (typeof event.data !== 'object' || event.data === null) return;
          const message = event.data as Record<string, unknown>;
          if (
            message.type !== 'prepared' ||
            typeof message.attempt !== 'object' ||
            message.attempt === null ||
            typeof message.candidate !== 'object' ||
            message.candidate === null
          ) {
            return;
          }
          const attempt = message.attempt as Record<string, unknown>;
          const candidate = message.candidate as Record<string, unknown>;
          if (
            typeof attempt.ownerNonce !== 'string' ||
            typeof candidate.uid !== 'string' ||
            typeof candidate.refreshTokenDigest !== 'string'
          ) {
            return;
          }
          (
            window as unknown as { __authHandoffPreparedE2E?: PreparedAttempt }
          ).__authHandoffPreparedE2E = {
            ownerNonce: attempt.ownerNonce,
            uid: candidate.uid,
            refreshTokenDigest: candidate.refreshTokenDigest,
          };
        });
      }
    }
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      writable: true,
      value: ObservedWorker,
    });
  });
}

async function preparedAttempt(page: Page): Promise<PreparedAttempt> {
  await page.waitForFunction(() => '__authHandoffPreparedE2E' in window, undefined, {
    timeout: 20_000,
  });
  return page.evaluate(
    () =>
      (
        window as unknown as { __authHandoffPreparedE2E: PreparedAttempt }
      ).__authHandoffPreparedE2E,
  );
}

async function freshPageAuthFingerprint(
  page: Page,
  ownerNonce: string,
): Promise<SessionFingerprint | null> {
  await page.waitForFunction(() => '__authHandoffFingerprintE2E' in window, undefined, {
    timeout: 20_000,
  });
  return page.evaluate(
    (nonce) =>
      (
        window as unknown as {
          __authHandoffFingerprintE2E: (
            ownerNonce: string,
          ) => Promise<SessionFingerprint | null>;
        }
      ).__authHandoffFingerprintE2E(nonce),
    ownerNonce,
  );
}

function fakeCustomToken(attempt: string): string {
  // The Auth Emulator explicitly accepts strict JSON as a fake custom token.
  // Different claims are encoded into distinct refresh tokens for the same uid.
  return JSON.stringify({ uid: UID, claims: { handoffAttempt: attempt } });
}

async function installExchangeStub(
  context: BrowserContext,
  seenCodes: string[],
  firstExchange: { started(): void; release: Promise<void> },
): Promise<void> {
  await context.route(/\/exchangeAuthHandoff$/, async (route: Route) => {
    const origin = new URL(route.request().url()).origin;
    const cors = {
      'access-control-allow-origin': BASE_URL,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers':
        'authorization, content-type, x-client-version, x-firebase-appcheck, x-firebase-gmpid',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (origin !== 'http://127.0.0.1:5001') {
      throw new Error(`Unexpected callable origin: ${origin}`);
    }
    const body = route.request().postDataJSON() as { data?: { code?: string } };
    const code = body.data?.code ?? '';
    seenCodes.push(code);
    if (code === FIRST_CODE) {
      firstExchange.started();
      await firstExchange.release;
    }
    const attempt = code === FIRST_CODE ? 'first' : 'second';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify({ data: { customToken: fakeCustomToken(attempt) } }),
    });
  });
}

async function armReturn(page: Page, code: string, verifier: string): Promise<void> {
  const createdAt = Date.now();
  await page.addInitScript(
    ({ key, value }) => sessionStorage.setItem(key, value),
    {
      key: HANDOFF_TRANSACTION_KEY,
      value: JSON.stringify({
        verifier,
        targetOrigin: BASE_URL,
        returnPath: '/',
        acknowledgedAdultContent: false,
        createdAt,
      }),
    },
  );
  await page.goto(`/#fa_handoff=${code}`);
}

test('a delayed older tab cannot claim or erase the exact same-uid winner', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const seenCodes: string[] = [];
  let markFirstExchangeStarted = () => {};
  const firstExchangeStarted = new Promise<void>((resolve) => {
    markFirstExchangeStarted = resolve;
  });
  let releaseFirstExchange = () => {};
  const firstExchangeRelease = new Promise<void>((resolve) => {
    releaseFirstExchange = resolve;
  });
  await installExchangeStub(context, seenCodes, {
    started: () => markFirstExchangeStarted(),
    release: firstExchangeRelease,
  });

  const olderAssets: string[] = [];
  page.on('request', (request) => olderAssets.push(new URL(request.url()).pathname));
  await capturePreparedWorkerCandidate(page);
  const firstWorker = page.waitForEvent('worker');
  const olderReturn = armReturn(page, FIRST_CODE, FIRST_VERIFIER);
  expect((await firstWorker).url()).toMatch(/handoffCommit\.worker/);
  await firstExchangeStarted;
  expect(seenCodes).toEqual([FIRST_CODE]);
  expect(olderAssets.some((path) => /\/firebaseAuth-[^/]+\.js$/.test(path))).toBe(false);

  const returnPage = await context.newPage();
  const winnerAssets: string[] = [];
  returnPage.on('request', (request) => winnerAssets.push(new URL(request.url()).pathname));
  await capturePreparedWorkerCandidate(returnPage);
  const secondWorker = returnPage.waitForEvent('worker');
  await armReturn(returnPage, SECOND_CODE, SECOND_VERIFIER);
  expect((await secondWorker).url()).toMatch(/handoffCommit\.worker/);
  const winner = await preparedAttempt(returnPage);
  expect(seenCodes).toEqual([FIRST_CODE, SECOND_CODE]);

  await expect(returnPage.locator('.boot-loader')).toHaveCount(0, { timeout: 20_000 });
  await expect(returnPage.getByRole('heading', { name: 'Finish signing in' })).toHaveCount(0);
  expect(new URL(returnPage.url()).hash).toBe('');
  const workerAssetIndex = winnerAssets.findIndex((path) => /\/handoffCommit\.worker-[^/]+\.js$/.test(path));
  const pageAuthAssetIndex = winnerAssets.findIndex((path) => /\/firebaseAuth-[^/]+\.js$/.test(path));
  expect(workerAssetIndex).toBeGreaterThanOrEqual(0);
  expect(pageAuthAssetIndex).toBeGreaterThan(workerAssetIndex);

  const freshPage = await context.newPage();
  await freshPage.goto('/');
  await expect
    .poll(() => freshPageAuthFingerprint(freshPage, winner.ownerNonce), { timeout: 20_000 })
    .toEqual({ uid: winner.uid, refreshTokenDigest: winner.refreshTokenDigest });

  releaseFirstExchange();
  await olderReturn;
  const older = await preparedAttempt(page);
  await expect(page.locator('.boot-loader')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Finish signing in' })).toHaveCount(0);

  expect(winner.uid).toBe(UID);
  expect(older.uid).toBe(winner.uid);
  const winnerUnderOlderNonce = await freshPageAuthFingerprint(freshPage, older.ownerNonce);
  expect(winnerUnderOlderNonce?.uid).toBe(older.uid);
  expect(winnerUnderOlderNonce?.refreshTokenDigest).not.toBe(older.refreshTokenDigest);
  await expect
    .poll(() => freshPageAuthFingerprint(page, winner.ownerNonce), { timeout: 20_000 })
    .toEqual({ uid: winner.uid, refreshTokenDigest: winner.refreshTokenDigest });
  await expect
    .poll(() => freshPageAuthFingerprint(freshPage, winner.ownerNonce), { timeout: 20_000 })
    .toEqual({ uid: winner.uid, refreshTokenDigest: winner.refreshTokenDigest });
});
