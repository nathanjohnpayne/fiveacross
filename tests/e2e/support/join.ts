// The zero-coordination join path this suite proves: land on the app's one
// URL (the "shared link" — no invite code, no admin-issued token, see
// CONTEXT.md), accept the 18+ acknowledgement, and sign in. Shared by both
// x-e2e-happy-path cases so the join flow is asserted in exactly one place.
//
// The edition-neutral mechanics — the emulator widget, the CDN stubs, the gapi
// disk cache, the uid readback — now live in tests/support/emulator-signin.ts
// so the marketing capture harness can reuse them instead of keeping a second
// copy (Codex P1 on #1020). What stays here is what is specific to THIS gate:
// the Gay Cruise Bingo wordmark assertion and the 18+ acknowledgement.
import { expect, type Page } from '@playwright/test';
import {
  completeEmulatorSignIn,
  dismissConsentNotice,
  signedInUid,
  stubAuthWidgetCdn,
} from '../../support/emulator-signin';

// Re-exported so the many specs that already import it from here keep working.
export { signedInUid };

/**
 * Land on the shared link, accept the 18+ acknowledgement, and sign in —
 * the ONLY path into the app (no admin action anywhere, PRD's headline
 * zero-coordination metric). Resolves once the signed-in shell (the
 * Primary tab bar) renders, i.e. `App.tsx` has moved past `<SignIn />`.
 */
export async function joinViaSharedLink(page: Page): Promise<void> {
  await stubAuthWidgetCdn(page); // popups inherit the context's routes
  await page.goto('/');
  await dismissConsentNotice(page);

  await expect(page.getByRole('heading', { name: 'GAY CRUISE BINGO' })).toBeVisible();
  await page.getByRole('checkbox').check();

  // "Continue with Google" calls signInWithPopup against the Auth Emulator, so
  // wait for the popup the click opens, then drive the emulator's widget.
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await completeEmulatorSignIn(await popupPromise);

  // Signed in: App.tsx has moved past <SignIn /> to the signed-in shell (the
  // Primary tab bar). A failure here now means the emulator sign-in did not
  // resolve, not the retired src/firebase.ts wiring gap.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 15000 });
}
