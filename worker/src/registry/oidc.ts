export const GOOGLE_OIDC_ISSUER = 'https://accounts.google.com';
export const GOOGLE_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 300_000;
const DEFAULT_JWKS_TTL_MS = 300_000;
const MAX_JWKS_TTL_MS = 3_600_000;
const MAX_TOKEN_LIFETIME_SECONDS = 3_600;
const MAX_FUTURE_IAT_SECONDS = 60;

export type OidcClaims = {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
};

export type OidcPolicy = { audience: string; subject: string };

export interface JwksResolver {
  resolve(kid: string): Promise<CryptoKey | null>;
}

export class JwksUnavailableError extends Error {
  constructor() {
    super('Google OIDC JWKS unavailable');
    this.name = 'JwksUnavailableError';
  }
}

type JwksCacheDeps = {
  fetch: (url: string) => Promise<Response>;
  now: () => number;
};

type GoogleJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function importJwk(jwk: GoogleJwk): Promise<CryptoKey | null> {
  if (
    typeof jwk.kid !== 'string' ||
    jwk.kid.length === 0 ||
    jwk.kty !== 'RSA' ||
    jwk.alg !== 'RS256' ||
    jwk.use !== 'sig'
  ) {
    return null;
  }
  try {
    return await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    return null;
  }
}

export class GoogleJwksCache implements JwksResolver {
  private readonly keys = new Map<string, CryptoKey>();
  private refreshPromise: Promise<void> | null = null;
  private lastUnknownRefreshAt: number | null = null;
  private expiresAt = 0;
  private lastRefreshFailed = false;

  constructor(private readonly deps: JwksCacheDeps) {}

  private async refresh(): Promise<void> {
    try {
      const response = await this.deps.fetch(GOOGLE_OIDC_JWKS_URL);
      if (!response.ok) throw new JwksUnavailableError();
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new JwksUnavailableError();
      }
      if (!isRecord(body) || !Array.isArray(body.keys)) throw new JwksUnavailableError();
      const imported = await Promise.all(
        body.keys.slice(0, 16).map(async (candidate) => {
          if (!isRecord(candidate)) return null;
          const jwk = candidate as unknown as GoogleJwk;
          const key = await importJwk(jwk);
          return key === null || typeof jwk.kid !== 'string' ? null : ([jwk.kid, key] as const);
        }),
      );
      const next = new Map(imported.filter((entry): entry is readonly [string, CryptoKey] => entry !== null));
      if (next.size === 0) throw new JwksUnavailableError();
      const maxAge = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(response.headers.get('cache-control') ?? '')?.[1];
      const ttl = maxAge === undefined ? DEFAULT_JWKS_TTL_MS : Math.min(Number(maxAge) * 1_000, MAX_JWKS_TTL_MS);
      this.keys.clear();
      for (const [kid, key] of next) this.keys.set(kid, key);
      this.expiresAt = this.deps.now() + ttl;
      this.lastRefreshFailed = false;
    } catch {
      this.lastRefreshFailed = true;
      throw new JwksUnavailableError();
    }
  }

  async resolve(kid: string): Promise<CryptoKey | null> {
    const now = this.deps.now();
    const cached = this.keys.get(kid);
    if (cached !== undefined && now < this.expiresAt) return cached;
    if (
      cached === undefined &&
      this.lastUnknownRefreshAt !== null &&
      now - this.lastUnknownRefreshAt < UNKNOWN_KID_REFRESH_COOLDOWN_MS &&
      this.refreshPromise === null
    ) {
      if (this.lastRefreshFailed) throw new JwksUnavailableError();
      return null;
    }

    if (this.refreshPromise === null) {
      this.lastUnknownRefreshAt = now;
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
    return this.keys.get(kid) ?? null;
  }
}

function decodeBase64Url(segment: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('OIDC token rejected');
  const base64 = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('OIDC token rejected');
  }
}

function parseSegment(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
    if (!isRecord(value)) throw new Error();
    return value;
  } catch {
    throw new Error('OIDC token rejected');
  }
}

function reject(): never {
  throw new Error('OIDC token rejected');
}

export async function verifyGoogleOidc(
  token: string,
  policy: OidcPolicy,
  jwks: JwksResolver,
  nowMs: number,
): Promise<OidcClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) reject();
  const header = parseSegment(parts[0]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) reject();
  const payload = parseSegment(parts[1]);
  if (
    payload.iss !== GOOGLE_OIDC_ISSUER ||
    payload.aud !== policy.audience ||
    payload.sub !== policy.subject ||
    typeof payload.iat !== 'number' ||
    !Number.isInteger(payload.iat) ||
    typeof payload.exp !== 'number' ||
    !Number.isInteger(payload.exp)
  ) {
    reject();
  }
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    payload.exp <= nowSeconds ||
    payload.iat > nowSeconds + MAX_FUTURE_IAT_SECONDS ||
    payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS ||
    payload.iat < nowSeconds - MAX_TOKEN_LIFETIME_SECONDS
  ) {
    reject();
  }

  const key = await jwks.resolve(header.kid);
  if (key === null) reject();
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) reject();
  return payload as OidcClaims;
}
