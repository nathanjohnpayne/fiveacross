// Pure URL routing only: safe for the credential-capture entry graph. The
// query changes the document URL; a fragment would leave gameplay mounted.
const RECOVERY_PARAMETER = 'device-cache-recovery';

export function isPrivateCacheRecoveryDocument(href: string): boolean {
  return new URL(href).searchParams.get(RECOVERY_PARAMETER) === '1';
}

export function privateCacheRecoveryHref(href: string): string {
  const url = new URL(href);
  url.searchParams.set(RECOVERY_PARAMETER, '1');
  url.hash = '';
  return url.href;
}

export function applicationAfterRecoveryHref(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(RECOVERY_PARAMETER);
  url.hash = '';
  return url.href;
}
