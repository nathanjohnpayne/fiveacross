// Real Firebase Auth persistence on two test origins in one browser context.
// Application data/watchers are local fixtures; no production sign-in or API.
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { PROJECT_ID, AUTH_EMULATOR_URL } from './support/env';

const emulatorUrl = process.env.LOGOUT_AUTH_EMULATOR_URL ?? AUTH_EMULATOR_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(emulatorUrl)) throw new Error('local Auth emulator required');

const ALIAS = 'https://gaycruisebingo.web.app';
const CANONICAL = 'https://gaycruisebingo.firebaseapp.com';

async function harnessBundle(): Promise<string> {
  // The local emulator accepts unsigned JWTs; keep the fixture in the SDK's
  // real custom-token shape instead of depending on its raw-JSON shortcut.
  const issuedAt = Math.floor(Date.now() / 1000);
  const seedToken = [
    { alg: 'none', typ: 'JWT' },
    { uid: 'dual-origin-logout', iat: issuedAt, exp: issuedAt + 3600,
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit' },
  ].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.';
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { signInWithCustomToken } from 'firebase/auth';
    import { auth } from './src/firebase';
    import { AuthProvider, useAuth } from './src/auth/AuthContext';
    function Harness() {
      const { user, signOutUser } = useAuth();
      return <><span id="user">{user?.uid ?? 'signed out'}</span>
        <button onClick={() => void signOutUser()}>Sign out</button></>;
    }
    window.fixture = {
      ready: auth.authStateReady(),
      uid: () => auth.currentUser?.uid ?? null,
      seed: () => signInWithCustomToken(auth, ${JSON.stringify(seedToken)}),
      mount: () => createRoot(document.getElementById('root')).render(<AuthProvider><Harness /></AuthProvider>)
    };
  `;
  const nullComponent = 'export default function Fixture(){ return null; }';
  const replacements = new Map([
    ['src/firebase.ts', `import {initializeApp} from 'firebase/app'; import {getAuth,connectAuthEmulator} from 'firebase/auth';
      export const auth=getAuth(initializeApp({apiKey:'demo-api-key',projectId:${JSON.stringify(PROJECT_ID)},authDomain:'demo.firebaseapp.com'}));
      connectAuthEmulator(auth,${JSON.stringify(emulatorUrl)},{disableWarnings:true});
      export const EVENT_ID='logout-fixture'; export const googleProvider={};`],
    ['src/data/api.ts', `export const ensureUserProfile=async()=>{}; export const attestAdult=async()=>{};
      export const hasCachedBoard=async()=>false; export const hasCachedCard=async()=>false;
      export const joinAndDeal=async()=>({}); export const readAdultAttestationFromCache=async()=>null;
      export const readAdultAttestationFromServer=async()=>null;`],
    ['src/data/eventInvitations.ts', 'export const redeemEventInvitation=async()=>{throw new Error("unexpected invitation");};'],
    ['src/analytics.ts', 'export const track=()=>{};'],
    ['src/adultContent.ts', 'export const adultContentRequired=()=>false;'],
    ['src/hooks/useAdultContent.ts', 'export const useAdultContent=()=>false;'],
    ['src/hooks/useBlocks.tsx', 'export const HiddenUidsProvider=({children})=>children;'],
    ...['SignIn','ConfirmWinMoments','RetractWinMoments','PoolRecoveryWatcher','AdultContentWatcher']
      .map(name => [`src/components/${name}.tsx`, nullComponent] as [string,string]),
  ]);
  const result = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [{ name: 'local-logout-data-fixtures', setup(builder) {
      builder.onLoad({ filter: /\.[jt]sx?$/ }, args => {
        const key = [...replacements.keys()].find(path => args.path === resolve(path));
        return key ? { contents: replacements.get(key), loader: 'tsx', resolveDir: process.cwd() } : undefined;
      });
    } }],
  });
  return result.outputFiles[0].text;
}

test('explicit alias logout stays signed out across navigation and reload beside a persisted canonical session', async ({context}) => {
  const bundle = await harnessBundle();
  // Forward emulator transport through the test runner to avoid public-name
  // to loopback network permission prompts; the real emulator still handles it.
  await context.route(`${emulatorUrl}/**`, async route => {
    await route.fulfill({ response: await route.fetch() });
  });
  // These names never resolve over the network: all documents/resources for
  // both origins are fulfilled locally, and Firebase uses only the demo emulator.
  await context.route(/^https:\/\/gaycruisebingo\.(web\.app|firebaseapp\.com)\//, async route => {
    if (new URL(route.request().url()).pathname === '/fixture.js') {
      await route.fulfill({contentType:'application/javascript',body:bundle});
    } else {
      await route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/fixture.js"></script>'});
    }
  });
  const canonical = await context.newPage();
  await canonical.goto(CANONICAL);
  await canonical.evaluate(async () => {
    const fixture = (window as unknown as {fixture:{ready:Promise<void>;seed():Promise<void>;mount():void}}).fixture;
    await fixture.ready; await fixture.seed(); fixture.mount();
  });
  await expect(canonical.locator('#user')).toHaveText('dual-origin-logout');

  const alias = await context.newPage();
  await alias.goto(ALIAS);
  await alias.evaluate(async () => {
    const fixture = (window as unknown as {fixture:{ready:Promise<void>;seed():Promise<void>;mount():void}}).fixture;
    await fixture.ready; await fixture.seed(); fixture.mount();
    history.pushState({},'', '/more?tab=stats');
  });
  await expect(alias.locator('#user')).toHaveText('dual-origin-logout');
  await alias.getByRole('button',{name:'Sign out'}).click();
  await expect(alias.locator('#user')).toHaveText('signed out');
  await expect(alias).toHaveURL(`${ALIAS}/more?tab=stats`);
  await alias.reload();
  await alias.evaluate(async () => {
    const fixture = (window as unknown as {fixture:{ready:Promise<void>;mount():void}}).fixture;
    await fixture.ready; fixture.mount();
  });
  await expect(alias.locator('#user')).toHaveText('signed out');
  // Covers the delayed automatic-hop path in addition to the null SDK callback.
  await alias.waitForTimeout(3_100);
  await expect(alias).toHaveURL(`${ALIAS}/more?tab=stats`);
  await canonical.reload();
  await canonical.evaluate(async () => {
    const fixture = (window as unknown as {fixture:{ready:Promise<void>;mount():void}}).fixture;
    await fixture.ready; fixture.mount();
  });
  await expect(canonical.locator('#user')).toHaveText('dual-origin-logout');
});
