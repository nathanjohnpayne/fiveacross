---
status: accepted
implemented: false
---

# Sign-in leaves the Event origin: one central auth origin plus a single-use handoff code

> **Decision accepted; central auth and the handoff are not yet implemented.** The current app still uses its exact-host `resolveAuthDomain` allowlist; there is no `auth.fiveacrossbingo.com`, `authHandoffs/{code}` collection or function, or `VITE_AUTH_MODE` consumer. The existing same-origin path remains the only implemented authentication route.

Google validates OAuth redirect URIs **exactly**; there is no wildcard form. An Event addressed at `<slug>.vacaybingo.com` therefore can never be its own OAuth callback unless somebody registers it by hand—which is the per-event provisioning the wildcard architecture exists to abolish. Authentication will consequently be centralised on one exact registered origin, `auth.fiveacrossbingo.com`. A player will canonicalise their alias, get a cryptographically random transaction, complete Google sign-in at the central origin, receive back only an **opaque single-use handoff code** bound to the authenticated UID, target origin, and transaction, and exchange it over HTTPS for a Firebase session on the Event origin. The code will be a Firestore document (`authHandoffs/{code}`) consumed transactionally by a Cloud Function, which is what makes single-use enforceable—a stateless signed blob cannot be.

**No ID token, refresh token, or Firebase custom token may ever appear in a URL.** Replay, expiry, origin mismatch, unrecognised slugs, and open-redirect targets are all rejected.

## Consequences

- The flow must be verified on mobile Safari, mobile Chrome, an installed PWA, and a desktop tab. Safari's storage partitioning is why the naive "point `authDomain` at the central origin" shortcut is not available—this repo already carries two workarounds for that failure (`firebaseAuthOriginRedirectUrl`, the Vercel `/__/auth/:path*` rewrite).
- `authHandoffs` will be denied to all clients in rules; only the Admin SDK may touch it.
- **`VITE_AUTH_MODE=same_origin` will be a deliberate escape hatch, not dead code.** It works only for hostnames registered as exact Firebase Hosting custom domains—which is why the same-origin path is the verification baseline the handoff is proven on top of, and the recovery if sign-in breaks in the field.
- Self-service Event creation cannot ship until this path is proven, because a hostname nobody pre-registered has no other way to authenticate.
