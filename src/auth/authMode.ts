/**
 * Which route sign-in takes on this origin, and the `VITE_AUTH_MODE` escape
 * hatch that overrides it (#549, ADR 0010).
 *
 * This module is the ONE place that answers "can this browser complete a
 * sign-in from here, and how" — the pre-mount gate in `main.tsx` and the Sign in
 * button both read the same result, so the screen a player sees and the action
 * the button takes can never disagree.
 *
 * THE MODES ARE NOT TWO IMPLEMENTATIONS OF THE SAME THING. `handoff` is the
 * architecture (ADR 0010): a wildcard Event host can never be its own OAuth
 * callback, so sign-in happens once at a central registered origin and the
 * player is carried back. `same_origin` is the recovery lever — it refuses to
 * leave this origin at all, which is correct only where the OAuth helper is
 * already same-origin. Flipping it is an env change plus a redeploy, and the
 * whole reason it exists is that it is the path already proven in production.
 *
 * NO SILENT FALLBACK BETWEEN THEM. Every way this can fail returns
 * `unavailable` with a named reason that reaches the player as its own screen.
 * A mode that cannot work here must say so at mount, because the alternative —
 * discovering it mid-sign-in — is a Google button that dead-ends on a phone in a
 * rental house, unrecoverable by the player and silent to us.
 */
import { isSignInReachableOnHost } from '../auth-domain';

export type AuthMode = 'handoff' | 'same_origin';

/**
 * `handoff` unless told otherwise.
 *
 * The default is the architecture, not the escape hatch: an unset
 * `VITE_AUTH_MODE` has to be correct for the wildcard Event hosts that cannot
 * sign in any other way, and those are precisely the builds nobody hand-tunes.
 */
export const DEFAULT_AUTH_MODE: AuthMode = 'handoff';

const AUTH_MODES: readonly string[] = ['handoff', 'same_origin'];

export type SignInUnavailableReason =
  /** `VITE_AUTH_MODE` held something that is not a mode. */
  | 'auth-mode-invalid'
  /** `same_origin` was selected on a host whose OAuth helper is not same-origin. */
  | 'same-origin-host-unregistered'
  /** `handoff` is in force but the build names no central auth origin. */
  | 'handoff-origin-unconfigured'
  /** The configured central auth origin is not a usable https origin. */
  | 'handoff-origin-invalid';

export type SignInStrategy =
  /**
   * Sign in here, through the existing same-origin path — `AuthContext.signIn`
   * unchanged. Reached on registered first-party hosts, on local/e2e origins,
   * and on hosts that already carry their own documented redirect
   * (`gaycruisebingo.web.app` → `firebaseapp.com`).
   */
  | { kind: 'direct' }
  /** Leave for the central auth origin and come back with a handoff code. */
  | { kind: 'handoff'; authOrigin: string; targetOrigin: string; returnPath: string }
  /** Sign-in cannot complete from this origin under this mode. Say so, loudly. */
  | { kind: 'unavailable'; reason: SignInUnavailableReason };

/**
 * `VITE_AUTH_MODE`, or `null` if it held something unrecognised.
 *
 * An unset value is the default; a MISSPELLED value is not. Treating
 * `VITE_AUTH_MODE=sameorigin` as "handoff, then" would silently ignore a
 * deliberate operator instruction issued during an incident, which is the exact
 * moment the operator is least able to tell that it was ignored.
 */
export function parseAuthMode(raw: string | undefined | null): AuthMode | null {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_AUTH_MODE;
  return AUTH_MODES.includes(value) ? (value as AuthMode) : null;
}

/**
 * The configured central auth origin, normalised, or `null` if unusable.
 *
 * Required to be plain https with no path, query, fragment, or credentials —
 * enforced by comparing against `URL.origin`, which is a normalisation, so one
 * comparison rejects every decoration at once with no list to keep current.
 * (The server applies the same rule to the target origin; this is the mirror of
 * it applied to the one origin the CLIENT chooses to navigate to.)
 *
 * `http://localhost:*` is accepted so a developer can stand the flow up against
 * emulators; the server's own origin policy independently refuses loopback
 * unless it is running under an emulator, so this arm cannot widen production.
 */
export function parseAuthOrigin(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (url.username !== '' || url.password !== '') return null;
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) return null;
  if (!isLoopback && url.port !== '') return null;
  return url.origin;
}

export interface SignInStrategyInput {
  /** Raw `VITE_AUTH_MODE`. */
  mode: string | undefined;
  /** Raw `VITE_FIREBASE_AUTH_DOMAIN` — the value baked into this build. */
  configuredAuthDomain: string;
  /** `window.location.hostname`. */
  hostname: string;
  /** Raw `VITE_AUTH_HANDOFF_ORIGIN`. */
  handoffOrigin: string | undefined;
  /** `window.location.origin` — the entry origin the handoff must return to. */
  currentOrigin: string;
  /** Where in the app to land on return; `'/'` when there is nothing to preserve. */
  returnPath: string;
}

/**
 * Which route sign-in takes from here.
 *
 * The ordering is load-bearing. `isSignInReachableOnHost` is consulted FIRST,
 * before either mode branches, because a host whose OAuth helper is already
 * same-origin needs no handoff in either mode — `gaycruisebingo` is one
 * registered origin that signs in same-origin and never mints a handoff
 * (`specs/auth-handoff.md`), and the local/e2e origins must keep signing in
 * against the Auth Emulator exactly as they do today. Reusing that predicate
 * rather than restating it is deliberate: a second copy of "is the helper
 * same-origin here" is a second thing to drift.
 *
 * Only once that is false do the modes differ at all — and that difference IS
 * the escape hatch's entire observable behaviour:
 *
 *   - `handoff` carries the player to the central origin and back.
 *   - `same_origin` refuses, by name, because it has nowhere same-origin to go.
 */
export function resolveSignInStrategy(input: SignInStrategyInput): SignInStrategy {
  const mode = parseAuthMode(input.mode);
  if (mode === null) return { kind: 'unavailable', reason: 'auth-mode-invalid' };

  if (isSignInReachableOnHost(input.configuredAuthDomain, input.hostname)) {
    return { kind: 'direct' };
  }

  if (mode === 'same_origin') {
    return { kind: 'unavailable', reason: 'same-origin-host-unregistered' };
  }

  const raw = (input.handoffOrigin ?? '').trim();
  if (raw === '') return { kind: 'unavailable', reason: 'handoff-origin-unconfigured' };
  const authOrigin = parseAuthOrigin(raw);
  if (authOrigin === null) return { kind: 'unavailable', reason: 'handoff-origin-invalid' };

  // A build that points its handoff at the origin it is already serving would
  // bounce the player off themselves forever. That is a misconfiguration, not a
  // route: the central origin is registered, so it reaches `direct` above and
  // never arrives here — getting here means the two disagree.
  if (authOrigin === input.currentOrigin) {
    return { kind: 'unavailable', reason: 'handoff-origin-invalid' };
  }

  return {
    kind: 'handoff',
    authOrigin,
    targetOrigin: input.currentOrigin,
    returnPath: input.returnPath,
  };
}
