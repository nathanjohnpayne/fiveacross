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
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${search}`);
    return !containsSensitiveValue(window.location.hash);
  } catch {
    return false;
  }
}
