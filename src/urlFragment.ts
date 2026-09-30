/**
 * Remove the current fragment without navigating, then verify no sensitive
 * value survived in the browser's live URL.
 *
 * `replaceState` can throw or silently no-op in constrained browser contexts.
 * The caller supplies the credential-specific check so every secret in a
 * shared fragment is confirmed gone by the same history operation.
 */
export function clearUrlFragmentAndConfirm(
  containsSensitiveValue: (hash: string) => boolean,
): boolean {
  try {
    // ABSOLUTE, same-origin URL rather than a bare path: a pathname that
    // begins `//` (reachable through dot-segment normalisation) would otherwise
    // be read as a protocol-relative URL naming another host, and the
    // replaceState would throw instead of clearing the credential.
    const { origin, pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${origin}${pathname}${search}`);
    return !containsSensitiveValue(window.location.hash);
  } catch {
    return false;
  }
}
