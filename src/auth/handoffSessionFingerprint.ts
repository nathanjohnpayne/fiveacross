const FINGERPRINT_DOMAIN = 'fiveacross:auth-handoff-session:v1';

function lengthPrefixed(value: string): string {
  return `${new TextEncoder().encode(value).byteLength}:${value}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * One-attempt proof that two realms observed the same Firebase credential.
 *
 * A refresh token is a bearer secret. The Worker and page can each read it from
 * their own in-memory User, but the protocol carries only this domain-separated
 * digest. Length prefixes make the encoding unambiguous, and the owner nonce
 * prevents a fingerprint from being meaningful outside the attempt that made
 * it.
 */
export async function fingerprintHandoffSession(input: {
  ownerNonce: string;
  uid: string;
  refreshToken: string;
}): Promise<string> {
  const material = [
    FINGERPRINT_DOMAIN,
    lengthPrefixed(input.ownerNonce),
    lengthPrefixed(input.uid),
    lengthPrefixed(input.refreshToken),
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return base64url(new Uint8Array(digest));
}
