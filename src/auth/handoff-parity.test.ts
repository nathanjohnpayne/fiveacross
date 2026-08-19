// Covers specs/auth-handoff-client.md § Wire parity — the client half of the
// handoff (#549) against the shipped server contract (#548).
//
// WHY THIS FILE EXISTS SEPARATELY. The client cannot import
// `functions/src/authHandoff.ts` at runtime: it is a different TypeScript
// program and it pulls in `node:crypto`, which has no place in a browser bundle.
// So the client MIRRORS three things — the fragment key, the token shape, and
// the transaction-id digest — and a mirror with no test is a latent outage. A
// drift in any of them would not fail loudly; it would fail as "this sign-in
// link is no longer valid" on every single handoff, which is exactly what a
// dozen benign causes also look like.
//
// Same idea as src/data/w4-bug-report-contract-parity.test.ts, which pins the
// bug-report intake contract across the same boundary.
import { describe, expect, it, vi } from 'vitest';

// `handoffClient` reaches `../firebase`, whose module scope calls `getAuth` and
// throws on the blank test-time API key. Stubbed to the repo's usual shape —
// nothing here exercises a callable, only the mirrored constant.
vi.mock('../firebase', () => ({ auth: {}, functions: {} }));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));
vi.mock('firebase/auth', () => ({ signInWithCustomToken: vi.fn() }));

import {
  HANDOFF_FRAGMENT_KEY as SERVER_FRAGMENT_KEY,
  HANDOFF_TOKEN_PATTERN as SERVER_TOKEN_PATTERN,
  transactionIdFor as serverTransactionIdFor,
} from '../../functions/src/authHandoff';
import { HANDOFF_FRAGMENT_KEY as CLIENT_FRAGMENT_KEY } from './handoffClient';
import {
  HANDOFF_TOKEN_PATTERN as CLIENT_TOKEN_PATTERN,
  createVerifier,
  transactionIdFor as clientTransactionIdFor,
} from './handoffTransaction';

describe('handoff client/server parity', () => {
  it('mirrors the fragment key the return URL carries the code on', () => {
    expect(CLIENT_FRAGMENT_KEY).toBe(SERVER_FRAGMENT_KEY);
  });

  it('mirrors the token shape', () => {
    expect(CLIENT_TOKEN_PATTERN.source).toBe(SERVER_TOKEN_PATTERN.source);
    expect(CLIENT_TOKEN_PATTERN.flags).toBe(SERVER_TOKEN_PATTERN.flags);
  });

  // The load-bearing one. The client computes the transaction id with WebCrypto
  // and the server with `node:crypto`; the two must agree byte for byte or the
  // transaction binding rejects every legitimate exchange.
  it('computes the same transaction id as the server, over fixed vectors', async () => {
    for (const verifier of [
      'a',
      '',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      '0123456789-_abcdefghijklmnopqrstuvwxyzABCDE',
    ]) {
      expect(await clientTransactionIdFor(verifier)).toBe(serverTransactionIdFor(verifier));
    }
  });

  it('agrees on freshly generated verifiers, which are the only ones that ship', async () => {
    for (let i = 0; i < 25; i += 1) {
      const verifier = createVerifier();
      expect(await clientTransactionIdFor(verifier)).toBe(serverTransactionIdFor(verifier));
    }
  });

  // Unpadded base64url, because that is what Node's `digest('base64url')`
  // produces. A `+`, `/` or `=` here means the encoder drifted, and the digest
  // would then disagree with the server for a subset of inputs only — the worst
  // kind of drift, because it would pass a single hand-picked test vector.
  it('produces an unpadded base64url digest of the right length', async () => {
    const id = await clientTransactionIdFor(createVerifier());
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toContain('=');
  });

  it('generates verifiers in the shape the server accepts', () => {
    for (let i = 0; i < 25; i += 1) {
      expect(SERVER_TOKEN_PATTERN.test(createVerifier())).toBe(true);
    }
  });

  it('generates a different verifier every time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createVerifier()));
    expect(seen.size).toBe(200);
  });
});
